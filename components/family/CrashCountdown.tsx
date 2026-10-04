// components/family/CrashCountdown.tsx — the full-screen "possible crash"
// countdown, moved out of app/family.tsx unchanged. Loud and biased toward
// asking for help: doing nothing sends the SOS; only "I'm OK" stops it.

import React from 'react';
import { View, Modal, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { AppText as Text } from '../ui/Text';
import { useTheme } from '../../lib/theme';
import { useSpaceGlass } from '../spaces/SpaceGround';

export default function CrashCountdown({ visible, secondsLeft, onOk, onSendNow }: {
  visible: boolean;
  secondsLeft: number;
  onOk: () => void;
  onSendNow: () => void;
}) {
  const { colors } = useTheme();
  const G = useSpaceGlass();
  return (
    // Back does nothing: it used to cancel the countdown silently, which is an
    // "I'm OK" nobody chose. Only the two buttons decide.
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => {}}>
      {/* A deliberately darker scrim than the sheets: this is an alarm. */}
      <View style={[st.crashWrap, { backgroundColor: 'rgba(0,0,0,0.82)' }]}>
        {/* maxHeight + inner scroll for the EXPLANATION only — the two buttons
            stay pinned below it. At large font scales the old fixed stack
            could push "I'm OK" off-screen, and an unreachable "I'm OK" means
            the countdown fires a false SOS. Button fills are the deep
            green/red (the light-scheme goodText/dangerText hues): white 15.5px
            labels on #22C55E were 2.3:1 — the one button that stops a false
            alarm was the least readable thing on the screen. */}
        <View style={[st.crashCard, { backgroundColor: G.sheet, borderColor: colors.danger }]}>
          <ScrollView style={{ alignSelf: 'stretch', flexGrow: 0 }} bounces={false} contentContainerStyle={{ alignItems: 'center', gap: 10 }}>
            <Text style={{ fontSize: 40 }} accessible={false}>🚨</Text>
            <Text style={[st.crashTitle, { color: colors.text }]} accessibilityRole="header">Possible crash detected</Text>
            <Text style={{ color: colors.textDim, fontSize: 13.5, textAlign: 'center', lineHeight: 19 }}>
              A hard impact was detected while driving. If you don’t respond,
              your circle gets an SOS with your live location.
            </Text>
            <Text style={[st.crashCount, { color: colors.danger }]} accessibilityLiveRegion="assertive"
              accessibilityLabel={`SOS in ${secondsLeft} seconds`}>{secondsLeft}</Text>
          </ScrollView>
          <TouchableOpacity
            onPress={onOk}
            accessibilityRole="button"
            accessibilityLabel="I'm OK, cancel the SOS"
            // Solid deep green: white on #15803D is ~5:1 (AA).
            style={[st.crashBtn, { backgroundColor: '#15803D' }]}
          >
            <Text style={st.crashBtnTxt}>I’m OK</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onSendNow}
            accessibilityRole="button"
            style={[st.crashBtn, { backgroundColor: '#B42318' }]}
          >
            <Text style={st.crashBtnTxt}>Send SOS now</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  crashWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 26 },
  crashCard: { width: '100%', maxWidth: 360, maxHeight: '90%', borderWidth: 2, borderRadius: 24, padding: 22, alignItems: 'center', gap: 10 },
  crashTitle: { fontSize: 19, fontWeight: '900', textAlign: 'center' },
  crashCount: { fontSize: 44, fontWeight: '900', fontVariant: ['tabular-nums'] },
  crashBtn: { alignSelf: 'stretch', minHeight: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  crashBtnTxt: { color: '#fff', fontSize: 15.5, fontWeight: '800' },
});
