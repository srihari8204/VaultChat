// components/chat/ChatBanners.tsx — the strips between the chat header and
// the message list: load error, a transient notice, security-code change, inbound screenshot,
// Memory Bubble, live location and the pinned message. Moved out of
// app/chat.tsx unchanged. State that only a banner reads (the key-change check,
// dismissed memories) lives with its banner; everything else is a prop.

import { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Alert, Platform, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useTheme } from '../../lib/theme';
import { navigateTo } from '../../lib/nav/openNavigation';
import { looksEncrypted, type ChatMember } from '../../lib/chatService';
import { useS, type DisplayMessage } from './chatStyles';
import { isProtectedMessage } from './protectedText';

type Members = Map<string, ChatMember>;

export function ErrorBar({ error, onRetry }: { error: string; onRetry: () => void }) {
  const S = useS();
  return (
    <View style={S.errorBar} accessibilityLiveRegion="polite">
      <Text style={[S.errorTxt, { flex: 1 }]}>{error}</Text>
      <TouchableOpacity
        onPress={onRetry}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Retry loading this chat"
      >
        <Text style={[S.errorTxt, { fontWeight: '700' }]}>Retry</Text>
      </TouchableOpacity>
    </View>
  );
}

/** A short status line that clears itself (e.g. "Forwarding to Sam"). Polite
 *  live region on Android, an explicit announcement on iOS (which has no live
 *  regions). `onDismiss` must be stable, or the 4 s timer restarts on render. */
export function NoticeBar({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  const S = useS();
  const { colors } = useTheme();
  useEffect(() => {
    if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(text);
    const t = setTimeout(onDismiss, 4000);
    return () => clearTimeout(t);
  }, [text, onDismiss]);
  return (
    <View style={S.noticeBar} accessibilityLiveRegion="polite">
      <Text style={[S.noticeTxt, { flex: 1 }]}>{text}</Text>
      <TouchableOpacity onPress={onDismiss} hitSlop={12} accessibilityRole="button" accessibilityLabel="Dismiss">
        <Ionicons name="close" size={16} color={colors.textDim} />
      </TouchableOpacity>
    </View>
  );
}

/** Deliberately informative, not blocking. A key change is genuinely
 *  ambiguous — a reinstall looks identical to an interception — so the honest
 *  response is to say what happened and offer the check, rather than throw up a
 *  scary modal people learn to tap through. */
export function KeyChangeBanner({ otherMembers, chatName }: { otherMembers: ChatMember[]; chatName?: string | null }) {
  const S = useS();
  const router = useRouter();
  // ── security-code change ──────────────────────────────────────────────
  //
  // A key substitution is invisible in normal use — the padlock still shows and
  // messages still decrypt — so it has to be surfaced unprompted rather than
  // waiting for someone to open the verify screen on the one day it matters.
  //
  // 1:1 only. A group has many identities and no single "the other person",
  // so a banner there would be noise rather than a signal.
  const [keyChange, setKeyChange] = useState<import('../../lib/keyChange').KeyChange | null>(null);
  useEffect(() => {
    const peers = otherMembers;
    if (peers.length !== 1) return;
    let cancelled = false;
    (async () => {
      const { checkKeyChange } = await import('../../lib/keyChange');
      const change = await checkKeyChange(peers[0].userId);
      if (!cancelled) setKeyChange(change);
    })();
    return () => { cancelled = true; };
  }, [otherMembers]);
  if (!keyChange) return null;
  return (
    <View style={S.keyChangeBanner}>
      <Text style={S.keyChangeTxt}>
        🔑 The security code for this chat changed. This usually means they
        reinstalled crazzychat or switched device.
      </Text>
      <View style={S.keyChangeRow}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Verify security code"
          onPress={() => router.push({ pathname: '/verify-contact',
            params: { peerId: keyChange.peerId,
              peerName: otherMembers[0]?.name ?? chatName ?? '' } })}
        >
          <Text style={S.keyChangeVerify}>Verify</Text>
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Dismiss security code notice"
          onPress={async () => {
            try {
              const { acknowledgeKeyChange } = await import('../../lib/keyChange');
              await acknowledgeKeyChange(keyChange.peerId, keyChange.currentHex);
              setKeyChange(null);
            } catch (e: any) {
              Alert.alert('Could not dismiss', e?.message ?? 'Try again');
            }
          }}
        >
          <Text style={S.keyChangeDismiss}>Dismiss</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/** Inbound screenshot alert — the screen auto-dismisses it after 4s. */
export function ScreenshotBanner({ by, membersById }: { by: string; membersById: Members }) {
  const S = useS();
  return (
    <View style={S.screenshotBanner} accessibilityLiveRegion="polite">
      <Text style={S.screenshotBannerTxt}>
        📸 {(() => {
          const who = membersById.get(by);
          return who?.name || who?.email || 'Someone';
        })()} just captured a screenshot of this chat.
      </Text>
    </View>
  );
}

/** Memory Bubble — anniversary of a past message in this chat. Stays mounted
 *  while the chat is veiled (`visible` false) so a dismissal survives a re-lock. */
export function MemoryBanner({ messages, membersById, visible }: { messages: DisplayMessage[]; membersById: Members; visible: boolean }) {
  const S = useS();
  // Memory Bubbles — dismissed per-session so the same anniversary doesn't
  // pop back up every time the user re-enters the chat in one sitting.
  const [dismissedMemoryIds, setDismissedMemoryIds] = useState<Set<number>>(new Set());
  // ── Memory Bubble (Emotional AI spec item) ────────────────
  // Pick the longest-ago message in this chat whose calendar (month, day)
  // matches today's. Skip messages younger than 364 days so "yesterday"
  // never qualifies. Returns null if nothing matches or the surfaced
  // candidate has already been dismissed this session.
  const memoryBubble = useMemo(() => {
    if (!messages.length) return null;
    const today = new Date();
    const todayMonth = today.getMonth();
    const todayDate  = today.getDate();
    const todayMs    = today.getTime();
    let pick: { msg: DisplayMessage; yearsAgo: number } | null = null;
    for (const m of messages) {
      if (!m.createdAt || !m.content || m.deletedAt) continue;
      if (m.type !== 'text') continue;                  // anniversary banner is text-only
      if (isProtectedMessage(m)) continue;              // Ink / view-once never quoted outside the bubble
      if (dismissedMemoryIds.has(m.id)) continue;
      const d = new Date(m.createdAt);
      if (Number.isNaN(d.getTime())) continue;
      if (d.getMonth() !== todayMonth || d.getDate() !== todayDate) continue;
      const ageMs = todayMs - d.getTime();
      if (ageMs < 364 * 86_400_000) continue;           // must be ≥1 year old
      const yearsAgo = Math.max(1, Math.round(ageMs / (365 * 86_400_000)));
      if (!pick || yearsAgo > pick.yearsAgo) pick = { msg: m, yearsAgo };
    }
    return pick;
  }, [messages, dismissedMemoryIds]);

  if (!memoryBubble || !visible) return null;
  return (
    <TouchableOpacity
      style={S.memoryBubble}
      onPress={() => setDismissedMemoryIds(prev => {
        const next = new Set(prev); next.add(memoryBubble.msg.id); return next;
      })}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityHint="Dismisses this memory"
    >
      <Text style={S.memoryBubbleTitle}>
        📅 {memoryBubble.yearsAgo === 1 ? '1 year ago today' : `${memoryBubble.yearsAgo} years ago today`}
        {(() => {
          const who = membersById.get(memoryBubble.msg.senderId);
          const name = who?.name || who?.email;
          return name ? ` · ${name} said` : '';
        })()}
      </Text>
      <Text style={S.memoryBubbleBody} numberOfLines={2}>
        “{memoryBubble.msg.content}”
      </Text>
      <Text style={S.memoryBubbleDismiss}>Tap to dismiss</Text>
    </TouchableOpacity>
  );
}

export type LiveLoc = { userId: string; latitude: number; longitude: number; address?: string };

/** A peer is sharing live location. */
export function LiveLocationBanner({ liveLoc, membersById, onHide }: { liveLoc: LiveLoc; membersById: Members; onHide: () => void }) {
  const S = useS();
  const { colors } = useTheme();
  // The ✕ is a SIBLING of the navigate target, not nested in it: a touchable
  // inside an accessible touchable is folded into it and unreachable on iOS.
  return (
    <View style={S.liveLocBanner}>
      <TouchableOpacity
        style={S.bannerMain}
        activeOpacity={0.85}
        onPress={() => navigateTo(liveLoc.latitude, liveLoc.longitude, membersById.get(liveLoc.userId)?.name || 'Live location')}
        accessibilityRole="button"
        accessibilityHint="Opens navigation to their location"
      >
        <Ionicons name="navigate" size={20} color={colors.primary} />
        <View style={{ flex: 1 }}>
          <Text style={S.liveLocTitle}>{membersById.get(liveLoc.userId)?.name || 'Someone'} is sharing live location</Text>
          {/* Falls back to raw lat/long, which at fontSize 11 ellipsised mid-
              coordinate - and half a coordinate points somewhere else entirely.
              Shrink the glyphs instead of cutting them (2026-09-17). */}
          <Text style={S.liveLocSub} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{liveLoc.address || `${liveLoc.latitude.toFixed(5)}, ${liveLoc.longitude.toFixed(5)}`} · Navigate</Text>
        </View>
      </TouchableOpacity>
      <TouchableOpacity onPress={onHide} hitSlop={12} accessibilityRole="button" accessibilityLabel="Hide live location banner">
        <Ionicons name="close" size={18} color={colors.textDim} />
      </TouchableOpacity>
    </View>
  );
}

/** Pinned-message bar (W15) — tap to jump, × to unpin. */
export function PinnedBar({ pinnedId, messages, onJump, onUnpin }: {
  pinnedId: string; messages: DisplayMessage[]; onJump: () => void; onUnpin: () => void;
}) {
  const S = useS();
  const { colors } = useTheme();
    const pm = messages.find(m => String(m.id) === pinnedId);
    const label = !pm ? 'Message'
      : pm.type === 'image' ? '📷 Photo' : pm.type === 'video' ? '🎥 Video'
      : pm.type === 'audio' ? '🎙️ Voice message' : pm.type === 'file' ? '📎 File'
      : pm.type === 'vaultbeam' ? '📦 File'
      : pm.type === 'location' ? '📍 Location' : pm.type === 'poll' ? '📊 Poll'
      : pm.type === 'game_invite' ? '🎮 Game invite'
      // Invisible Ink stays hidden here as it does in the bubble
      // (MessageBubble obscureForInk): no text, not even in the a11y label.
      : pm.meta?.invisibleInk ? 'Invisible Ink message'
      : pm.type === 'text' && pm.content && !looksEncrypted(pm.content) ? pm.content
      : 'Message';
    // Unpin is a sibling of the jump target, not nested in it (see LiveLocationBanner).
    return (
      <View style={S.pinnedBar}>
        <TouchableOpacity
          style={S.bannerMain}
          activeOpacity={0.8}
          onPress={onJump}
          accessibilityRole="button"
          accessibilityLabel={`Pinned message: ${label}`}
          accessibilityHint="Jumps to the pinned message"
        >
          <Ionicons name="pin" size={15} color={colors.primary} />
          <View style={{ flex: 1 }}>
            <Text style={S.pinnedBarTitle}>Pinned message</Text>
            <Text style={S.pinnedBarSub} numberOfLines={1}>{label}</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity hitSlop={14} onPress={onUnpin} accessibilityRole="button" accessibilityLabel="Unpin message">
          <Ionicons name="close" size={16} color={colors.textDim} />
        </TouchableOpacity>
      </View>
    );
}
