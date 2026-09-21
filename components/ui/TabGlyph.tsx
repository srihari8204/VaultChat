import React, { useId } from 'react';
import Svg, { Circle, Defs, G, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

export type TabGlyphName = 'chats' | 'status' | 'mini' | 'calls' | 'profile';

/** Compact, two-tone artwork; filled cores distinguish selection without color. */
export function TabGlyph({ name, color, active, size = 26 }: {
  name: TabGlyphName; color: string; active: boolean; size?: number;
}) {
  const ink = `tab${useId().replace(/:/g, '')}`;
  const fill = `url(#${ink})`;
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" accessible={false}>
      <Defs>
        <LinearGradient id={ink} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={color} stopOpacity={active ? 0.75 : 0.25} />
          <Stop offset="1" stopColor={color} stopOpacity={active ? 0.3 : 0.08} />
        </LinearGradient>
      </Defs>
      <G stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        {name === 'chats' ? <>
          <Path d="M22 12h2a4 4 0 0 1 4 4v6l1 4-5-2h-6a4 4 0 0 1-4-4" fill={fill} opacity={0.65} />
          <Path d="M7 5h12a5 5 0 0 1 5 5v6a5 5 0 0 1-5 5H11l-7 4 1-7a5 5 0 0 1-2-4v-4a5 5 0 0 1 4-5Z" fill={fill} />
          <Path d="M8 11h11M8 15h7" opacity={active ? 1 : 0.75} />
        </> : null}
        {name === 'status' ? <>
          <Path d="M17 3a13 13 0 0 1 12 12M29 19a13 13 0 0 1-11 10M12 28A13 13 0 0 1 3 17M4 11a13 13 0 0 1 7-7" fill="none" />
          <Circle cx="16" cy="16" r="8" fill={fill} strokeWidth={active ? 2.2 : 1.5} />
          <Path d="m14 12 6 4-6 4Z" fill={active ? color : 'none'} strokeWidth={1.4} />
        </> : null}
        {name === 'mini' ? <>
          <Rect x="4" y="4" width="10" height="10" rx="3" fill={fill} />
          <Path d="m23 3 6 6-6 6-6-6Z" fill={active ? color : fill} />
          <Rect x="4" y="18" width="10" height="10" rx="3" fill={active ? color : fill} />
          <Rect x="18" y="18" width="10" height="10" rx="3" fill={fill} />
        </> : null}
        {name === 'calls' ? <>
          <Path d="m8 4 5 6-3 4c2 4 4 6 8 8l4-3 6 5-2 4C15 29 3 17 4 7Z" fill={fill} />
          <Path d="M20 4a10 10 0 0 1 8 8M20 9a5 5 0 0 1 3 3" fill="none" strokeWidth={active ? 2.3 : 1.8} />
        </> : null}
        {name === 'profile' ? <>
          <Circle cx="16" cy="10" r="5.5" fill={fill} />
          <Path d="M5 27v-2c0-5 5-8 11-8s11 3 11 8v2Z" fill={fill} />
          <Path d="M12 24h8" strokeWidth={active ? 2.8 : 1.5} opacity={active ? 1 : 0.65} />
        </> : null}
      </G>
    </Svg>
  );
}
