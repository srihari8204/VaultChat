// app/voice-effects.tsx — Voice Effects for Calls & Messages
// Change voice pitch, speed, reverb for privacy or fun
// Record preview with effect applied before sending

import { BRAND_ACCENT } from '../constants/theme';
import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  StatusBar, Animated, Dimensions, Alert, ScrollView, Platform, useWindowDimensions } from 'react-native';
import { Stack } from 'expo-router';
import { Audio } from 'expo-av';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Palette } from '../constants/theme';
import { useColors } from '../lib/theme';
import { permissionDenied } from '../lib/permissionDenied';

// bg/card were '#FFFFFF'/'#F9FAFB' while the text comes from the live theme —
// white-on-white in dark mode, which is the default. This factory already
// receives the real palette as `c`, so the ground comes from there now and the
// screen follows Light/Dark like every other one.
const C = { accent: '#A78BFA', green: BRAND_ACCENT };

const EFFECTS = [
  { id: 'none', name: 'Normal', icon: '\uD83C\uDFA4', desc: 'Your natural voice', pitch: 1.0, rate: 1.0, color: '#8A8394' },   // EFFECTS is module-level data and cannot read the
    // live palette; the "no effect" swatch takes a fixed mid-neutral that holds
    // contrast on both grounds. Every other entry is already a fixed hue.
  { id: 'deep', name: 'Deep Voice', icon: '\uD83D\uDC3B', desc: 'Lower pitch for a deeper tone', pitch: 0.7, rate: 0.95, color: BRAND_ACCENT },
  { id: 'high', name: 'High Voice', icon: '\uD83D\uDC3F\uFE0F', desc: 'Higher pitch, chipmunk style', pitch: 1.5, rate: 1.05, color: '#F59E0B' },
  { id: 'robot', name: 'Robot', icon: '\uD83E\uDD16', desc: 'Robotic metallic voice', pitch: 0.85, rate: 0.8, color: '#4A9FFF' },
  { id: 'whisper', name: 'Whisper', icon: '\uD83E\uDD2B', desc: 'Quiet breathy whisper', pitch: 1.1, rate: 0.7, color: '#8B949E' },
  { id: 'fast', name: 'Speed Up', icon: '\u26A1', desc: 'Faster playback', pitch: 1.0, rate: 1.5, color: BRAND_ACCENT },
  { id: 'slow', name: 'Slow Mo', icon: '\uD83D\uDC22', desc: 'Dramatic slow motion', pitch: 1.0, rate: 0.5, color: '#EC4899' },
  { id: 'echo', name: 'Echo', icon: '\uD83C\uDF0A', desc: 'Echoing cave effect', pitch: 0.95, rate: 0.9, color: '#A78BFA' },
  { id: 'alien', name: 'Alien', icon: '\uD83D\uDC7D', desc: 'Extraterrestrial voice', pitch: 1.8, rate: 0.85, color: '#22D3EE' },
  { id: 'giant', name: 'Giant', icon: '\uD83E\uDDD4', desc: 'Booming giant voice', pitch: 0.5, rate: 0.8, color: '#EF4444' },
];

const SETTINGS_KEY = 'vc_voice_effect';

export default function VoiceEffectsScreen() {
  const c = useColors();
  // Reactive size: this follows rotation, folds and split-screen resizes, and
  // is threaded into makeStyles so the derived card widths follow too.
  const {width: SW} = useWindowDimensions();
  const s = useMemo(() => makeStyles(c, SW), [c, SW]);

  const [selected, setSelected] = useState('none');
  const [recording, setRecording] = useState(null);
  const [recordedUri, setRecordedUri] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [callEffect, setCallEffect] = useState('none');
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const soundRef = useRef(null);

  useEffect(() => {
    (async () => {
      const saved = await AsyncStorage.getItem(SETTINGS_KEY);
      if (saved) { setSelected(saved); setCallEffect(saved); }
    })();
  }, []);

  useEffect(() => {
    if (recording) {
      const pulse = Animated.loop(Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.3, duration: 500, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
      ]));
      pulse.start();
      return () => pulse.stop();
    }
  }, [recording, pulseAnim]);

  const startRecord = async () => {
    if (Platform.OS === 'web') { Alert.alert('Not supported', 'Recording is not available on web'); return; }
    try {
      const { granted, canAskAgain } = await Audio.requestPermissionsAsync();
      if (!granted) { permissionDenied('Microphone needed', 'Allow microphone access to record a voice effect.', canAskAgain); return; }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording: rec } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      setRecording(rec);
    } catch (e) { Alert.alert('Error', e.message); }
  };

  const stopRecord = async () => {
    if (!recording) return;
    await recording.stopAndUnloadAsync();
    const uri = recording.getURI();
    setRecordedUri(uri);
    setRecording(null);
  };

  const playPreview = async () => {
    if (!recordedUri) return;
    try {
      if (soundRef.current) await soundRef.current.unloadAsync();
      const effect = EFFECTS.find(e => e.id === selected);
      const { sound } = await Audio.Sound.createAsync(
        { uri: recordedUri },
        { shouldPlay: true, rate: effect?.rate || 1.0, pitchCorrectionQuality: Audio.PitchCorrectionQuality.High },
        // isLoaded narrows the AVPlaybackStatus union — the error variant has no
        // didJustFinish, so reading it unguarded was undefined at runtime.
        (st) => { if (st.isLoaded && st.didJustFinish) setPlaying(false); }
      );
      soundRef.current = sound;
      setPlaying(true);
    } catch (e) { Alert.alert('Error', e.message); }
  };

  const setForCalls = async (effectId) => {
    setCallEffect(effectId);
    await AsyncStorage.setItem(SETTINGS_KEY, effectId);
    const effect = EFFECTS.find(e => e.id === effectId);
    Alert.alert('Voice Effect Set', effect?.name + ' will be used during calls');
  };

  const currentEffect = EFFECTS.find(e => e.id === selected);

  return (
    <>
      <Stack.Screen options={{
        headerShown: true, /* the root Stack sets headerShown:false app-wide, so the options below were inert and this screen had no back control at all */  title: 'Voice Effects', headerStyle: { backgroundColor: c.card }, headerTintColor: '#1F2937' }} />
      <ScrollView style={s.container}>
        <StatusBar barStyle="light-content" />

        {/* Preview area */}
        <View style={s.previewCard}>
          <Text style={{ fontSize: 40 }}>{currentEffect?.icon}</Text>
          <Text numberOfLines={1} style={[s.effectName, { color: currentEffect?.color }]}>{currentEffect?.name}</Text>
          <Text style={s.effectDesc}>{currentEffect?.desc}</Text>

          {/* Record button */}
          <View style={s.recordRow}>
            {!recording ? (
              <TouchableOpacity style={s.recordBtn} onPress={startRecord}>
                <Text style={s.recordTxt}>{"\uD83C\uDF99\uFE0F Hold to Record"}</Text>
              </TouchableOpacity>
            ) : (
              <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
                <TouchableOpacity style={[s.recordBtn, { backgroundColor: '#FF3C6E' }]} onPress={stopRecord}>
                  <Text style={s.recordTxt}>{"\u23F9 Stop Recording"}</Text>
                </TouchableOpacity>
              </Animated.View>
            )}
          </View>

          {recordedUri && (
            <View style={s.playRow}>
              <TouchableOpacity style={s.playBtn} onPress={playPreview} disabled={playing}>
                <Text style={s.playTxt}>{playing ? '\uD83D\uDD0A Playing...' : '\u25B6\uFE0F Play with Effect'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.useCallBtn} onPress={() => setForCalls(selected)}>
                <Text style={s.useCallTxt}>{"\uD83D\uDCDE Use in Calls"}</Text>
              </TouchableOpacity>
            </View>
          )}

          {callEffect !== 'none' && (
            <View style={s.activeEffect}>
              <Text style={s.activeTxt}>Active for calls: {EFFECTS.find(e => e.id === callEffect)?.icon} {EFFECTS.find(e => e.id === callEffect)?.name}</Text>
            </View>
          )}
        </View>

        {/* Effect grid */}
        <Text style={s.sectionTitle}>CHOOSE EFFECT</Text>
        <View style={s.grid}>
          {EFFECTS.map(e => (
            <TouchableOpacity key={e.id}
              style={[s.effectCard, selected === e.id && { borderColor: e.color, backgroundColor: e.color + '15' }]}
              onPress={() => setSelected(e.id)}>
              <Text style={{ fontSize: 28 }}>{e.icon}</Text>
              <Text numberOfLines={1} style={[s.gridName, selected === e.id && { color: e.color }]}>{e.name}</Text>
              <Text style={s.gridDesc}>{e.desc}</Text>
              {e.id !== 'none' && (
                <View style={s.paramRow}>
                  <Text style={s.paramTxt}>P:{e.pitch}x</Text>
                  <Text style={s.paramTxt}>S:{e.rate}x</Text>
                </View>
              )}
            </TouchableOpacity>
          ))}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </>
  );
}

const makeStyles = (c: Palette, SW: number) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg, padding: 16 },
  previewCard: { backgroundColor: c.card, borderRadius: 20, padding: 24, alignItems: 'center', marginBottom: 16, borderWidth: 1, borderColor: c.border },
  effectName: { fontSize: 22, fontWeight: '900', marginTop: 8 },
  effectDesc: { color: c.textDim, fontSize: 13, marginTop: 4 },
  recordRow: { marginTop: 20 },
  recordBtn: { backgroundColor: '#A78BFA', borderRadius: 30, paddingVertical: 14, paddingHorizontal: 32 },
  recordTxt: { color: c.text, fontSize: 14, fontWeight: '800' },
  playRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  playBtn: { backgroundColor: BRAND_ACCENT, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 16 },
  playTxt: { color: c.text, fontSize: 12, fontWeight: '700' },
  useCallBtn: { backgroundColor: '#4A9FFF22', borderRadius: 12, paddingVertical: 10, paddingHorizontal: 16, borderWidth: 1, borderColor: '#4A9FFF44' },
  useCallTxt: { color: '#4A9FFF', fontSize: 12, fontWeight: '700' },
  activeEffect: { marginTop: 12, backgroundColor: BRAND_ACCENT + '15', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  activeTxt: { color: BRAND_ACCENT, fontSize: 11, fontWeight: '600' },
  sectionTitle: { color: c.textDim, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  effectCard: { width: (SW - 48) / 2, backgroundColor: c.card, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: c.border, alignItems: 'center' },
  gridName: { color: c.text, fontSize: 13, fontWeight: '700', marginTop: 6 },
  gridDesc: { color: c.textDim, fontSize: 10, marginTop: 2, textAlign: 'center' },
  paramRow: { flexDirection: 'row', gap: 8, marginTop: 6 },
  paramTxt: { color: c.textFaint, fontSize: 9, fontWeight: '700' },
});
