// app/auto-reply.tsx — Auto-Reply Bot
// Set custom auto-replies when busy
// Schedule-based: work hours, sleep, custom
// Per-contact exceptions

import React, { useState, useEffect , useMemo} from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput,
  StatusBar, Switch, ScrollView, Alert, FlatList,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { Stack } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'vc_auto_reply';

const TEMPLATES = [
  { id: 't1', label: 'In a meeting', msg: "I'm currently in a meeting. I'll get back to you soon!" },
  { id: 't2', label: 'Driving', msg: "I'm driving right now. I'll reply when I stop." },
  { id: 't3', label: 'Sleeping', msg: "I'm asleep right now. I'll reply in the morning!" },
  { id: 't4', label: 'On vacation', msg: "I'm on vacation and may be slow to respond. Thanks for your patience!" },
  { id: 't5', label: 'Busy', msg: "I'm busy at the moment. I'll get back to you as soon as I can." },
  { id: 't6', label: 'Do not disturb', msg: "DND mode is on. For emergencies, call me directly." },
];

const SCHEDULES = [
  { id: 's1', label: 'Always On', desc: 'Auto-reply to every message', icon: '\u267E\uFE0F' },
  { id: 's2', label: 'Work Hours', desc: '9 AM - 6 PM, Mon-Fri', icon: '\uD83D\uDCBC' },
  { id: 's3', label: 'Sleep', desc: '11 PM - 7 AM', icon: '\uD83C\uDF19' },
  { id: 's4', label: 'Weekends', desc: 'Saturday & Sunday', icon: '\uD83C\uDFD6\uFE0F' },
  { id: 's5', label: 'Custom', desc: 'Set your own hours', icon: '\u2699\uFE0F' },
];

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function AutoReplyScreen() {
  const { colors } = useTheme();
  const s = useS();
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState("I'm busy right now. I'll get back to you soon!");
  const [schedule, setSchedule] = useState('s1');
  const [replyOnce, setReplyOnce] = useState(true);
  const [excludeTrusted, setExcludeTrusted] = useState(true);

  useEffect(() => {
    (async () => {
      const saved = await AsyncStorage.getItem(STORAGE_KEY);
      if (saved) {
        const data = JSON.parse(saved);
        setEnabled(data.enabled || false);
        setMessage(data.message || '');
        setSchedule(data.schedule || 's1');
        setReplyOnce(data.replyOnce !== false);
        setExcludeTrusted(data.excludeTrusted !== false);
      }
    })();
  }, []);

  const save = async () => {
    const data = { enabled, message, schedule, replyOnce, excludeTrusted };
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    Alert.alert(enabled ? 'Auto-Reply Active!' : 'Auto-Reply Disabled', enabled ? 'Your auto-reply is now active.' : '');
  };

  const applyTemplate = (tmpl) => {
    setMessage(tmpl.msg);
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Auto-Reply', headerStyle: { backgroundColor: '#FFFFFF' }, headerTintColor: '#1F2937' }} />
      <ScrollView style={s.container}>
        <StatusBar barStyle="light-content" />

        {/* Master toggle */}
        <View style={s.masterCard}>
          <View style={{ flex: 1 }}>
            <Text style={s.masterTitle}>{"\uD83E\uDD16"} Auto-Reply</Text>
            <Text style={s.masterDesc}>{enabled ? 'Active — sending auto-replies' : 'Disabled — manual replies only'}</Text>
          </View>
          <Switch value={enabled} onValueChange={v => { setEnabled(v); }}
            thumbColor={enabled ? colors.primary : '#6B7280'} trackColor={{ false: '#E5E7EB', true: '#10B98144' }} />
        </View>

        {/* Message */}
        <Text style={s.sectionTitle}>YOUR MESSAGE</Text>
        <View style={s.msgBox}>
          <TextInput style={s.msgInput} value={message} onChangeText={setMessage}
            placeholder="Type your auto-reply message..." placeholderTextColor="#6B7280"
            multiline maxLength={500} />
          <Text style={s.charCount}>{message.length}/500</Text>
        </View>

        {/* Templates */}
        <Text style={[s.sectionTitle, { marginTop: 16 }]}>QUICK TEMPLATES</Text>
        <FlatList data={TEMPLATES} horizontal showsHorizontalScrollIndicator={false} keyExtractor={t => t.id}
          renderItem={({ item }) => (
            <TouchableOpacity style={s.templateBtn} onPress={() => applyTemplate(item)}>
              <Text style={s.templateLabel}>{item.label}</Text>
            </TouchableOpacity>
          )}
          contentContainerStyle={{ gap: 8, paddingRight: 16 }}
        />

        {/* Schedule */}
        <Text style={[s.sectionTitle, { marginTop: 16 }]}>SCHEDULE</Text>
        {SCHEDULES.map(sc => (
          <TouchableOpacity key={sc.id}
            style={[s.scheduleRow, schedule === sc.id && s.scheduleActive]}
            onPress={() => setSchedule(sc.id)}>
            <Text style={s.scheduleIcon}>{sc.icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={[s.scheduleName, schedule === sc.id && { color: colors.accent }]}>{sc.label}</Text>
              <Text style={s.scheduleDesc}>{sc.desc}</Text>
            </View>
            {schedule === sc.id && <Text style={{ color: colors.accent }}>{"\u2713"}</Text>}
          </TouchableOpacity>
        ))}

        {/* Settings */}
        <Text style={[s.sectionTitle, { marginTop: 16 }]}>SETTINGS</Text>
        <View style={s.settRow}>
          <View style={{ flex: 1 }}>
            <Text style={s.settName}>Reply Once per Chat</Text>
            <Text style={s.settDesc}>Only auto-reply once per person until you manually reply</Text>
          </View>
          <Switch value={replyOnce} onValueChange={setReplyOnce}
            thumbColor={replyOnce ? colors.accent : '#6B7280'} trackColor={{ false: '#E5E7EB', true: '#4A9FFF44' }} />
        </View>
        <View style={s.settRow}>
          <View style={{ flex: 1 }}>
            <Text style={s.settName}>Exclude Trusted Contacts</Text>
            <Text style={s.settDesc}>Skip auto-reply for your trusted contacts</Text>
          </View>
          <Switch value={excludeTrusted} onValueChange={setExcludeTrusted}
            thumbColor={excludeTrusted ? colors.accent : '#6B7280'} trackColor={{ false: '#E5E7EB', true: '#4A9FFF44' }} />
        </View>

        <TouchableOpacity style={s.saveBtn} onPress={save}>
          <Text style={s.saveTxt}>{"\u2714\uFE0F  Save Auto-Reply"}</Text>
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
    </>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg, padding: 16 },
  masterCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.card, borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#E5E7EB' },
  masterTitle: { color: '#fff', fontSize: 18, fontWeight: '900' },
  masterDesc: { color: '#9CA3AF', fontSize: 12, marginTop: 4 },
  sectionTitle: { color: '#6B7280', fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 8 },
  msgBox: { backgroundColor: c.card, borderRadius: 14, padding: 4, borderWidth: 1, borderColor: '#E5E7EB' },
  msgInput: { color: '#fff', fontSize: 15, padding: 12, minHeight: 80, textAlignVertical: 'top' },
  charCount: { color: '#9CA3AF', fontSize: 10, textAlign: 'right', padding: 8 },
  templateBtn: { backgroundColor: '#4A9FFF22', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderColor: '#4A9FFF33' },
  templateLabel: { color: c.accent, fontSize: 12, fontWeight: '600' },
  scheduleRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.card, borderRadius: 12, padding: 14, marginBottom: 6, borderWidth: 1, borderColor: '#E5E7EB', gap: 12 },
  scheduleActive: { borderColor: '#4A9FFF44', backgroundColor: '#4A9FFF08' },
  scheduleIcon: { fontSize: 20 },
  scheduleName: { color: '#1F2937', fontSize: 14, fontWeight: '700' },
  scheduleDesc: { color: '#6B7280', fontSize: 11, marginTop: 2 },
  settRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.card, borderRadius: 12, padding: 14, marginBottom: 6, borderWidth: 1, borderColor: '#E5E7EB' },
  settName: { color: '#1F2937', fontSize: 13, fontWeight: '700' },
  settDesc: { color: '#6B7280', fontSize: 11, marginTop: 2 },
  saveBtn: { backgroundColor: c.accent, borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 16 },
  saveTxt: { color: '#000', fontSize: 16, fontWeight: '900' },
});
