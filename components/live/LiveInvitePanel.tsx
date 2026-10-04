// components/live/LiveInvitePanel.tsx — the host's Private Live invitation panel.
//
// Moved out of app/live-view.tsx.
//
// PRIVATE INVITATION — the link IS the access mechanism. Shows the URL, and
// nothing else: no room name, no key, no infrastructure detail. Copy and Share
// both hand over the same opaque code, which grants VIEWING only — a seat on the
// stage still needs the host to promote you.

import React from 'react';
import { View, TouchableOpacity, Alert, Share } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { AppText } from '../ui/Text';
import { LIVE, S } from './liveStyles';

/** Copy, and say whether it worked: a failed write must not read as "Copied". */
async function copyAndSay(text: string, done: string) {
  try {
    await Clipboard.setStringAsync(text);
    Alert.alert('Copied', done);
  } catch {
    Alert.alert('Could not copy', 'Select the text above and copy it by hand.');
  }
}

export function LiveInvitePanel({ inviteUrl, pc, inviteBusy, onClose, makeInvite }: {
  inviteUrl: string;
  /** The host's passcode, from memory (hostPasscodeMemo); empty when none was set. */
  pc: string;
  inviteBusy: boolean;
  onClose: () => void;
  makeInvite: () => void;
}) {
  return (
    <View style={S.inviteSheet}>
      <View style={S.inviteHead}>
        <Ionicons name="lock-closed" size={14} color={LIVE.highlight} />
        <AppText style={S.inviteTitle}>Private live — invite people</AppText>
        <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Close the invite panel" hitSlop={8}>
          <Ionicons name="close" size={18} color={LIVE.textDim} />
        </TouchableOpacity>
      </View>
      <AppText style={S.inviteHint}>
        {pc
          ? 'Viewers need this link AND the passcode. Send them separately — that is what makes a forwarded link useless on its own.'
          : 'Anyone with this link can watch. Send it however you like.'}
      </AppText>
      <AppText style={S.inviteUrl} numberOfLines={2} selectable>{inviteUrl}</AppText>

      {/* The passcode, if this broadcast has one.

          Shown from this device's memory of what the host typed
          (lib/golive/hostPasscodeMemo.ts), not from the server: only a
          bcrypt hash is stored, so there is nothing to fetch back.
          Its own Copy button because it must travel on a DIFFERENT
          channel from the link — pasting both into one message
          defeats the entire point. */}
      {!!pc && (
        <View style={S.pcRow}>
          <View style={S.grow}>
            <AppText style={S.pcLabel}>Passcode</AppText>
            <AppText style={S.pcValue} selectable>{pc}</AppText>
          </View>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Copy the passcode"
            style={S.inviteBtn}
            onPress={() => { void copyAndSay(pc, 'Passcode copied. Send it separately from the link.'); }}
          >
            <Ionicons name="copy-outline" size={15} color={LIVE.text} />
            <AppText style={S.inviteBtnText}>Copy</AppText>
          </TouchableOpacity>
        </View>
      )}
      <View style={S.inviteRow}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Copy the invite link"
          style={S.inviteBtn}
          onPress={() => { void copyAndSay(inviteUrl, 'Invite link copied.'); }}
        >
          <Ionicons name="copy-outline" size={15} color={LIVE.text} />
          <AppText style={S.inviteBtnText}>Copy</AppText>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Share the invite link"
          style={S.inviteBtn}
          onPress={() => { Share.share({ message: 'Join my private live on crazzychat\n' + inviteUrl }).catch(() => {}); }}
        >
          <Ionicons name="share-social-outline" size={15} color={LIVE.text} />
          <AppText style={S.inviteBtnText}>Share</AppText>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Make a new invite link" accessibilityState={{ disabled: inviteBusy, busy: inviteBusy }} style={S.inviteBtn} onPress={makeInvite} disabled={inviteBusy}>
          <Ionicons name="refresh-outline" size={15} color={LIVE.text} />
          <AppText style={S.inviteBtnText}>New link</AppText>
        </TouchableOpacity>
      </View>
    </View>
  );
}
