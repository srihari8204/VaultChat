// @ts-nocheck
// app/smart-notifications.tsx — AI Smart Notification Manager
// Categorizes notifications: Urgent, Important, Social, Low Priority
// Learns from user behavior, supports Do Not Disturb with exceptions

import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet,
  StatusBar, Switch, ScrollView,
} from 'react-native';
import { Stack } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';

const C = { bg: '#020B18', accent: '#4A9FFF', green: '#10B981', card: '#0A1628', danger: '#FF3C6E', purple: '#A78BFA', orange: '#F59E0B' };

const PRIORITY_LEVELS = [
  { id: 'urgent', name: 'Urgent', icon: '\uD83D\uDD34', color: '#FF3C6E', desc: 'Duress alerts, panic, trusted contacts', sound: 'Always ring', override: true },
  { id: 'important', name: 'Important', icon: '\uD83D\uDFE0', color: '#F59E0B', desc: 'Direct messages from frequent contacts', sound: 'Normal sound', override: false },
  { id: 'social', name: 'Social', icon: '\uD83D\uDD35', color: '#4A9FFF', desc: 'Group chats, channels, reactions', sound: 'Soft ping', override: false },
  { id: 'low', name: 'Low Priority', icon: '\u26AA', color: '#666', desc: 'Read receipts, typing indicators, status updates', sound: 'Silent', override: false },
];

const SMART_RULES = [
  { id: 'r1', name: 'Trusted contacts bypass DND', desc: 'Messages from trusted contacts always make sound', enabled: true, priority: 'urgent' },
  { id: 'r2', name: 'Mentions in groups', desc: 'When someone @mentions you in a group', enabled: true, priority: 'important' },
  { id: 'r3', name: 'Repeated messages', desc: 'Same person sends 3+ messages in 5 min', enabled: true, priority: 'important' },
  { id: 'r4', name: 'Keywords alert', desc: 'Messages containing "urgent", "emergency", "help"', enabled: true, priority: 'urgent' },
  { id: 'r5', name: 'Quiet hours', desc: 'Auto-silent 11 PM to 7 AM except urgent', enabled: false, priority: 'low' },
  { id: 'r6', name: 'Focus mode', desc: 'Only urgent notifications during work hours', enabled: false, priority: 'low' },
  { id: 'r7', name: 'Batch social', desc: 'Group social notifications into digest every 30 min', enabled: false, priority: 'social' },
  { id: 'r8', name: 'Auto-categorize new contacts', desc: 'New contacts start as low priority until 5+ messages', enabled: true, priority: 'low' },
];

const SETTINGS_KEY = 'vc_smart_notif_rules';

export default function SmartNotificationsScreen() {
  const [rules, setRules] = useState(SMART_RULES);
  const [dnd, setDnd] = useState(false);
  const [stats] = useState({ urgent: 2, important: 15, social: 47, low: 128 });

  useEffect(() => {
    (async () => {
      const saved = await AsyncStorage.getItem(SETTINGS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        setRules(SMART_RULES.map(r => ({ ...r, enabled: parsed[r.id] ?? r.enabled })));
      }
    })();
  }, []);

  const toggleRule = async (id) => {
    const updated = rules.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r);
    setRules(updated);
    const obj = {};
    updated.forEach(r => obj[r.id] = r.enabled);
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(obj));
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Smart Notifications', headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff' }} />
      <ScrollView style={s.container}>
        <StatusBar barStyle="light-content" />

        {/* AI Summary */}
        <View style={s.summaryCard}>
          <Text style={{ fontSize: 28 }}>{"\uD83E\uDDE0"}</Text>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={s.summaryTitle}>AI Notification Intelligence</Text>
            <Text style={s.summaryDesc}>Automatically categorizes and prioritizes your notifications based on sender, content, and your habits.</Text>
          </View>
        </View>

        {/* Priority Breakdown */}
        <Text style={s.sectionTitle}>TODAY&apos;S BREAKDOWN</Text>
        <View style={s.statsRow}>
          {PRIORITY_LEVELS.map(p => (
            <View key={p.id} style={s.statCard}>
              <Text style={{ fontSize: 20 }}>{p.icon}</Text>
              <Text style={[s.statNum, { color: p.color }]}>{stats[p.id]}</Text>
              <Text style={s.statLabel}>{p.name}</Text>
            </View>
          ))}
        </View>

        {/* Priority Levels */}
        <Text style={[s.sectionTitle, { marginTop: 20 }]}>PRIORITY LEVELS</Text>
        {PRIORITY_LEVELS.map(p => (
          <View key={p.id} style={s.priorityRow}>
            <Text style={{ fontSize: 20, marginRight: 12 }}>{p.icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={[s.priorityName, { color: p.color }]}>{p.name}</Text>
              <Text style={s.priorityDesc}>{p.desc}</Text>
              <Text style={s.prioritySound}>{p.sound}{p.override ? ' (bypasses DND)' : ''}</Text>
            </View>
          </View>
        ))}

        {/* Smart Rules */}
        <Text style={[s.sectionTitle, { marginTop: 20 }]}>AI RULES</Text>
        {rules.map(r => (
          <View key={r.id} style={s.ruleRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.ruleName}>{r.name}</Text>
              <Text style={s.ruleDesc}>{r.desc}</Text>
            </View>
            <Switch value={r.enabled} onValueChange={() => toggleRule(r.id)}
              thumbColor={r.enabled ? C.accent : '#555'} trackColor={{ false: '#222', true: '#4A9FFF44' }} />
          </View>
        ))}

        {/* Do Not Disturb */}
        <Text style={[s.sectionTitle, { marginTop: 20 }]}>DO NOT DISTURB</Text>
        <View style={s.dndCard}>
          <View style={{ flex: 1 }}>
            <Text style={s.dndTitle}>{"\uD83C\uDF19"} Do Not Disturb</Text>
            <Text style={s.dndDesc}>Silence all except urgent. Trusted contacts always ring.</Text>
          </View>
          <Switch value={dnd} onValueChange={setDnd}
            thumbColor={dnd ? C.danger : '#555'} trackColor={{ false: '#222', true: '#FF3C6E44' }} />
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, padding: 16 },
  summaryCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 14, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#111' },
  summaryTitle: { color: '#fff', fontSize: 16, fontWeight: '800' },
  summaryDesc: { color: '#666', fontSize: 12, marginTop: 4, lineHeight: 18 },
  sectionTitle: { color: '#555', fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 8 },
  statsRow: { flexDirection: 'row', gap: 8 },
  statCard: { flex: 1, backgroundColor: C.card, borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: '#111' },
  statNum: { fontSize: 20, fontWeight: '900', marginTop: 4 },
  statLabel: { color: '#666', fontSize: 9, marginTop: 2, fontWeight: '700' },
  priorityRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 12, padding: 14, marginBottom: 6, borderWidth: 1, borderColor: '#111' },
  priorityName: { fontSize: 14, fontWeight: '700' },
  priorityDesc: { color: '#666', fontSize: 11, marginTop: 2 },
  prioritySound: { color: '#444', fontSize: 10, marginTop: 2, fontStyle: 'italic' },
  ruleRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 12, padding: 14, marginBottom: 6, borderWidth: 1, borderColor: '#111' },
  ruleName: { color: '#E0E0F0', fontSize: 13, fontWeight: '700' },
  ruleDesc: { color: '#555', fontSize: 11, marginTop: 2 },
  dndCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FF3C6E10', borderRadius: 14, padding: 16, borderWidth: 1, borderColor: '#FF3C6E22' },
  dndTitle: { color: '#FF3C6E', fontSize: 15, fontWeight: '800' },
  dndDesc: { color: '#888', fontSize: 11, marginTop: 4 },
});
