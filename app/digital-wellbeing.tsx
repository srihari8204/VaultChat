// app/digital-wellbeing.tsx — Digital Wellbeing / Screen Time
// Daily usage chart, stats, heatmap, focus mode, daily limit
// All data from AsyncStorage

import React, { useState, useEffect, useRef , useMemo} from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  Switch, Alert, TextInput, Animated, Easing, Platform, Dimensions,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { useRouter, Stack } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { width: SW } = Dimensions.get('window');

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const STORAGE_KEYS = {
  usage: 'vaultchat_usage_data',
  focusMode: 'vaultchat_focus_mode',
  dailyLimit: 'vaultchat_daily_limit',
};

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function DigitalWellbeingScreen() {
  const { colors } = useTheme();
  const styles = useS();
  const router = useRouter();
  const progressAnim = useRef(new Animated.Value(0)).current;

  // Stats
  const [weeklyData, setWeeklyData] = useState<number[]>([45, 32, 58, 41, 67, 23, 0]);
  const [todayMinutes, setTodayMinutes] = useState(0);
  const [messagesSent, setMessagesSent] = useState(0);
  const [messagesReceived, setMessagesReceived] = useState(0);
  const [callsMade, setCallsMade] = useState(0);
  const [topChats, setTopChats] = useState<{ name: string; count: number }[]>([]);
  const [hourlyData, setHourlyData] = useState<number[]>(Array(24).fill(0));

  // Settings
  const [focusMode, setFocusMode] = useState(false);
  const [focusDuration, setFocusDuration] = useState('30');
  const [dailyLimit, setDailyLimit] = useState('120');
  const [editingLimit, setEditingLimit] = useState(false);

  // Weekly comparison
  const [weeklyChange, setWeeklyChange] = useState(-12);

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    // Animate progress ring
    Animated.timing(progressAnim, {
      toValue: Math.min(todayMinutes / parseInt(dailyLimit || '120'), 1),
      duration: 1200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [todayMinutes, dailyLimit, progressAnim]);

  const loadData = async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEYS.usage);
      if (raw) {
        const data = JSON.parse(raw);
        if (data.weeklyData) setWeeklyData(data.weeklyData);
        if (data.todayMinutes !== undefined) setTodayMinutes(data.todayMinutes);
        if (data.messagesSent !== undefined) setMessagesSent(data.messagesSent);
        if (data.messagesReceived !== undefined) setMessagesReceived(data.messagesReceived);
        if (data.callsMade !== undefined) setCallsMade(data.callsMade);
        if (data.topChats) setTopChats(data.topChats);
        if (data.hourlyData) setHourlyData(data.hourlyData);
        if (data.weeklyChange !== undefined) setWeeklyChange(data.weeklyChange);
      } else {
        // Demo data
        const demoToday = 47;
        setTodayMinutes(demoToday);
        setMessagesSent(34);
        setMessagesReceived(52);
        setCallsMade(3);
        setTopChats([
          { name: 'Alice', count: 28 },
          { name: 'Team Chat', count: 22 },
          { name: 'Bob', count: 15 },
          { name: 'Mom', count: 11 },
          { name: 'Dev Group', count: 8 },
        ]);
        const demoHourly = Array(24).fill(0);
        [8, 9, 10, 12, 13, 14, 17, 18, 19, 20, 21].forEach(h => demoHourly[h] = Math.floor(Math.random() * 10) + 1);
        setHourlyData(demoHourly);
      }

      const savedLimit = await AsyncStorage.getItem(STORAGE_KEYS.dailyLimit);
      if (savedLimit) setDailyLimit(savedLimit);

      const savedFocus = await AsyncStorage.getItem(STORAGE_KEYS.focusMode);
      if (savedFocus) setFocusMode(savedFocus === 'true');
    } catch {}
  };

  const toggleFocusMode = async (val: boolean) => {
    setFocusMode(val);
    await AsyncStorage.setItem(STORAGE_KEYS.focusMode, val.toString());
    if (val) {
      Alert.alert('Focus Mode Enabled', `Notifications muted for ${focusDuration} minutes.`);
    }
  };

  const saveDailyLimit = async () => {
    const mins = parseInt(dailyLimit);
    if (isNaN(mins) || mins < 1) {
      Alert.alert('Invalid', 'Enter a valid number of minutes.');
      return;
    }
    await AsyncStorage.setItem(STORAGE_KEYS.dailyLimit, dailyLimit);
    setEditingLimit(false);
    Alert.alert('Saved', `Daily limit set to ${mins} minutes. You'll be alerted when exceeded.`);
  };

  const formatTime = (mins: number) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  const maxWeekly = Math.max(...weeklyData, 1);
  const limitMins = parseInt(dailyLimit || '120');
  const usagePercent = Math.min(todayMinutes / limitMins, 1);
  const maxHourly = Math.max(...hourlyData, 1);

  // Circular progress
  const ringSize = 160;
  const ringStroke = 10;
  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <LinearGradient colors={['#FFFFFF', '#F9FAFB', '#FFFFFF']} style={StyleSheet.absoluteFill} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backArrow}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Digital Wellbeing</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

        {/* Circular Progress Ring */}
        <View style={styles.ringContainer}>
          <View style={[styles.ring, { width: ringSize, height: ringSize }]}>
            {/* Background ring */}
            <View style={[styles.ringBg, { width: ringSize, height: ringSize, borderRadius: ringSize / 2, borderWidth: ringStroke }]} />
            {/* Progress indicator using animated view */}
            <Animated.View style={[styles.ringProgress, {
              width: ringSize, height: ringSize, borderRadius: ringSize / 2, borderWidth: ringStroke,
              borderColor: usagePercent > 0.8 ? colors.danger : colors.accent,
              borderTopColor: 'transparent',
              borderRightColor: usagePercent > 0.25 ? (usagePercent > 0.8 ? colors.danger : colors.accent) : 'transparent',
              borderBottomColor: usagePercent > 0.5 ? (usagePercent > 0.8 ? colors.danger : colors.accent) : 'transparent',
              borderLeftColor: usagePercent > 0.75 ? (usagePercent > 0.8 ? colors.danger : colors.accent) : 'transparent',
              transform: [{ rotate: '-90deg' }],
            }]} />
            <View style={styles.ringCenter}>
              <Text style={styles.ringTime}>{formatTime(todayMinutes)}</Text>
              <Text style={styles.ringSubtext}>of {formatTime(limitMins)} limit</Text>
            </View>
          </View>
          {usagePercent >= 0.8 && (
            <Text style={styles.warningText}>Approaching your daily limit!</Text>
          )}
        </View>

        {/* Today's Stats */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Today&apos;s Stats</Text>
          <View style={styles.statsGrid}>
            <View style={styles.statCard}>
              <Text style={styles.statIcon}>⏱</Text>
              <Text style={styles.statValue}>{formatTime(todayMinutes)}</Text>
              <Text style={styles.statLabel}>Screen Time</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statIcon}>↗</Text>
              <Text style={styles.statValue}>{messagesSent}</Text>
              <Text style={styles.statLabel}>Sent</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statIcon}>↙</Text>
              <Text style={styles.statValue}>{messagesReceived}</Text>
              <Text style={styles.statLabel}>Received</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statIcon}>📞</Text>
              <Text style={styles.statValue}>{callsMade}</Text>
              <Text style={styles.statLabel}>Calls</Text>
            </View>
          </View>
        </View>

        {/* Weekly comparison */}
        <View style={styles.comparisonCard}>
          <Text style={styles.comparisonIcon}>{weeklyChange < 0 ? '📉' : '📈'}</Text>
          <Text style={styles.comparisonText}>
            You used VaultChat{' '}
            <Text style={{ color: weeklyChange < 0 ? colors.primary : colors.danger, fontWeight: '700' }}>
              {Math.abs(weeklyChange)}% {weeklyChange < 0 ? 'less' : 'more'}
            </Text>
            {' '}than last week
          </Text>
        </View>

        {/* Weekly Bar Chart */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Last 7 Days</Text>
          <View style={styles.barChart}>
            {weeklyData.map((mins, i) => (
              <View key={i} style={styles.barCol}>
                <Text style={styles.barValue}>{mins}m</Text>
                <View style={[styles.bar, { height: Math.max((mins / maxWeekly) * 120, 4), backgroundColor: i === 6 ? colors.accent : colors.accent }]} />
                <Text style={styles.barLabel}>{DAYS[i]}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Hourly Heatmap */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Hourly Activity</Text>
          <View style={styles.heatmap}>
            {HOURS.map(h => {
              const intensity = hourlyData[h] / maxHourly;
              return (
                <View key={h} style={styles.heatCell}>
                  <View style={[styles.heatBox, {
                    backgroundColor: intensity === 0 ? 'rgba(74,159,255,0.05)' :
                      intensity < 0.3 ? 'rgba(0,229,255,0.2)' :
                      intensity < 0.6 ? 'rgba(0,229,255,0.5)' :
                      intensity < 0.8 ? 'rgba(0,229,255,0.7)' : colors.accent,
                  }]} />
                  {h % 4 === 0 && <Text style={styles.heatLabel}>{h}:00</Text>}
                </View>
              );
            })}
          </View>
        </View>

        {/* Most Active Chats */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Most Active Chats</Text>
          {topChats.map((chat, i) => (
            <View key={i} style={styles.chatRow}>
              <View style={styles.chatRank}>
                <Text style={styles.chatRankText}>{i + 1}</Text>
              </View>
              <Text style={styles.chatName}>{chat.name}</Text>
              <View style={styles.chatBarWrap}>
                <View style={[styles.chatBar, { width: `${(chat.count / (topChats[0]?.count || 1)) * 100}%` }]} />
              </View>
              <Text style={styles.chatCount}>{chat.count}</Text>
            </View>
          ))}
        </View>

        {/* Focus Mode */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Focus Mode</Text>
          <View style={styles.focusCard}>
            <View style={styles.focusRow}>
              <View>
                <Text style={styles.focusTitle}>Mute All Notifications</Text>
                <Text style={styles.focusSub}>Silence VaultChat for focused work</Text>
              </View>
              <Switch
                value={focusMode}
                onValueChange={toggleFocusMode}
                trackColor={{ false: 'rgba(255,255,255,0.1)', true: 'rgba(0,229,255,0.3)' }}
                thumbColor={focusMode ? colors.accent : '#6B7280'}
              />
            </View>
            <View style={styles.focusDurationRow}>
              <Text style={styles.focusDurLabel}>Duration (min)</Text>
              <View style={styles.durationBtns}>
                {['15', '30', '60', '120'].map(d => (
                  <TouchableOpacity
                    key={d}
                    style={[styles.durBtn, focusDuration === d && styles.durBtnActive]}
                    onPress={() => setFocusDuration(d)}
                  >
                    <Text style={[styles.durBtnText, focusDuration === d && styles.durBtnTextActive]}>{d}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </View>
        </View>

        {/* Daily Limit */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Daily Limit</Text>
          <View style={styles.limitCard}>
            <Text style={styles.limitDesc}>Get alerted when your screen time exceeds this limit</Text>
            <View style={styles.limitRow}>
              {editingLimit ? (
                <>
                  <TextInput
                    style={styles.limitInput}
                    value={dailyLimit}
                    onChangeText={setDailyLimit}
                    keyboardType="number-pad"
                    autoFocus
                  />
                  <Text style={styles.limitUnit}>minutes</Text>
                  <TouchableOpacity onPress={saveDailyLimit} style={styles.limitSaveBtn}>
                    <Text style={styles.limitSaveText}>Save</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <Text style={styles.limitValue}>{formatTime(parseInt(dailyLimit))}</Text>
                  <TouchableOpacity onPress={() => setEditingLimit(true)} style={styles.limitEditBtn}>
                    <Text style={styles.limitEditText}>Change</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          </View>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: Platform.OS === 'ios' ? 56 : 40, paddingHorizontal: 16, paddingBottom: 14 },
  backBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(74,159,255,0.08)', justifyContent: 'center', alignItems: 'center' },
  backArrow: { color: c.accent, fontSize: 20 },
  headerTitle: { color: '#FFF', fontSize: 18, fontWeight: '700' },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 8 },

  // Ring
  ringContainer: { alignItems: 'center', marginVertical: 20 },
  ring: { justifyContent: 'center', alignItems: 'center' },
  ringBg: { position: 'absolute', borderColor: 'rgba(74,159,255,0.1)' },
  ringProgress: { position: 'absolute' },
  ringCenter: { alignItems: 'center' },
  ringTime: { color: '#FFF', fontSize: 28, fontWeight: '800' },
  ringSubtext: { color: c.textDim, fontSize: 12, marginTop: 2 },
  warningText: { color: c.danger, fontSize: 13, fontWeight: '600', marginTop: 10 },

  // Stats
  section: { marginTop: 24 },
  sectionTitle: { color: '#FFF', fontSize: 16, fontWeight: '700', marginBottom: 12 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  statCard: { width: (SW - 52) / 2, backgroundColor: c.card, borderRadius: 14, padding: 16, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(74,159,255,0.08)' },
  statIcon: { fontSize: 22, marginBottom: 6 },
  statValue: { color: '#FFF', fontSize: 24, fontWeight: '800' },
  statLabel: { color: c.textDim, fontSize: 12, marginTop: 3 },

  // Comparison
  comparisonCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.card, borderRadius: 14, padding: 16, marginTop: 16, borderWidth: 1, borderColor: 'rgba(74,159,255,0.08)' },
  comparisonIcon: { fontSize: 24, marginRight: 12 },
  comparisonText: { color: '#FFF', fontSize: 14, flex: 1, lineHeight: 20 },

  // Bar chart
  barChart: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', height: 160, backgroundColor: c.card, borderRadius: 14, padding: 16, paddingTop: 24, borderWidth: 1, borderColor: 'rgba(74,159,255,0.08)' },
  barCol: { alignItems: 'center', flex: 1 },
  barValue: { color: c.textDim, fontSize: 9, marginBottom: 4 },
  bar: { width: 20, borderRadius: 4, minHeight: 4 },
  barLabel: { color: c.textDim, fontSize: 10, marginTop: 6 },

  // Heatmap
  heatmap: { flexDirection: 'row', flexWrap: 'wrap', backgroundColor: c.card, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: 'rgba(74,159,255,0.08)' },
  heatCell: { alignItems: 'center', marginRight: 2, marginBottom: 4 },
  heatBox: { width: (SW - 80) / 24, height: 20, borderRadius: 3 },
  heatLabel: { color: c.textDim, fontSize: 7, marginTop: 2 },

  // Top chats
  chatRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  chatRank: { width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(74,159,255,0.15)', justifyContent: 'center', alignItems: 'center', marginRight: 10 },
  chatRankText: { color: c.accent, fontSize: 12, fontWeight: '700' },
  chatName: { color: '#FFF', fontSize: 14, width: 90 },
  chatBarWrap: { flex: 1, height: 8, borderRadius: 4, backgroundColor: 'rgba(74,159,255,0.1)', marginHorizontal: 10 },
  chatBar: { height: 8, borderRadius: 4, backgroundColor: c.accent },
  chatCount: { color: c.textDim, fontSize: 13, fontWeight: '600', width: 30, textAlign: 'right' },

  // Focus mode
  focusCard: { backgroundColor: c.card, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: 'rgba(74,159,255,0.08)' },
  focusRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  focusTitle: { color: '#FFF', fontSize: 15, fontWeight: '600' },
  focusSub: { color: c.textDim, fontSize: 12, marginTop: 2 },
  focusDurationRow: { flexDirection: 'row', alignItems: 'center', marginTop: 14, justifyContent: 'space-between' },
  focusDurLabel: { color: c.textDim, fontSize: 13 },
  durationBtns: { flexDirection: 'row', gap: 8 },
  durBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(74,159,255,0.2)' },
  durBtnActive: { borderColor: c.accent, backgroundColor: 'rgba(0,229,255,0.1)' },
  durBtnText: { color: c.textDim, fontSize: 13 },
  durBtnTextActive: { color: c.accent, fontWeight: '600' },

  // Daily limit
  limitCard: { backgroundColor: c.card, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: 'rgba(74,159,255,0.08)' },
  limitDesc: { color: c.textDim, fontSize: 13, marginBottom: 12 },
  limitRow: { flexDirection: 'row', alignItems: 'center' },
  limitValue: { color: '#FFF', fontSize: 22, fontWeight: '800', flex: 1 },
  limitInput: { backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, color: '#FFF', fontSize: 18, fontWeight: '700', width: 80, borderWidth: 1, borderColor: c.accent },
  limitUnit: { color: c.textDim, fontSize: 13, marginLeft: 8, flex: 1 },
  limitSaveBtn: { backgroundColor: c.accent, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  limitSaveText: { color: '#FFF', fontSize: 13, fontWeight: '700' },
  limitEditBtn: { backgroundColor: 'rgba(74,159,255,0.15)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  limitEditText: { color: c.accent, fontSize: 13, fontWeight: '600' },
});
