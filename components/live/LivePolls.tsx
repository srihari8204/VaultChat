// components/live/LivePolls.tsx — the open poll card and the host's poll composer.
//
// Moved out of app/live-view.tsx. Unchanged except that "End poll" now goes
// through useLiveFeed's endPoll, which puts the poll back if the server did not
// close it.

import React from 'react';
import { View, TouchableOpacity, TextInput, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppText } from '../ui/Text';
import type { BroadcastPoll } from '../../lib/broadcast';
import { LIVE, S } from './liveStyles';

export function LivePollCard({ pl, isOwner, voting, vote, endPoll }: {
  pl: BroadcastPoll;
  isOwner: boolean;
  voting: number | null;
  vote: (pollId: number, option: number) => void;
  endPoll: (pollId: number) => void;
}) {
  const answered = pl.myVote >= 0;
  return (
    <View style={S.poll}>
      <View style={S.pollHead}>
        <Ionicons name="stats-chart" size={13} color={LIVE.highlight} />
        <AppText style={S.pollQ} numberOfLines={2}>{pl.question}</AppText>
        {isOwner && (
          <TouchableOpacity
            accessibilityRole="button" accessibilityLabel="End this poll" hitSlop={10}
            // Ending is final for every viewer: confirm it.
            onPress={() => Alert.alert('End this poll?', 'Viewers can no longer vote.', [
              { text: 'Keep it open', style: 'cancel' },
              { text: 'End poll', style: 'destructive', onPress: () => endPoll(pl.id) },
            ])}
          >
            <AppText style={S.pollClose}>End</AppText>
          </TouchableOpacity>
        )}
      </View>
      {pl.options.map((opt, i) => {
        // Percentages only AFTER voting. Showing the running
        // tally to someone who has not answered biases the
        // answer, and on an unbounded audience that is not a
        // rounding error.
        const pct = pl.total > 0 ? Math.round((pl.counts[i] ?? 0) * 100 / pl.total) : 0;
        const mine = pl.myVote === i;
        return (
          <TouchableOpacity
            key={i}
            disabled={answered || voting !== null}
            onPress={() => vote(pl.id, i)}
            style={S.pollOpt}
            activeOpacity={0.85}
            accessibilityRole="radio"
            accessibilityLabel={answered ? `${opt}, ${pct} percent` : `Vote for ${opt}`}
            accessibilityState={{ checked: mine, disabled: answered || voting !== null, busy: voting === pl.id }}
          >
            {answered && <View style={[S.pollBar, { width: `${pct}%` }, mine && S.pollBarMine]} />}
            <AppText style={[S.pollOptText, mine && S.pollOptMine]} numberOfLines={1}>
              {mine ? '✓ ' : ''}{opt}
            </AppText>
            {answered && <AppText style={S.pollPct}>{pct}%</AppText>}
          </TouchableOpacity>
        );
      })}
      <AppText style={S.pollTotal}>
        {answered ? `${pl.total} ${pl.total === 1 ? 'vote' : 'votes'}` : 'Tap to vote'}
      </AppText>
    </View>
  );
}

export type PollDraft = { q: string; opts: string[] };

/** Host: compose a poll. The draft stays open on a failed start (useLiveFeed.submitPoll). */
export function LivePollComposer({ pollDraft, setPollDraft, submitPoll }: {
  pollDraft: PollDraft;
  setPollDraft: React.Dispatch<React.SetStateAction<PollDraft | null>>;
  submitPoll: () => void;
}) {
  return (
    <View style={S.pollCompose}>
      <TextInput
        value={pollDraft.q}
        onChangeText={t => setPollDraft(d => d && { ...d, q: t })}
        placeholder="Ask your viewers something…"
        accessibilityLabel="Poll question"
        placeholderTextColor={LIVE.textDim}
        style={S.pollInput}
        maxLength={200}
        autoFocus
      />
      {pollDraft.opts.map((o, i) => (
        <TextInput
          key={i}
          value={o}
          onChangeText={t => setPollDraft(d => d && { ...d, opts: d.opts.map((x, j) => j === i ? t : x) })}
          placeholder={`Option ${i + 1}`}
          accessibilityLabel={`Poll option ${i + 1}`}
          placeholderTextColor={LIVE.placeholder}
          style={S.pollInput}
          maxLength={100}
        />
      ))}
      <View style={S.pollBtnRow}>
        {pollDraft.opts.length < 10 && (
          <TouchableOpacity onPress={() => setPollDraft(d => d && { ...d, opts: [...d.opts, ''] })} accessibilityRole="button" accessibilityLabel="Add an option" hitSlop={10}>
            <AppText style={S.pollAdd}>+ Option</AppText>
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={() => setPollDraft(null)} accessibilityRole="button" accessibilityLabel="Cancel the poll" hitSlop={10} style={S.pollCancelBtn}>
          <AppText style={S.pollCancel}>Cancel</AppText>
        </TouchableOpacity>
        <TouchableOpacity onPress={submitPoll} accessibilityRole="button" hitSlop={10}>
          <AppText style={S.pollGo}>Start poll</AppText>
        </TouchableOpacity>
      </View>
    </View>
  );
}
