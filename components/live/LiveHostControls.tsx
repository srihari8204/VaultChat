// components/live/LiveHostControls.tsx — the stage member's mic/camera/screen row.
//
// Moved out of app/live-view.tsx unchanged. Rendered only when there is a
// session to drive — a host whose publish failed gets no buttons rather than
// dead ones.
//
// The publish permission is in the TOKEN, not here: an audience grant has
// canPublish=false and an empty source list, so hiding these is a courtesy and
// the media server is the enforcement.

import React from 'react';
import { View, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LIVE, S } from './liveStyles';

type Source = 'mic' | 'camera' | 'screen';

export function LiveHostControls({ media, busy, toggle }: {
  media: Record<Source, boolean>;
  busy: Source | null;
  toggle: (what: Source) => void;
}) {
  return (
    <View style={S.controls}>
      {([
        ['mic', media.mic ? 'mic' : 'mic-off', 'Microphone'],
        ['camera', media.camera ? 'videocam' : 'videocam-off', 'Camera'],
        ['screen', media.screen ? 'phone-portrait' : 'phone-portrait-outline', 'Screen'],
      ] as const).map(([what, icon, label]) => (
        <TouchableOpacity
          key={what}
          onPress={() => toggle(what)}
          disabled={busy !== null}
          accessibilityLabel={label}
          accessibilityRole="button"
          accessibilityState={{ selected: media[what], disabled: busy !== null }}
          style={[
            S.ctrl,
            // Screen share is the one that is ON when highlighted;
            // mic and camera are highlighted when OFF, because
            // "muted" is the state a host needs to spot at a glance.
            (what === 'screen' ? media.screen : !media[what]) && S.ctrlActive,
          ]}
          activeOpacity={0.85}
        >
          {busy === what
            ? <ActivityIndicator color={LIVE.text} size="small" />
            : <Ionicons name={icon} size={20} color={LIVE.text} />}
        </TouchableOpacity>
      ))}
    </View>
  );
}
