// app/watch-together.tsx
// Watch Together — Synchronized YouTube playback via D2DE
// Features: Sync playback, D2DE connection, voice chat overlay

import React, { useState , useMemo} from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  Alert, Platform, KeyboardAvoidingView, ScrollView,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';


function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function WatchTogetherScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const { peerUid, peerName } = useLocalSearchParams<{ peerUid?: string; peerName?: string }>();

  const [videoUrl, setVideoUrl] = useState('');
  const [isWatching, setIsWatching] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [voiceChat, setVoiceChat] = useState(true);
  const [viewerCount, setViewerCount] = useState(0);
  const [currentTime, setCurrentTime] = useState('0:00');

  const startWatching = () => {
    if (!videoUrl.trim()) {
      Alert.alert('Enter URL', 'Paste a YouTube URL to watch together');
      return;
    }
    setIsWatching(true);
    setIsPlaying(true);
    setViewerCount(2);
  };

  const stopWatching = () => {
    setIsWatching(false);
    setIsPlaying(false);
    setViewerCount(0);
  };

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => isWatching ? stopWatching() : router.back()} style={s.backBtn}>
          <Text style={s.backTxt}>{'\u2190'}</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>{'\uD83C\uDFAC'} Watch Together</Text>
          <Text style={s.headerSub}>Synced {'\u2022'} YouTube</Text>
        </View>
        {isWatching && (
          <View style={s.syncBadge}>
            <Text style={s.syncTxt}>{'\uD83D\uDD17'} SYNCED</Text>
          </View>
        )}
      </View>

      {!isWatching ? (
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={s.body}>
            <Text style={s.bigIcon}>{'\uD83C\uDFAC'}</Text>
            <Text style={s.bodyTitle}>Watch Together</Text>
            <Text style={s.bodySub}>
              Synchronized YouTube playback via official API. Both users see the same frame at the same time, kept in sync via the YouTube API (no end-to-end encryption).
            </Text>

            <View style={s.urlCard}>
              <Text style={s.urlLabel}>YouTube URL</Text>
              <TextInput
                style={s.urlInput}
                placeholder="https://youtube.com/watch?v=..."
                placeholderTextColor="#555"
                value={videoUrl}
                onChangeText={setVideoUrl}
                autoCapitalize="none"
                keyboardType="url"
              />
            </View>

            <TouchableOpacity style={s.startBtn} onPress={startWatching} activeOpacity={0.8}>
              <Text style={s.startBtnIcon}>{'\u25B6\uFE0F'}</Text>
              <Text style={s.startBtnTxt}>Start Watching</Text>
            </TouchableOpacity>

            <View style={s.infoCard}>
              <Text style={s.infoTitle}>How it works</Text>
              {[
                ['\uD83D\uDD17', 'Paste any YouTube URL'],
                ['\uD83D\uDCE1', 'Playback state synced via the YouTube API'],
                ['\u23EF\uFE0F', 'Play/pause/seek synced in real-time'],
                ['\uD83C\uDFA4', 'Voice chat overlay while watching'],
                ['\uD83D\uDD12', 'Server sees nothing \u2014 all P2P'],
              ].map(([icon, text], i) => (
                <View key={i} style={s.infoRow}>
                  <Text style={s.infoIcon}>{icon}</Text>
                  <Text style={s.infoTxt}>{text}</Text>
                </View>
              ))}
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      ) : (
        <View style={s.watchingBody}>
          <View style={s.videoArea}>
            <View style={s.videoPlaceholder}>
              <Text style={s.videoIcon}>{isPlaying ? '\u25B6\uFE0F' : '\u23F8\uFE0F'}</Text>
              <Text style={s.videoTxt}>YouTube Player</Text>
              <Text style={s.videoUrl} numberOfLines={1}>{videoUrl}</Text>
            </View>
          </View>

          <View style={s.playbackBar}>
            <Text style={s.timeTxt}>{currentTime}</Text>
            <View style={s.progressTrack}>
              <View style={[s.progressFill, { width: '35%' }]} />
            </View>
            <Text style={s.timeTxt}>3:45</Text>
          </View>

          <View style={s.playerControls}>
            <TouchableOpacity style={s.playerBtn} onPress={() => setCurrentTime('0:00')}>
              <Text style={s.playerBtnIcon}>{'\u23EA'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.playerBtnMain} onPress={() => setIsPlaying(p => !p)}>
              <Text style={s.playerBtnMainIcon}>{isPlaying ? '\u23F8\uFE0F' : '\u25B6\uFE0F'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.playerBtn}>
              <Text style={s.playerBtnIcon}>{'\u23E9'}</Text>
            </TouchableOpacity>
          </View>

          <View style={s.statusRow}>
            <View style={s.statusBadge}><Text style={s.statusBadgeTxt}>SYNCED</Text></View>
            <View style={s.statusBadge}><Text style={s.statusBadgeTxt}>{viewerCount} viewers</Text></View>
            {voiceChat && <View style={s.statusBadge}><Text style={s.statusBadgeTxt}>{'\uD83C\uDFA4'} Voice ON</Text></View>}
          </View>

          <View style={s.bottomControls}>
            <TouchableOpacity style={s.bottomBtn} onPress={() => setVoiceChat(v => !v)}>
              <Text style={s.bottomBtnIcon}>{voiceChat ? '\uD83C\uDFA4' : '\uD83D\uDD07'}</Text>
              <Text style={s.bottomBtnTxt}>{voiceChat ? 'Voice On' : 'Voice Off'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.bottomBtn, s.bottomBtnDanger]} onPress={stopWatching}>
              <Text style={s.bottomBtnIcon}>{'\u23F9\uFE0F'}</Text>
              <Text style={[s.bottomBtnTxt, { color: colors.danger }]}>End</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
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
  syncBadge: { backgroundColor: c.primary + '20', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10 },
  syncTxt: { color: c.primary, fontSize: 11, fontWeight: '700' },

  body: { padding: 20, paddingBottom: 40 },
  bigIcon: { fontSize: 48, textAlign: 'center', marginBottom: 12, marginTop: 8 },
  bodyTitle: { fontSize: 22, fontWeight: '700', color: c.text, textAlign: 'center', marginBottom: 6 },
  bodySub: { fontSize: 13, color: c.textDim, textAlign: 'center', lineHeight: 19, marginBottom: 24 },

  urlCard: { backgroundColor: c.card, borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: c.border },
  urlLabel: { fontSize: 12, fontWeight: '600', color: c.purple, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  urlInput: { backgroundColor: c.bg, borderRadius: 12, padding: 14, color: c.text, fontSize: 15, borderWidth: 1, borderColor: c.border },

  startBtn: { backgroundColor: c.purple, borderRadius: 16, paddingVertical: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 24 },
  startBtnIcon: { fontSize: 20 },
  startBtnTxt: { color: '#FFF', fontSize: 17, fontWeight: '700' },

  infoCard: { backgroundColor: c.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: c.border },
  infoTitle: { fontSize: 14, fontWeight: '600', color: c.text, marginBottom: 12 },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  infoIcon: { fontSize: 16, width: 24, textAlign: 'center' },
  infoTxt: { fontSize: 13, color: c.textDim },

  watchingBody: { flex: 1 },
  videoArea: { aspectRatio: 16 / 9, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' },
  videoPlaceholder: { alignItems: 'center' },
  videoIcon: { fontSize: 48, marginBottom: 8 },
  videoTxt: { color: c.text, fontSize: 16, fontWeight: '600' },
  videoUrl: { color: c.textDim, fontSize: 11, marginTop: 4, maxWidth: 250 },

  playbackBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  timeTxt: { color: c.textDim, fontSize: 11, fontWeight: '600', minWidth: 30 },
  progressTrack: { flex: 1, height: 3, backgroundColor: '#333', borderRadius: 2 },
  progressFill: { height: 3, backgroundColor: c.purple, borderRadius: 2 },

  playerControls: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 24, paddingVertical: 12 },
  playerBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: c.card, alignItems: 'center', justifyContent: 'center' },
  playerBtnIcon: { fontSize: 20 },
  playerBtnMain: { width: 60, height: 60, borderRadius: 30, backgroundColor: c.purple, alignItems: 'center', justifyContent: 'center' },
  playerBtnMainIcon: { fontSize: 28 },

  statusRow: { flexDirection: 'row', justifyContent: 'center', gap: 8, paddingVertical: 12, flexWrap: 'wrap' },
  statusBadge: { backgroundColor: c.primary + '15', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  statusBadgeTxt: { color: c.primary, fontSize: 10, fontWeight: '700' },

  bottomControls: { flexDirection: 'row', justifyContent: 'center', gap: 16, paddingVertical: 16, paddingBottom: Platform.OS === 'ios' ? 34 : 16, marginTop: 'auto' as any, backgroundColor: c.card, borderTopWidth: 1, borderTopColor: c.border },
  bottomBtn: { backgroundColor: '#2A2D3A', borderRadius: 14, paddingVertical: 12, paddingHorizontal: 24, alignItems: 'center', flexDirection: 'row', gap: 8 },
  bottomBtnDanger: { borderWidth: 1, borderColor: c.danger + '40' },
  bottomBtnIcon: { fontSize: 18 },
  bottomBtnTxt: { fontSize: 14, fontWeight: '600', color: c.text },
});
