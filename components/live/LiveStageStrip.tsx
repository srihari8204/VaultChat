// components/live/LiveStageStrip.tsx — other people on the stage, as small tiles.
//
// Moved out of app/live-view.tsx. One change: each tile is now a labelled
// element ("Asha, on stage") instead of an unnamed video surface.
//
// A strip of small tiles, not a grid: the main frame belongs to whoever this
// device is watching, and the stage is at most 20 people while the audience is
// unbounded. Cameras only — a screen share belongs on the stage or in the
// corner, never in a 72px tile where nothing on it can be read.

import React from 'react';
import { View, ScrollView } from 'react-native';
import { RTCView } from '@livekit/react-native-webrtc';
import { S } from './liveStyles';

export function LiveStageStrip({ stagePeers, nameOf }: {
  /** identity -> camera stream URL */
  stagePeers: Record<string, string>;
  /** The participant's display name from the room, or '' when it has none. */
  nameOf: (identity: string) => string;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={S.stageStrip}
      contentContainerStyle={S.stageStripInner}
      accessibilityLabel="People on the stage"
    >
      {Object.entries(stagePeers).map(([uid, url], i) => (
        <View
          key={uid} style={S.stageTile} accessible accessibilityRole="image"
          accessibilityLabel={`${nameOf(uid) || `Stage member ${i + 1}`}, on stage`}
        >
          <RTCView streamURL={url} style={S.pipVideo} objectFit="cover" zOrder={1} />
        </View>
      ))}
    </ScrollView>
  );
}
