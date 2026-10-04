// components/chat/BubbleParts.tsx — the parts of a bubble that are not media:
// the text body (with its "Read as page" chip and link card), the in-chat poll,
// a shared location card, and the time/tick line. Moved out of
// components/chat/MessageBubble.tsx.

import { useCallback, useMemo, useState, type MutableRefObject } from 'react';
import { Alert, Text, TouchableOpacity, View } from 'react-native';
import LinkPreview, { extractUrl } from '../../components/LinkPreview';
import { IMPORT_SOURCE } from '../../constants/importSources';
import { useVisionComfort } from '../../lib/visionComfort';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { BRAND_ACCENT, brandAlpha } from '../../constants/theme';
import { useTheme } from '../../lib/theme';
import { couldBeLongRead, readStats } from '../../lib/reader';
import { navigateTo } from '../../lib/nav/openNavigation';
import { looksEncrypted, unvotePoll, voteOnPoll, type PollVoteSummary } from '../../lib/chatService';
import { useS, type DisplayMessage } from './chatStyles';
import { bumpPollVote, formatTtlRemaining, type TickState } from './chatFormat';
import { obscureForInk, renderRichText, type BubbleInk } from './bubbleText';
import { fillInks } from './bubbleFillInk';

// ─── Poll bubble (in-chat voting) ────────────────────────────
// Renders the question + the options as horizontal rows with a fill bar
// per option (proportional to votes/total). Tapping an option toggles
// the caller's vote; single-vote polls auto-switch the active option.
// The PollBubble is "dumb" — it reads `votes` from props and calls
// `onChange` with the optimistic next state. The chat screen owns the
// authoritative store + socket reconciliation.
export function PollBubble({
  chatId, msg, isMine, votes, onChange, voteRef,
}: {
  chatId:   string;
  msg:      DisplayMessage;
  isMine:   boolean;
  votes?:   PollVoteSummary;
  onChange?: (next: PollVoteSummary) => void;
  /** The bubble's "Vote for …" accessibility actions call this (options are nested in it). */
  voteRef?: MutableRefObject<((idx: number) => void) | null>;
}) {
  const S = useS();
  const options: string[]    = Array.isArray(msg.meta?.options) ? msg.meta.options : [];
  const allowMultiple = !!msg.meta?.allowMultiple;
  // Memoised on `votes`: a fresh `{}` / `[]` each render would change the
  // toggle callback's deps every render (react-hooks/exhaustive-deps).
  const counts = useMemo(() => votes?.counts ?? {}, [votes]);
  const mine   = useMemo(() => votes?.mine ?? [], [votes]);
  const total  = votes?.total ?? 0;

  const [pending, setPending] = useState<number | null>(null);

  const toggle = useCallback(async (idx: number) => {
    if (pending != null) return;
    const wasMine = mine.includes(idx);

    // Optimistic patch — pivots immediately, server reconciles via
    // 'poll_voted' / 'poll_unvoted' events on the socket.
    let next: PollVoteSummary = { counts: { ...counts }, mine: [...mine], total };
    if (wasMine) {
      next = bumpPollVote({ [msg.id]: next }, msg.id, idx, -1, true)[msg.id];
    } else {
      // Single-vote polls: remove existing mine vote(s) first.
      if (!allowMultiple) {
        for (const otherIdx of mine) {
          next = bumpPollVote({ [msg.id]: next }, msg.id, otherIdx, -1, true)[msg.id];
        }
      }
      next = bumpPollVote({ [msg.id]: next }, msg.id, idx, +1, true)[msg.id];
    }
    onChange?.(next);

    setPending(idx);
    try {
      if (wasMine) {
        await unvotePoll(chatId, msg.id, idx);
      } else {
        await voteOnPoll(chatId, msg.id, idx);
      }
    } catch (e: any) {
      // Rollback — server reject means our optimistic state is wrong.
      Alert.alert('Vote failed', e?.message ?? 'Try again');
      onChange?.({ counts, mine, total });
    } finally {
      setPending(null);
    }
  }, [pending, mine, counts, total, allowMultiple, chatId, msg.id, onChange]);
  if (voteRef) voteRef.current = toggle;

  return (
    <View style={S.pollWrap}>
      <Text style={[S.pollQuestion, isMine && S.pollQuestionMine]} numberOfLines={3}>
        {msg.content}
      </Text>
      {options.map((label, idx) => {
        const c       = counts[String(idx)] || 0;
        const pct     = total > 0 ? c / total : 0;
        const checked = mine.includes(idx);
        return (
          <TouchableOpacity
            key={idx}
            style={S.pollOptionRow}
            onPress={() => toggle(idx)}
            activeOpacity={0.7}
            disabled={pending != null}
            accessibilityRole={allowMultiple ? 'checkbox' : 'radio'}
            accessibilityLabel={`${label}, ${c} ${c === 1 ? 'vote' : 'votes'}`}
            accessibilityState={{ checked, disabled: pending != null, busy: pending === idx }}
          >
            <Text style={[S.pollOptionMark, checked && S.pollOptionMarkOn]}>
              {checked ? (allowMultiple ? '☑' : '◉') : (allowMultiple ? '☐' : '○')}
            </Text>
            <View style={{ flex: 1 }}>
              <View style={S.pollOptionLine}>
                <Text style={[S.pollOptionLabel, isMine && S.pollOptionLabelMine]} numberOfLines={2}>
                  {label}
                </Text>
                <Text style={[S.pollOptionCount, isMine && S.pollOptionCountMine]}>
                  {c}
                </Text>
              </View>
              <View style={S.pollBarTrack}>
                <View
                  style={[
                    S.pollBarFill,
                    isMine && S.pollBarFillMine,
                    { width: `${Math.round(pct * 100)}%` },
                  ]}
                />
              </View>
            </View>
          </TouchableOpacity>
        );
      })}
      <Text style={[S.pollFooter, isMine && S.pollFooterMine]}>
        {total} {total === 1 ? 'vote' : 'votes'} · {allowMultiple ? 'multiple answers' : 'single answer'}
      </Text>
    </View>
  );
}

/**
 * "This message is easier as a page" — the Reader hand-off
 * (docs/design/mobile/m18-reader-detect).
 *
 * Renders NOTHING for an ordinary message: a bubble is the right shape for
 * almost everything, and an affordance under every message would be noise. It
 * appears only past lib/reader's word threshold, where a bubble genuinely stops
 * working. The Reader is handed the chat + message id and reads the decrypted
 * body from the local caches, so plaintext never rides in route params. Only an
 * unsent message (`cached` false: no server id yet) falls back to the text.
 */
export function ReaderAffordance({ text, title, author, at, chatId, msgId, cached }: {
  text: string; title: string; author: string; at?: string;
  chatId: string; msgId: number; cached: boolean;
}) {
  const S = useS();
  const router = useRouter();
  const stats = useMemo(() => longReadStats(text), [text]);
  if (!stats) return null;
  return (
    <TouchableOpacity
      style={S.readerChip}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={`Read as page, ${stats.minutes} minute read`}
      onPress={() => openReader(router, { text, title, author, at, chatId, msgId, cached })}
    >
      <Ionicons name="book-outline" size={14} color={BRAND_ACCENT} />
      <Text style={S.readerChipTxt}>Read as page · {stats.minutes} min</Text>
    </TouchableOpacity>
  );
}

/** Reading stats when `text` is a long read, else null. */
export function longReadStats(text: string) {
  // Length guard first: rules out almost every message without running the
  // word count, which is asked of EVERY text bubble on screen.
  const stats = couldBeLongRead(text) ? readStats(text) : null;
  return stats?.longRead ? stats : null;
}

/** Open the Reader on a message (the chip, and the bubble's a11y action). */
export function openReader(router: ReturnType<typeof useRouter>, p: {
  text: string; title: string; author: string; at?: string; chatId: string; msgId: number; cached: boolean;
}) {
  router.push({
    pathname: '/reader',
    params: p.cached
      ? { chatId: p.chatId, id: String(p.msgId), title: p.title, author: p.author, at: p.at ?? '' }
      : { text: p.text, title: p.title, author: p.author, at: p.at ?? '' },
  });
}

/** A shared location as a card. `plain` is the decrypted JSON {lat,lng,address,live?}. */
export function parseLocation(plain: string): { lat: number; lng: number; address?: string; live?: boolean } | null {
  let L: any = null; try { L = JSON.parse(plain || '{}'); } catch {}
  return L && typeof L.lat === 'number' && typeof L.lng === 'number' ? L : null;
}

export function LocationBubble({ plain, isMine }: { plain: string; isMine: boolean }) {
  const S = useS();
  const { colors } = useTheme();
  // A 'location' message's (decrypted) content is JSON {lat,lng,address}.
  let L: any = null; try { L = JSON.parse(plain || '{}'); } catch {}
  const ok = L && typeof L.lat === 'number' && typeof L.lng === 'number';
  return (
    <TouchableOpacity
      disabled={!ok}
      activeOpacity={0.85}
      onPress={() => { if (ok) navigateTo(L.lat, L.lng, L.address || 'Shared location'); }}
      accessibilityRole="button"
      accessibilityLabel={`${L?.live ? 'Live location' : 'Location'}${ok && L.address ? `, ${L.address}` : ''}${ok ? '. Open in Maps' : ''}`}
      accessibilityState={{ disabled: !ok }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 190 }}>
        <View style={{ width: 40, height: 40, borderRadius: 8, backgroundColor: brandAlpha(0.18), alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name={L?.live ? 'navigate' : 'location'} size={22} color={isMine ? colors.bubbleOutText : colors.accentOn} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[S.bubbleTxt, isMine && S.bubbleTxtMine, { fontWeight: '700' }]}>
            {L?.live ? 'Live location' : 'Location'}
          </Text>
          {ok && !!L.address && (
            <Text style={[S.bubbleTxt, isMine && S.bubbleTxtMine, { fontSize: 12, opacity: 0.85 }]} numberOfLines={2}>
              {L.address}
            </Text>
          )}
          {ok && <Text style={{ color: isMine ? colors.bubbleOutText : colors.accentOn, fontSize: 12, fontWeight: '700', marginTop: 2 }}>Open in Maps ›</Text>}
        </View>
      </View>
    </TouchableOpacity>
  );
}

/**
 * The text body of a bubble: the message (or ●●● Invisible Ink), its "Read as
 * page" chip and link card — or why there is no readable text.
 */
export function TextBody({ msg, plain, isMine, inkHidden, txtColor, highlight, ink, readerArgs }: {
  msg: DisplayMessage; plain: string; isMine: boolean; inkHidden: boolean; txtColor: string | null;
  highlight: string | null | undefined; ink: BubbleInk; readerArgs: Parameters<typeof ReaderAffordance>[0];
}) {
  const S = useS();
  return (
    plain ? (
      // Invisible Ink: recipient sees ●●●● until they tilt the
      // phone past 45°. Sender (isMine) always sees plaintext —
      // they obviously know what they sent.
      inkHidden ? (
        <Text style={[S.bubbleTxt, isMine && S.bubbleTxtMine, S.invisibleInk]}>
          {obscureForInk(plain)}
        </Text>
      ) : (
        <>
          <Text style={[S.bubbleTxt, isMine && S.bubbleTxtMine, txtColor ? { color: txtColor } : null]}>
            {renderRichText(plain, highlight, ink)}
          </Text>
          <ReaderAffordance {...readerArgs} />
          {(() => {
            // F5: prefer the sender-embedded E2EE preview (no fetch at
            // all); legacy messages without one fall back to the old
            // server-proxied lookup so old chats keep their cards.
            const lp = msg.meta?.linkPreview;
            if (lp?.t) return <LinkPreview url={lp.u} data={lp} />;
            const u = extractUrl(plain);
            return u ? <LinkPreview url={u} /> : null;
          })()}
        </>
      )
    ) : looksEncrypted(msg.content) ? (
      // Envelope that never decrypted (desynced ratchet / E2EE off): show the
      // standard lock indicator instead of a blank bubble or raw ciphertext.
      <Text style={[S.bubbleTxt, isMine && S.bubbleTxtMine, { fontStyle: 'italic', opacity: 0.7 }]}>
        🔒 unable to decrypt
      </Text>
    ) : msg.content == null && (msg.type === 'text' || msg.type === 'poll') ? (
      // The message EXISTS and THIS DEVICE HOLDS NO READABLE COPY OF IT.
      // That is the entire claim. It is deliberately not a claim about the
      // server, because the client cannot make one.
      //
      // This said "Message no longer available", which asserts the server
      // reclaimed the body. It shipped that way because the null was read
      // as coming from one place — the ephemeral body store returning a
      // spine row with its body gone. A null reaches here from several:
      //
      //   • the sender's OWN message. A Double Ratchet ciphertext cannot be
      //     opened by the party that produced it, so hydrateMessages leaves
      //     the envelope (chatService.ts) and cacheMessages then stores NULL
      //     for it (localDb.ts) whenever the own-plaintext cache misses.
      //   • a peer message this device never managed to decrypt.
      //   • a body the retention sweep genuinely reclaimed.
      //
      // Only the third is "no longer available", and it is the one that has
      // never happened in production: MESSAGE_BODIES is unset there, so the
      // body store has never been written to. The first is what users were
      // actually shown — a bubble telling them the server had dropped a
      // message the server still held in full. Verified against production
      // for the reported chats: every one of those messages was intact on
      // the spine, a few hundred bytes of `dr1` each, with no body row and
      // no retention job ever having run against it.
      //
      // So the wording states only what is locally true, which is also true
      // in the retention case. A bubble must never report a server-side fact
      // it inferred from a local absence.
      //
      // Scoped to text/poll on purpose. A media message legitimately has a
      // null body when it carries no caption; its bubble is the attachment,
      // which renders above this and must not be labelled unavailable.
      <Text style={[S.bubbleTxt, isMine && S.bubbleTxtMine, { fontStyle: 'italic', opacity: 0.7 }]}>
        ⧗ Message not available on this device
      </Text>
    ) : null
  );
}

/**
 * The time · origin · edited · progress · timer · tick line. It sits ON your
 * filled bubble, or on the chat ground for media (transparent bubble) and
 * received messages; the read tick must stand out from the line on both:
 * tickRead on the fill, the accent off it. A custom bubble colour (`fill`)
 * gets inks chosen against that colour (./bubbleFillInk), not the theme's.
 */
export function BubbleMetaLine({ msg, tickState, isMine, isMedia, fill }: {
  msg: DisplayMessage; tickState: TickState; isMine: boolean; isMedia: boolean;
  /** Your bubble's custom colour (lib/chatBubbleTheme), if any. */
  fill?: string | null;
}) {
  const S = useS();
  const { colors } = useTheme();
  const { profile: visionProfile } = useVisionComfort();
  const metaOnFill = isMine && !isMedia;
  const custom = metaOnFill && fill ? fillInks(fill, visionProfile.highContrast) : null;
  const metaInk = custom ? custom.meta
    : metaOnFill ? null : (visionProfile.highContrast ? colors.bubbleInText : colors.bubbleMetaIn);
  const fillInk = visionProfile.highContrast ? colors.bubbleOutText : colors.bubbleMetaOut;   // = S.bubbleMeta
  const readInk = custom ? custom.tickRead : metaOnFill ? colors.tickRead : colors.accentOn;
  return (
    <Text style={[S.bubbleMeta, metaInk ? { color: metaInk } : null, isMedia && { paddingHorizontal: 4 }]}>
      {/* createdAt IS the original timestamp for an imported message — it is
          never the import time — so this line needs no special case to show
          the right hour. */}
      {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      {/* Where this message came from, as the messenger's own mark. A word
          ("· WhatsApp") costs a third of the bubble's width on every single
          imported row and stops being readable at all once three sources
          exist; the logo is recognised without being read, and each source
          keeps its own colour so they never look alike. */}
      {(() => {
        const src = IMPORT_SOURCE[msg.meta?.origin];
        return src ? (
          <Text> · <Ionicons name={src.icon} size={11} color={src.tint} /></Text>
        ) : null;
      })()}
      {msg.editedAt ? ' · edited' : ''}
      {msg._state === 'failed'  ? ' · failed (tap to retry)' : ''}
      {/* Sender-side send progress. Text (not just the ring) so a document
          or voice bubble — where an overlay ring would be cramped — still
          says what is happening. Absent _progress = no sample yet, which
          keeps the original bare pending clock. */}
      {msg._state === 'pending' && msg._progress != null
        ? (msg._phase === 'preparing'
            ? ' · Preparing…'
            : ` · Uploading ${Math.round(msg._progress * 100)}%`)
        : ''}
      {msg.expiresAt && (
        <Text style={S.ttlBadge}> · ⏱️ {formatTtlRemaining(msg.expiresAt)}</Text>
      )}
      {msg.vanishAfterRead && (
        <Text style={S.vanishBadge}> · 💨 vanish</Text>
      )}
      {tickState && (
        <Ionicons
          name={tickState === 'pending' ? 'time-outline' : tickState === 'sent' ? 'checkmark' : 'checkmark-done'}
          size={14}
          color={tickState === 'read' ? readInk : (metaInk ?? fillInk)}
          accessibilityLabel={tickState === 'pending' ? 'Sending message' : `Message ${tickState}`}
          testID={`message-status-${msg.id}`}
          style={{ marginLeft: 3 }}
        />
      )}
    </Text>
  );
}
