// app/screen-share.tsx
// Screen Share — 6 features matching PDF page 19
// 1. Screen Share (P2P)        4. Pause Sharing
// 2. Screen Annotation          5. Watch Together YouTube
// 3. View-Only Mode             6. Voice Chat Overlay

import { Ionicons } from '@expo/vector-icons';
import React, { useState , useMemo} from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert, Platform, Switch,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';


function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function ScreenShareScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const { peerUid, peerName } = useLocalSearchParams<{ peerUid?: string; peerName?: string }>();

  const [isSharing, setIsSharing] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [viewOnlyMode, setViewOnlyMode] = useState(true);
  const [annotationEnabled, setAnnotationEnabled] = useState(false);
  const [voiceOverlay, setVoiceOverlay] = useState(true);
  const [viewerCount, setViewerCount] = useState(0);

  const startSharing = () => {
    setIsSharing(true);
    setViewerCount(1);
    Alert.alert('Screen Share', 'Screen sharing is in preview — real device-to-device streaming (WebRTC) is not wired up yet, so nothing is transmitted.');
  };

  const stopSharing = () => {
    setIsSharing(false);
    setIsPaused(false);
    setViewerCount(0);
  };

  const togglePause = () => {
    setIsPaused(p => !p);
  };

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>{'\uD83D\uDCBB'} Screen Share</Text>
          <Text style={s.headerSub}>P2P Encrypted {'\u2022'} Server sees nothing</Text>
        </View>
        {isSharing && (
          <View style={s.liveBadge}>
            <View style={s.liveDot} />
            <Text style={s.liveTxt}>{isPaused ? 'PAUSED' : 'LIVE'}</Text>
          </View>
        )}
      </View>

      {/* Main content */}
      {!isSharing ? (
        <View style={s.body}>
          <Text style={s.bigIcon}>{'\uD83D\uDCBB'}</Text>
          <Text style={s.bodyTitle}>Share Your Screen</Text>
          <Text style={s.bodySub}>Share your entire screen. Viewer count shown. No remote control. (Preview — streaming not wired yet.)</Text>

          {/* Settings before sharing */}
          <View style={s.settingsCard}>
            <SettingRow icon={'\uD83D\uDD12'} title="View-Only Mode" sub="Viewers can't screenshot (FLAG_SECURE)" value={viewOnlyMode} onChange={setViewOnlyMode} />
            <SettingRow icon={'\u270F\uFE0F'} title="Allow Annotations" sub="Viewers can draw and point on screen" value={annotationEnabled} onChange={setAnnotationEnabled} />
            <SettingRow icon={'\uD83C\uDFA4'} title="Voice Chat Overlay" sub="Talk while sharing screen" value={voiceOverlay} onChange={setVoiceOverlay} />
          </View>

          <TouchableOpacity style={s.startBtn} onPress={startSharing} activeOpacity={0.8}>
            <Text style={s.startBtnIcon}>{'\uD83D\uDCBB'}</Text>
            <Text style={s.startBtnTxt}>Start Sharing</Text>
          </TouchableOpacity>

          {/* Features list */}
          <View style={s.featCard}>
            <Text style={s.featTitle}>6 Features</Text>
            {[
              ['\uD83D\uDCBB', 'Screen Share (P2P)', 'Entire screen (preview \u2014 not wired yet)'],
              ['\u270F\uFE0F', 'Screen Annotation', 'Viewers draw and point on shared screen'],
              ['\uD83D\uDD12', 'View-Only Mode', 'FLAG_SECURE on receiver — can\'t screenshot'],
              ['\u23F8\uFE0F', 'Pause Sharing', 'Freeze screen without ending session'],
              ['\uD83C\uDFAC', 'Watch Together', 'Synchronized YouTube playback'],
              ['\uD83C\uDFA4', 'Voice Chat Overlay', 'Talk while sharing or watching together'],
            ].map(([icon, title, desc], i) => (
              <View key={i} style={s.featRow}>
                <Text style={s.featIcon}>{icon}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.featName}>{title}</Text>
                  <Text style={s.featDesc}>{desc}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      ) : (
        /* Active sharing view */
        <View style={s.sharingBody}>
          <View style={s.previewArea}>
            <Text style={s.previewIcon}>{isPaused ? '\u23F8\uFE0F' : '\uD83D\uDCBB'}</Text>
            <Text style={s.previewTxt}>{isPaused ? 'Screen Paused' : 'Sharing your screen...'}</Text>
            <Text style={s.previewSub}>{viewerCount} viewer{viewerCount !== 1 ? 's' : ''} connected</Text>

            <View style={s.badges}>
              <View style={s.encBadge}><Text style={s.encBadgeTxt}>PREVIEW</Text></View>
              {viewOnlyMode && <View style={s.encBadge}><Text style={s.encBadgeTxt}>VIEW ONLY</Text></View>}
              {annotationEnabled && <View style={s.encBadge}><Text style={s.encBadgeTxt}>ANNOTATION ON</Text></View>}
            </View>
          </View>

          {/* Controls */}
          <View style={s.shareControls}>
            <TouchableOpacity style={[s.shareCtrlBtn, isPaused && s.shareCtrlActive]} onPress={togglePause}>
              <Text style={s.shareCtrlIcon}>{isPaused ? '\u25B6\uFE0F' : '\u23F8\uFE0F'}</Text>
              <Text style={s.shareCtrlTxt}>{isPaused ? 'Resume' : 'Pause'}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[s.shareCtrlBtn, s.shareCtrlDanger]} onPress={stopSharing}>
              <Text style={s.shareCtrlIcon}>{'\u23F9\uFE0F'}</Text>
              <Text style={[s.shareCtrlTxt, { color: colors.danger }]}>Stop</Text>
            </TouchableOpacity>
          </View>

          <Text style={s.footerNote}>No remote control {'\u2022'} Preview \u2014 real P2P streaming not wired yet</Text>
        </View>
      )}
    </View>
  );
}

function SettingRow({ icon, title, sub, value, onChange }: {
  icon: string; title: string; sub: string; value: boolean; onChange: (v: boolean) => void;
}) {
  const s = useS();
  const { colors } = useTheme();
  return (
    <View style={s.settingRow}>
      <Text style={s.settingIcon}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={s.settingTitle}>{title}</Text>
        <Text style={s.settingSub}>{sub}</Text>
      </View>
      <Switch value={value} onValueChange={onChange}
        trackColor={{ false: '#374151', true: colors.purple + '80' }}
        thumbColor={value ? colors.purple : '#6B7280'}
      />
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingTop: Platform.OS === 'ios' ? 56 : 44, paddingBottom: 14, paddingHorizontal: 16,
    backgroundColor: c.card, borderBottomWidth: 1, borderBottomColor: c.border,
  },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#2A2D3A', alignItems: 'center', justifyContent: 'center' },
  backTxt: { fontSize: 18, color: c.text },
  headerTitle: { fontSize: 16, fontWeight: '700', color: c.text },
  headerSub: { fontSize: 11, color: c.primary, marginTop: 1, fontWeight: '600' },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.danger + '20', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.danger },
  liveTxt: { color: c.danger, fontSize: 11, fontWeight: '700' },

  body: { flex: 1, padding: 20 },
  bigIcon: { fontSize: 48, textAlign: 'center', marginBottom: 12, marginTop: 12 },
  bodyTitle: { fontSize: 22, fontWeight: '700', color: c.text, textAlign: 'center', marginBottom: 6 },
  bodySub: { fontSize: 13, color: c.textDim, textAlign: 'center', lineHeight: 19, marginBottom: 24 },

  settingsCard: { backgroundColor: c.card, borderRadius: 16, padding: 4, marginBottom: 20, borderWidth: 1, borderColor: c.border },
  settingRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderBottomWidth: 1, borderBottomColor: c.border },
  settingIcon: { fontSize: 20, width: 28, textAlign: 'center' },
  settingTitle: { fontSize: 14, fontWeight: '600', color: c.text },
  settingSub: { fontSize: 11, color: c.textDim, marginTop: 1 },

  startBtn: { backgroundColor: c.purple, borderRadius: 16, paddingVertical: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 24 },
  startBtnIcon: { fontSize: 22 },
  startBtnTxt: { color: '#FFF', fontSize: 17, fontWeight: '700' },

  featCard: { backgroundColor: c.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: c.border },
  featTitle: { fontSize: 14, fontWeight: '600', color: c.purple, marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  featRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 8 },
  featIcon: { fontSize: 18, width: 26, textAlign: 'center', marginTop: 1 },
  featName: { fontSize: 13, fontWeight: '600', color: c.text },
  featDesc: { fontSize: 11, color: c.textDim, marginTop: 1 },

  // Active sharing
  sharingBody: { flex: 1, padding: 20, justifyContent: 'center' },
  previewArea: { alignItems: 'center', marginBottom: 40 },
  previewIcon: { fontSize: 64, marginBottom: 16 },
  previewTxt: { fontSize: 20, fontWeight: '700', color: c.text, marginBottom: 4 },
  previewSub: { fontSize: 14, color: c.textDim, marginBottom: 20 },
  badges: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', justifyContent: 'center' },
  encBadge: { backgroundColor: c.primary + '20', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  encBadgeTxt: { color: c.primary, fontSize: 10, fontWeight: '700' },

  shareControls: { flexDirection: 'row', justifyContent: 'center', gap: 16, marginBottom: 24 },
  shareCtrlBtn: { backgroundColor: c.card, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 28, alignItems: 'center', borderWidth: 1, borderColor: c.border },
  shareCtrlActive: { backgroundColor: c.purple + '15', borderColor: c.purple + '40' },
  shareCtrlDanger: { borderColor: c.danger + '40' },
  shareCtrlIcon: { fontSize: 24, marginBottom: 4 },
  shareCtrlTxt: { fontSize: 12, color: c.text, fontWeight: '600' },

  footerNote: { color: c.primary, fontSize: 11, textAlign: 'center', fontWeight: '600' },
});
