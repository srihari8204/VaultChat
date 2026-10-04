// components/live/useLiveFeed.ts — live chat, the viewer heartbeat and polls.
//
// Moved out of app/live-view.tsx unchanged, plus endPoll (which used to fire
// closePoll and mark the poll closed whatever the server said). Runs only while
// the stage is up; notices when the broadcast ends and lets go of the room.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import {
  getBroadcast, watchBroadcast, unwatchBroadcast, listBroadcastChat, sendBroadcastChat,
  listPolls, votePoll, closePoll, createPoll,
  type Broadcast, type BroadcastMessage, type BroadcastPoll,
} from '../../lib/broadcast';

export function useLiveFeed({
  id, waiting, failed, setB, setEnded, releaseOwnedMedia,
}: {
  id: string | undefined;
  waiting: boolean;
  failed: boolean;
  setB: (b: Broadcast) => void;
  setEnded: (v: boolean) => void;
  releaseOwnedMedia: () => Promise<void>;
}) {
  // ── polls ───────────────────────────────────────────────────────────
  //
  // Answered by the UNBOUNDED audience, not just the 20 on stage, so the vote
  // path has to be as cheap as the chat poll it rides alongside. Refreshed on
  // the same timer as chat rather than a second one: two intervals on an
  // unbounded audience is twice the request rate for no extra freshness.
  const [polls, setPolls] = useState<BroadcastPoll[]>([]);
  const [voting, setVoting] = useState<number | null>(null);
  const [pollDraft, setPollDraft] = useState<{ q: string; opts: string[] } | null>(null);

  // ── live chat + viewer heartbeat ──────────────────────────────────────
  //
  // Polling, not sockets. A broadcast audience is unbounded, and a socket per
  // viewer is exactly the fan-out the CDN exists to avoid — the whole point of
  // serving video from the edge is undone if every viewer still holds a live
  // connection to the API. A 3s poll is well inside what feels live for chat.
  const [messages, setMessages] = useState<BroadcastMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [viewers, setViewers] = useState(0);
  const lastId = useRef(0);

  useEffect(() => {
    if (waiting || failed) return;
    let alive = true;
    let n = 0;
    const tick = async () => {
      if (!alive) return;
      // The heartbeat is what keeps us in the viewer set; it expires server-side
      // so a viewer who vanishes stops being counted.
      setViewers(await watchBroadcast(String(id)));

      // NOTICE WHEN THE STREAM ENDS.
      //
      // The broadcast was fetched once, at mount, and never again — so a viewer
      // whose host had ended the stream sat watching a dead playlist under a
      // banner that still read LIVE, indefinitely. There was no path to the
      // ended state at all: `b.status` was frozen at whatever it was when the
      // screen opened.
      //
      // Every 4th tick (~12s) rather than every tick: this is a read on the hot
      // path for an unbounded audience, and 12s is well inside what "the stream
      // stopped" needs to feel correct. The chat poll stays at 3s because that
      // one is the interactive part.
      if (++n % 4 === 0) {
        try {
          const cur = await getBroadcast(String(id));
          if (!alive) return;
          setB(cur);
          if (cur.status === 'ended' || cur.status === 'failed') {
            // Stop polling immediately — the room is gone, and continuing to
            // heartbeat into it just keeps the viewer counted on a finished
            // stream.
            alive = false;
            setEnded(true);
            // AND LET GO OF THE ROOM. Stopping the poll used to be all this
            // did, which left the SFU session connected to a broadcast the
            // server had already finished. livekit-client does not know the
            // broadcast ended — it only knows its transport dropped — so it
            // kept retrying under its own policy, indefinitely, holding the
            // microphone and camera senders and waking the radio.
            //
            // Measured on device: a room from an ended broadcast was still
            // logging `reconnecting -> connected` six minutes later, alongside
            // the room of the NEXT broadcast. That is the same two-rooms-one-
            // camera collision endBroadcast() above already guards against —
            // this is the one path into the terminal state that never did.
            await releaseOwnedMedia();
            return;
          }
        } catch { /* transient — the next tick tries again */ }
      }

      // Polls ride the SAME tick as the "did it end" check (~12s) rather than
      // the 3s chat beat. A poll appears or closes rarely; chat is the
      // interactive part. On an unbounded audience that difference is a 4x cut
      // in request volume for no loss of freshness.
      if (n % 4 === 0) {
        const fp = await listPolls(String(id));
        if (!alive) return;
        setPolls(fp);
      }

      const fresh = await listBroadcastChat(String(id), lastId.current);
      if (!alive || fresh.length === 0) return;
      lastId.current = fresh[fresh.length - 1].id;
      // Bounded: a long stream would otherwise grow this list without limit and
      // eventually stutter the player it sits on top of.
      setMessages(prev => [...prev, ...fresh].slice(-200));
    };
    void tick();
    const timer = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(timer); void unwatchBroadcast(String(id)); };
    // setB / setEnded are state setters and releaseOwnedMedia is a stable
    // callback, so listing them never re-runs this.
  }, [id, waiting, failed, setB, setEnded, releaseOwnedMedia]);

  const [sendFailed, setSendFailed] = useState(false);
  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    setSendFailed(false);
    const sent = await sendBroadcastChat(String(id), text);
    if (sent) {
      lastId.current = Math.max(lastId.current, sent.id);
      setMessages(prev => [...prev, sent].slice(-200));
    } else {
      // Put the message back rather than lose it — unless something new has
      // already been typed, which must not be overwritten.
      setDraft(cur => (cur === '' ? text : cur));
      setSendFailed(true);
    }
  }, [draft, id]);

  /**
   * Answer a poll.
   *
   * A vote is FINAL server-side (409 on a second attempt), so the UI must not
   * offer a way to change it — and must not optimistically paint a result that
   * the server may refuse. It re-reads instead, which also picks up everyone
   * else's votes in the same round trip.
   */
  const vote = useCallback(async (pollId: number, option: number) => {
    if (voting !== null) return;
    setVoting(pollId);
    try {
      const res = await votePoll(String(id), pollId, option);
      if (res) {
        setPolls(prev => prev.map(p => p.id === pollId
          ? { ...p, counts: res.counts, total: res.total, myVote: res.myVote } : p));
      } else {
        // Refused — already voted, closed, or not permitted. The server is the
        // authority on which; re-reading shows the truth without guessing.
        setPolls(await listPolls(String(id)));
      }
    } finally {
      setVoting(null);
    }
  }, [id, voting]);

  const submitPoll = useCallback(async () => {
    const d = pollDraft;
    if (!d) return;
    const opts = d.opts.map(o => o.trim()).filter(Boolean);
    if (!d.q.trim() || opts.length < 2) {
      Alert.alert('Poll', 'Add a question and at least two options.');
      return;
    }
    const created = await createPoll(String(id), d.q, opts);
    // The draft stays open on failure so the host can retry without retyping.
    if (created) { setPollDraft(null); setPolls(prev => [created, ...prev]); }
    else Alert.alert('Poll', 'Could not start the poll. Your draft is still here.');
  }, [id, pollDraft]);

  /**
   * End a poll for every viewer (the caller confirms first). Shown closed at
   * once, and put back if the server did not take it — a poll the host
   * believes is closed while viewers keep voting is the worse outcome.
   */
  const endPoll = useCallback(async (pollId: number) => {
    setPolls(prev => prev.map(x => x.id === pollId ? { ...x, closed: true } : x));
    if (await closePoll(String(id), pollId)) return;
    setPolls(prev => prev.map(x => x.id === pollId ? { ...x, closed: false } : x));
    Alert.alert('Poll', 'Could not end the poll. It is still open. Check your connection and try again.');
  }, [id]);

  return {
    messages, draft, setDraft, viewers, send, sendFailed,
    polls, voting, vote, pollDraft, setPollDraft, submitPoll, endPoll,
  };
}
