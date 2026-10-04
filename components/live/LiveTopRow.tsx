// components/live/LiveTopRow.tsx — the Go Live chrome's top row.
//
// Moved out of app/live-view.tsx unchanged, plus one control: "move the camera
// corner", the non-drag way to move the picture-in-picture.

import React from 'react';
import { View, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppText } from '../ui/Text';
import type { Broadcast } from '../../lib/broadcast';
import { LIVE, S } from './liveStyles';

export function LiveTopRow({
  b, reconnecting, failed, viewers, stageReady, onStage, isOwner,
  fill, onToggleFill, hasPip, pipOn, onTogglePip, onMovePip,
  chatOpen, unread, openChat, onNewPoll, onInvite, confirmStop, leaveAsViewer,
}: {
  b: Broadcast | null;
  reconnecting: boolean;
  failed: boolean;
  viewers: number;
  stageReady: boolean;
  onStage: boolean;
  /** Only the owner ends the broadcast and runs polls and invitations. */
  isOwner: boolean;
  fill: boolean;
  onToggleFill: () => void;
  /** There is a camera corner (a screen share owns the stage). */
  hasPip: boolean;
  pipOn: boolean;
  onTogglePip: () => void;
  onMovePip: () => void;
  chatOpen: boolean;
  unread: number;
  openChat: () => void;
  onNewPoll: () => void;
  onInvite: () => void;
  confirmStop: () => void;
  leaveAsViewer: () => void;
}) {
  // TOP ROW — status on the left, every action as a small icon on the right.
  // The exit lives here on purpose: it is the one control a viewer must always
  // be able to find.
  return (
    <View style={S.topRow} pointerEvents="box-none">
      {b && (
        <View style={S.bar}>
          {/* Amber, not red: the stream is not live and it has not ended
              either. The SDK is still recovering the transport, so the
              strip must say so rather than keep asserting LIVE — that
              assertion is the defect this closes. */}
          <View style={[S.liveDot, reconnecting && S.reconnectDot]} />
          <AppText style={S.barText}>
            {reconnecting
              ? 'RECONNECTING…'
              // `failed` BEFORE b.status, because b.status is the last
              // snapshot the POLL managed to fetch — and the poll is
              // exactly what cannot run when the network is the thing
              // that broke. Local terminal knowledge is fresher than an
              // unreachable server, so it wins.
              : failed ? 'FAILED'
              : b.status === 'live' ? 'LIVE' : b.status.toUpperCase()}
          </AppText>
          <AppText style={S.barDim}>{viewers || b.viewerCount}</AppText>
          {!b.e2ee && <AppText style={S.barDim}>· Not encrypted</AppText>}
        </View>
      )}

      <View style={S.grow} pointerEvents="none" />

      {/* FILL vs FIT. A viewer's own override of the default above — the
          only control that can rescue a landscape publisher from a crop,
          and the one that answers "why is this so small" on a stream the
          default guessed wrong about. */}
      {stageReady && !onStage && (
        <TouchableOpacity
          onPress={onToggleFill}
          style={[S.icon, fill && S.iconOn]}
          accessibilityRole="button"
          accessibilityLabel={fill ? 'Fit the whole picture on screen' : 'Fill the screen'}
          hitSlop={8}
        >
          <Ionicons name={fill ? 'contract' : 'expand'} size={18} color={LIVE.text} />
        </TouchableOpacity>
      )}

      {/* HIDE THE HOST'S CORNER. Shown only when there is a corner to
          hide, and it stays after hiding — it is the only way back. */}
      {stageReady && hasPip && (
        <TouchableOpacity
          onPress={onTogglePip}
          style={[S.icon, !pipOn && S.iconOn]}
          accessibilityRole="button"
          accessibilityLabel={pipOn ? 'Hide the camera corner' : 'Show the camera corner'}
          hitSlop={8}
        >
          <Ionicons name={pipOn ? 'person-circle' : 'eye-off-outline'} size={18} color={LIVE.text} />
        </TouchableOpacity>
      )}

      {/* MOVE THE CORNER WITHOUT DRAGGING — clockwise, one corner a tap.
          Dragging is the quick way; this is the way for anyone who
          cannot drag, and for a screen reader. */}
      {stageReady && hasPip && pipOn && (
        <TouchableOpacity
          onPress={onMovePip}
          style={S.icon}
          accessibilityRole="button"
          accessibilityLabel="Move the camera corner to the next corner"
          hitSlop={8}
        >
          <Ionicons name="move-outline" size={18} color={LIVE.text} />
        </TouchableOpacity>
      )}

      {stageReady && (
        <TouchableOpacity
          onPress={openChat}
          style={[S.icon, chatOpen && S.iconOn]}
          accessibilityRole="button"
          accessibilityLabel={!chatOpen && unread > 0 ? `Chat, ${unread} unread` : 'Chat'}
          accessibilityState={{ expanded: chatOpen }}
          hitSlop={8}
        >
          <Ionicons name="chatbubble-ellipses-outline" size={18} color={LIVE.text} />
          {/* Chat is folded away by default now, so a silent icon would
              hide the whole conversation. The count is what says
              something is happening down there. */}
          {!chatOpen && unread > 0 && (
            <View style={S.badge}>
              <AppText style={S.badgeText}>{unread > 99 ? '99+' : String(unread)}</AppText>
            </View>
          )}
        </TouchableOpacity>
      )}

      {isOwner && stageReady && (
        <TouchableOpacity
          onPress={onNewPoll}
          style={S.icon}
          accessibilityRole="button"
          accessibilityLabel="Create a poll"
          hitSlop={8}
        >
          <Ionicons name="stats-chart" size={18} color={LIVE.text} />
        </TouchableOpacity>
      )}

      {isOwner && b?.visibility === 'private' && stageReady && (
        <TouchableOpacity
          onPress={onInvite}
          style={S.icon}
          accessibilityRole="button"
          accessibilityLabel="Invite people"
          hitSlop={8}
        >
          <Ionicons name="person-add-outline" size={18} color={LIVE.text} />
        </TouchableOpacity>
      )}

      {/* THE EXIT. The host ends the broadcast (confirmed first — it
          disconnects everyone); a viewer just leaves.

          leaveAsViewer, not router.back(): a viewer who arrived through
          an invitation link got here via router.replace and has no
          history, so back exits the app. */}
      {/* Shown while waiting too: a host stuck on "Starting your
          broadcast…" otherwise had no on-screen exit at all. */}
      {isOwner ? (
        <TouchableOpacity
          onPress={confirmStop}
          style={[S.icon, S.iconDanger]}
          accessibilityLabel="End broadcast"
          accessibilityRole="button"
          hitSlop={8}
        >
          <Ionicons name="stop" size={18} color={LIVE.text} />
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          onPress={leaveAsViewer}
          style={[S.icon, S.iconDanger]}
          accessibilityRole="button"
          accessibilityLabel="Leave"
          hitSlop={8}
        >
          <Ionicons name="close" size={18} color={LIVE.text} />
        </TouchableOpacity>
      )}
    </View>
  );
}
