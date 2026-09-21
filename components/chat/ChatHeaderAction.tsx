import React from 'react';
import { StyleSheet, TouchableOpacity } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, G, Path, Rect } from 'react-native-svg';
import { CHAT_ACTION_INK } from '../../constants/theme';
import { useTheme } from '../../lib/theme';

/** Original 40dp slots and order; hit slop gives each action a 44dp target. */
export function ChatHeaderAction({ action, label, onPress }: {
  action: keyof typeof CHAT_ACTION_INK; label: string; onPress: () => void;
}) {
  const { scheme, colors } = useTheme();
  const ink = CHAT_ACTION_INK[action][scheme];
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.72} hitSlop={2}
      accessibilityRole="button" accessibilityLabel={label}
      style={[styles.button, { backgroundColor: colors.glassSoft, borderColor: colors.glassStroke }]}>
      <LinearGradient pointerEvents="none" colors={[colors.glass, colors.glassSoft]} style={StyleSheet.absoluteFill} />
      <Svg width={23} height={23} viewBox="0 0 24 24" accessible={false}>
        <G stroke={ink} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" fill="none">
          {action === 'search' && <>
            <Circle cx={10.5} cy={10.5} r={6.5} fill={ink} fillOpacity={0.12} />
            <Path d="M15.2 15.2 20.5 20.5M7.4 9.1a3.4 3.4 0 0 1 3.1-2" />
          </>}
          {action === 'alerts' && <>
            <Path d="M5 16.8h14l-1.7-2.5V9a5.3 5.3 0 0 0-10.6 0v5.3L5 16.8Z" fill={ink} fillOpacity={0.12} />
            <Path d="M9.7 20a2.7 2.7 0 0 0 4.6 0M12 2.8V2" />
            <Circle cx={18.7} cy={5.2} r={2.1} fill={ink} stroke="none" />
          </>}
          {action === 'temporary' && <>
            <Circle cx={12} cy={13} r={7.6} fill={ink} fillOpacity={0.12} strokeDasharray="30 3 7 3" />
            <Path d="M9 2h6M12 2v3M18.2 6.8l1.7-1.7M12 8.6V13l3.1 1.8" />
            <Circle cx={12} cy={13} r={1} fill={ink} stroke="none" />
          </>}
          {action === 'contacts' && <>
            <Rect x={3} y={4} width={15} height={17} rx={4} fill={ink} fillOpacity={0.12} />
            <Path d="M19 7h2M19 12h2M19 17h2M6.5 17.5c.7-3.1 7.3-3.1 8 0" />
            <Circle cx={10.5} cy={10} r={2.4} />
          </>}
          {action === 'broadcast' && <>
            <Path d="M4 9.5h3.5L16 5v14l-8.5-4.5H4V9.5Z" fill={ink} fillOpacity={0.12} />
            <Path d="m6 14.5 1.4 5h3l-1.8-4.5M19 9a5 5 0 0 1 0 6M21 6a9 9 0 0 1 0 12" />
          </>}
        </G>
      </Svg>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: { width: 40, height: 40, borderRadius: 14, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18)' },
});
