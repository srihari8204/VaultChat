// app/meeting-scheduler.tsx — Meeting Scheduler with Natural Language Date Parsing
// Stores meetings in AsyncStorage under 'vc_meetings'
// Supports: "tomorrow at 3pm", "next Monday 10am", "Friday 2:30pm", etc.

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput,
  Alert, ActivityIndicator, Keyboard,
  ScrollView,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';

// ── Theme ────────────────────────────────────────────────────────
const C = {
  // bg WAS '#FFFFFF' while every foreground here is white (text, dims, the
  // card fills) — the screen rendered white-on-white and was unusable on a
  // device. The rest of this palette is unmistakably a dark navy design
  // (white text, rgba(255,255,255,..) dims, near-black glass), so the
  // background is what was wrong, not the foregrounds.
  bg: '#0A1628',
  card: '#0F1F35',
  cardBorder: '#1A2744',
  accent: '#4A9FFF',
  purple: '#7C3AED',
  green: '#22C55E',
  danger: '#FF3C6E',
  text: '#FFFFFF',
  textDim: '#8A9BBF',
  inputBg: '#0D1B2A',
};

const STORAGE_KEY = 'vc_meetings';

// ── Day / Month names ────────────────────────────────────────────
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── Natural Language Date Parser ─────────────────────────────────
function parseNaturalDate(input: string): Date | null {
  if (!input || !input.trim()) return null;
  const raw = input.trim().toLowerCase();
  const now = new Date();
  let result: Date | null = null;

  // Helper: set time on a date from "3pm", "10am", "2:30pm", "14:00"
  function applyTime(date: Date, timeStr: string): Date {
    const d = new Date(date);
    // Match "3pm", "3:30pm", "10am", "14:00", "2:30 pm"
    const m = timeStr.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (m) {
      let hours = parseInt(m[1], 10);
      const mins = m[2] ? parseInt(m[2], 10) : 0;
      const period = m[3]?.toLowerCase();
      if (period === 'pm' && hours < 12) hours += 12;
      if (period === 'am' && hours === 12) hours = 0;
      d.setHours(hours, mins, 0, 0);
    }
    return d;
  }

  // Extract time portion from the string
  const timeMatch = raw.match(/(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
  const timeStr = timeMatch ? timeMatch[1] : null;

  // "today"
  if (/\btoday\b/.test(raw)) {
    result = new Date(now);
    if (timeStr) result = applyTime(result, timeStr);
    else result.setHours(now.getHours() + 1, 0, 0, 0);
    return result;
  }

  // "tonight"
  if (/\btonight\b/.test(raw)) {
    result = new Date(now);
    result.setHours(20, 0, 0, 0);
    if (timeStr) result = applyTime(result, timeStr);
    return result;
  }

  // "tomorrow"
  if (/\btomorrow\b/.test(raw)) {
    result = new Date(now);
    result.setDate(result.getDate() + 1);
    if (timeStr) result = applyTime(result, timeStr);
    else result.setHours(10, 0, 0, 0);
    return result;
  }

  // "day after tomorrow"
  if (/\bday after tomorrow\b/.test(raw)) {
    result = new Date(now);
    result.setDate(result.getDate() + 2);
    if (timeStr) result = applyTime(result, timeStr);
    else result.setHours(10, 0, 0, 0);
    return result;
  }

  // "in X hours/minutes/days"
  const inMatch = raw.match(/\bin\s+(\d+)\s+(hour|hr|minute|min|day)s?\b/i);
  if (inMatch) {
    const amount = parseInt(inMatch[1], 10);
    const unit = inMatch[2].toLowerCase();
    result = new Date(now);
    if (unit.startsWith('hour') || unit.startsWith('hr')) {
      result.setHours(result.getHours() + amount);
    } else if (unit.startsWith('min')) {
      result.setMinutes(result.getMinutes() + amount);
    } else if (unit.startsWith('day')) {
      result.setDate(result.getDate() + amount);
      if (timeStr) result = applyTime(result, timeStr);
      else result.setHours(10, 0, 0, 0);
    }
    return result;
  }

  // "next <day>" or just "<day>"
  const dayPattern = /(?:(?:next|this)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i;
  const dayMatch = raw.match(dayPattern);
  if (dayMatch) {
    const targetDay = DAY_NAMES.findIndex(
      d => d.toLowerCase() === dayMatch[1].toLowerCase()
    );
    result = new Date(now);
    const currentDay = result.getDay();
    let daysAhead = targetDay - currentDay;
    // If "next" is explicitly stated, or if the day is today/past, go to next week
    if (daysAhead <= 0 || /\bnext\b/.test(raw)) {
      if (daysAhead <= 0) daysAhead += 7;
      if (/\bnext\b/.test(raw) && daysAhead < 7) daysAhead += 7;
      // Correct: if "next" and daysAhead was already 7+, don't double-add
      if (/\bnext\b/.test(raw) && daysAhead > 13) daysAhead -= 7;
    }
    result.setDate(result.getDate() + daysAhead);
    if (timeStr) result = applyTime(result, timeStr);
    else result.setHours(10, 0, 0, 0);
    return result;
  }

  // "March 20", "Jan 5 at 2pm", "December 25 3:30pm"
  const monthPattern = new RegExp(
    `(${MONTH_NAMES.join('|')}|${MONTH_SHORT.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?`, 'i'
  );
  const monthMatch = raw.match(monthPattern);
  if (monthMatch) {
    const monthIdx = [...MONTH_NAMES, ...MONTH_SHORT].findIndex(
      m => m.toLowerCase() === monthMatch[1].toLowerCase()
    ) % 12;
    const day = parseInt(monthMatch[2], 10);
    result = new Date(now.getFullYear(), monthIdx, day);
    if (result < now) result.setFullYear(result.getFullYear() + 1);
    if (timeStr) result = applyTime(result, timeStr);
    else result.setHours(10, 0, 0, 0);
    return result;
  }

  // Fallback: try native Date.parse
  const parsed = new Date(raw);
  if (!isNaN(parsed.getTime())) return parsed;

  return null;
}

// ── Format helpers ───────────────────────────────────────────────
function formatDateTime(d: Date): string {
  const day = DAY_SHORT[d.getDay()];
  const month = MONTH_SHORT[d.getMonth()];
  const date = d.getDate();
  let hours = d.getHours();
  const mins = d.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  if (hours > 12) hours -= 12;
  if (hours === 0) hours = 12;
  return `${day}, ${month} ${date} at ${hours}:${mins} ${ampm}`;
}

function formatRelative(d: Date): string {
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  if (diffMs < 0) return 'Past';
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `In ${diffMins} min`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `In ${diffHours}h ${diffMins % 60}m`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays < 7) return `In ${diffDays} days`;
  return `In ${Math.floor(diffDays / 7)} week${diffDays >= 14 ? 's' : ''}`;
}

// ── Mini Calendar Component ──────────────────────────────────────
function MiniCalendar({ selected, onSelect }: {
  selected: Date | null;
  onSelect: (d: Date) => void;
}) {
  const [viewDate, setViewDate] = useState(selected || new Date());
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const prevMonth = () => setViewDate(new Date(year, month - 1, 1));
  const nextMonth = () => setViewDate(new Date(year, month + 1, 1));

  const isSelected = (day: number) =>
    selected &&
    selected.getDate() === day &&
    selected.getMonth() === month &&
    selected.getFullYear() === year;

  const isToday = (day: number) =>
    today.getDate() === day &&
    today.getMonth() === month &&
    today.getFullYear() === year;

  const isPast = (day: number) => {
    const d = new Date(year, month, day);
    d.setHours(23, 59, 59);
    return d < today;
  };

  return (
    <View style={s.calendarWrap}>
      {/* Month header */}
      <View style={s.calHeader}>
        <TouchableOpacity onPress={prevMonth} style={s.calNavBtn}>
          <Ionicons name="chevron-back" size={20} color={C.accent} />
        </TouchableOpacity>
        <Text style={s.calMonthLabel}>{MONTH_NAMES[month]} {year}</Text>
        <TouchableOpacity onPress={nextMonth} style={s.calNavBtn}>
          <Ionicons name="chevron-forward" size={20} color={C.accent} />
        </TouchableOpacity>
      </View>

      {/* Day-of-week headers */}
      <View style={s.calRow}>
        {DAY_SHORT.map(d => (
          <Text key={d} style={s.calDayHeader}>{d.substring(0, 2)}</Text>
        ))}
      </View>

      {/* Day cells */}
      <View style={s.calGrid}>
        {cells.map((day, idx) => (
          <TouchableOpacity
            key={idx}
            style={[
              s.calCell,
              day && isSelected(day) && s.calCellSelected,
              day && isToday(day) && !isSelected(day) && s.calCellToday,
            ]}
            disabled={!day || isPast(day)}
            onPress={() => {
              if (day) {
                const d = new Date(year, month, day);
                if (selected) {
                  d.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
                } else {
                  d.setHours(10, 0, 0, 0);
                }
                onSelect(d);
              }
            }}
          >
            {day ? (
              <Text style={[
                s.calCellText,
                isSelected(day) && s.calCellTextSelected,
                isPast(day) && s.calCellTextPast,
              ]}>
                {day}
              </Text>
            ) : null}
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

// ── Time Picker Row ──────────────────────────────────────────────
function TimePicker({ date, onChange }: { date: Date; onChange: (d: Date) => void }) {
  const hours = date.getHours();
  const mins = date.getMinutes();

  const adjust = (field: 'h' | 'm', delta: number) => {
    const d = new Date(date);
    if (field === 'h') d.setHours((hours + delta + 24) % 24);
    else d.setMinutes((mins + delta + 60) % 60);
    onChange(d);
  };

  const displayHour = hours % 12 === 0 ? 12 : hours % 12;
  const ampm = hours >= 12 ? 'PM' : 'AM';

  return (
    <View style={s.timePickerRow}>
      <Text style={s.timeLabel}>Time</Text>
      <View style={s.timeControls}>
        {/* Hour */}
        <View style={s.timeUnit}>
          <TouchableOpacity onPress={() => adjust('h', 1)} style={s.timeArrow}>
            <Ionicons name="chevron-up" size={18} color={C.accent} />
          </TouchableOpacity>
          <Text style={s.timeValue}>{displayHour.toString().padStart(2, '0')}</Text>
          <TouchableOpacity onPress={() => adjust('h', -1)} style={s.timeArrow}>
            <Ionicons name="chevron-down" size={18} color={C.accent} />
          </TouchableOpacity>
        </View>

        <Text style={s.timeColon}>:</Text>

        {/* Minute */}
        <View style={s.timeUnit}>
          <TouchableOpacity onPress={() => adjust('m', 5)} style={s.timeArrow}>
            <Ionicons name="chevron-up" size={18} color={C.accent} />
          </TouchableOpacity>
          <Text style={s.timeValue}>{mins.toString().padStart(2, '0')}</Text>
          <TouchableOpacity onPress={() => adjust('m', -5)} style={s.timeArrow}>
            <Ionicons name="chevron-down" size={18} color={C.accent} />
          </TouchableOpacity>
        </View>

        {/* AM/PM toggle */}
        <TouchableOpacity
          style={s.ampmBtn}
          onPress={() => adjust('h', hours >= 12 ? -12 : 12)}
        >
          <Text style={s.ampmText}>{ampm}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Quick Suggestion Chips ───────────────────────────────────────
const SUGGESTIONS = [
  'Tomorrow 10am',
  'Friday 3pm',
  'Next Monday 9am',
  'Today 5pm',
  'In 2 hours',
  'Next Wednesday 2pm',
];

// ── Main Screen ──────────────────────────────────────────────────
export default function MeetingSchedulerScreen() {
  const router = useRouter();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dateInput, setDateInput] = useState('');
  const [parsedDate, setParsedDate] = useState<Date | null>(null);
  const [meetings, setMeetings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);

  // Load meetings on mount
  useEffect(() => { loadMeetings(); }, []);

  // Re-parse whenever dateInput changes
  useEffect(() => {
    if (dateInput.trim()) {
      const d = parseNaturalDate(dateInput);
      setParsedDate(d);
    } else {
      setParsedDate(null);
    }
  }, [dateInput]);

  const loadMeetings = async () => {
    setLoading(true);
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const all = JSON.parse(raw)
          .map((m: any) => ({ ...m, dateTime: new Date(m.dateTime) }))
          .filter((m: any) => m.dateTime.getTime() > Date.now() - 3600000)
          .sort((a: any, b: any) => a.dateTime.getTime() - b.dateTime.getTime());
        setMeetings(all);
      }
    } catch (e) {
    }
    setLoading(false);
  };

  const saveMeetings = async (list: any[]) => {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  };

  const createEvent = async () => {
    if (!title.trim()) {
      Alert.alert('Missing Title', 'Please enter a meeting title.');
      return;
    }
    if (!parsedDate) {
      Alert.alert('Missing Date', 'Please enter or select a date and time.');
      return;
    }
    if (parsedDate.getTime() < Date.now()) {
      Alert.alert('Past Date', 'The selected date is in the past. Please choose a future date.');
      return;
    }

    setSaving(true);
    try {
      const newMeeting = {
        id: `mtg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        title: title.trim(),
        description: description.trim(),
        dateTime: parsedDate.toISOString(),
        createdAt: new Date().toISOString(),
      };
      const updated = [...meetings, { ...newMeeting, dateTime: parsedDate }]
        .sort((a, b) => a.dateTime.getTime() - b.dateTime.getTime());

      await saveMeetings(updated.map(m => ({
        ...m,
        dateTime: m.dateTime.toISOString(),
      })));

      setMeetings(updated);
      setTitle('');
      setDescription('');
      setDateInput('');
      setParsedDate(null);
      setShowCalendar(false);
      Keyboard.dismiss();
      Alert.alert('Meeting Created', `"${newMeeting.title}" scheduled for ${formatDateTime(parsedDate)}`);
    } catch {
      Alert.alert('Error', 'Failed to save meeting.');
    }
    setSaving(false);
  };

  const deleteMeeting = (id: string) => {
    Alert.alert(
      'Delete Meeting',
      'Are you sure you want to delete this meeting?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: async () => {
            const updated = meetings.filter(m => m.id !== id);
            setMeetings(updated);
            await saveMeetings(updated.map(m => ({
              ...m,
              dateTime: m.dateTime.toISOString(),
            })));
          },
        },
      ]
    );
  };

  const applySuggestion = (text: string) => {
    setDateInput(text);
    const d = parseNaturalDate(text);
    setParsedDate(d);
  };

  // ── Render ───────────────────────────────────────────────────
  return (
    <View style={s.container}>
      <Stack.Screen options={{
        headerShown: true,
        headerStyle: { backgroundColor: C.bg },
        headerTintColor: C.text,
        title: 'Meeting Scheduler',
        headerLeft: () => (
          <TouchableOpacity onPress={() => router.back()} style={{ paddingRight: 12 }}>
            <Ionicons name="arrow-back" size={24} color={C.text} />
          </TouchableOpacity>
        ),
      }} />

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} keyboardShouldPersistTaps="handled">

        {/* ── Title Input ─────────────────────────────────── */}
        <View style={s.section}>
          <Text style={s.label}>Meeting Title</Text>
          <TextInput
            style={s.input}
            placeholder="e.g. Team Standup, Client Call..."
            placeholderTextColor={C.textDim}
            value={title}
            onChangeText={setTitle}
            maxLength={100}
          />
        </View>

        {/* ── Description Input ───────────────────────────── */}
        <View style={s.section}>
          <Text style={s.label}>Description (optional)</Text>
          <TextInput
            style={[s.input, s.inputMultiline]}
            placeholder="Meeting agenda, notes, link..."
            placeholderTextColor={C.textDim}
            value={description}
            onChangeText={setDescription}
            multiline
            maxLength={500}
            numberOfLines={3}
          />
        </View>

        {/* ── Natural Language Date Input ──────────────────── */}
        <View style={s.section}>
          <Text style={s.label}>When?</Text>
          <View style={s.dateInputRow}>
            <TextInput
              style={[s.input, { flex: 1 }]}
              placeholder={`Try "tomorrow at 3pm" or "next Friday 10am"`}
              placeholderTextColor={C.textDim}
              value={dateInput}
              onChangeText={setDateInput}
            />
            <TouchableOpacity
              style={s.calendarToggle}
              onPress={() => setShowCalendar(!showCalendar)}
            >
              <Ionicons
                name={showCalendar ? 'calendar' : 'calendar-outline'}
                size={22}
                color={showCalendar ? C.accent : C.textDim}
              />
            </TouchableOpacity>
          </View>

          {/* Quick suggestion chips */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.chipScroll}>
            {SUGGESTIONS.map(sug => (
              <TouchableOpacity
                key={sug}
                style={[s.chip, dateInput === sug && s.chipActive]}
                onPress={() => applySuggestion(sug)}
              >
                <Text style={[s.chipText, dateInput === sug && s.chipTextActive]}>{sug}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        {/* ── Parsed Date Preview ─────────────────────────── */}
        {parsedDate && (
          <View style={s.previewCard}>
            <Ionicons name="checkmark-circle" size={20} color={C.green} />
            <View style={{ marginLeft: 10, flex: 1 }}>
              <Text style={s.previewDate}>{formatDateTime(parsedDate)}</Text>
              <Text style={s.previewRelative}>{formatRelative(parsedDate)}</Text>
            </View>
          </View>
        )}
        {dateInput.trim() && !parsedDate && (
          <View style={[s.previewCard, { borderColor: C.danger }]}>
            <Ionicons name="alert-circle" size={20} color={C.danger} />
            <Text style={[s.previewDate, { marginLeft: 10, color: C.danger }]}>
              Could not parse date. Try &quot;tomorrow 3pm&quot; or &quot;next Friday&quot;.
            </Text>
          </View>
        )}

        {/* ── Calendar Picker ─────────────────────────────── */}
        {showCalendar && (
          <View style={s.section}>
            <MiniCalendar
              selected={parsedDate}
              onSelect={(d) => {
                setParsedDate(d);
                setDateInput(formatDateTime(d));
              }}
            />
            {parsedDate && (
              <TimePicker
                date={parsedDate}
                onChange={(d) => {
                  setParsedDate(d);
                  setDateInput(formatDateTime(d));
                }}
              />
            )}
          </View>
        )}

        {/* ── Create Event Button ─────────────────────────── */}
        <TouchableOpacity
          onPress={createEvent}
          disabled={saving}
          activeOpacity={0.85}
          style={s.createBtnWrap}
        >
          <LinearGradient
            colors={[C.accent, C.purple]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={s.createBtn}
          >
            {saving ? (
              <ActivityIndicator color={C.text} size="small" />
            ) : (
              <>
                <Ionicons name="calendar-sharp" size={20} color={C.text} />
                <Text style={s.createBtnText}>Create Event</Text>
              </>
            )}
          </LinearGradient>
        </TouchableOpacity>

        {/* ── Upcoming Meetings ───────────────────────────── */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Upcoming Meetings</Text>

          {loading ? (
            <ActivityIndicator color={C.accent} style={{ marginTop: 20 }} />
          ) : meetings.length === 0 ? (
            <View style={s.emptyState}>
              <Ionicons name="calendar-outline" size={48} color={C.textDim} />
              <Text style={s.emptyText}>No meetings scheduled</Text>
              <Text style={s.emptySubtext}>Create your first meeting above</Text>
            </View>
          ) : (
            meetings.map((meeting) => (
              <TouchableOpacity
                key={meeting.id}
                style={s.meetingCard}
                onLongPress={() => deleteMeeting(meeting.id)}
                activeOpacity={0.7}
              >
                <View style={s.meetingDateBadge}>
                  <Text style={s.meetingDateDay}>
                    {meeting.dateTime.getDate()}
                  </Text>
                  <Text style={s.meetingDateMonth}>
                    {MONTH_SHORT[meeting.dateTime.getMonth()]}
                  </Text>
                </View>
                <View style={s.meetingInfo}>
                  <Text style={s.meetingTitle} numberOfLines={1}>
                    {meeting.title}
                  </Text>
                  <Text style={s.meetingTime}>
                    <Ionicons name="time-outline" size={12} color={C.textDim} />
                    {'  '}{formatDateTime(meeting.dateTime)}
                  </Text>
                  {meeting.description ? (
                    <Text style={s.meetingDesc} numberOfLines={2}>
                      {meeting.description}
                    </Text>
                  ) : null}
                  <Text style={s.meetingRelative}>{formatRelative(meeting.dateTime)}</Text>
                </View>
                <Ionicons name="trash-outline" size={16} color={C.textDim} style={{ opacity: 0.5 }} />
              </TouchableOpacity>
            ))
          )}

          {meetings.length > 0 && (
            <Text style={s.hintText}>Long-press a meeting to delete it</Text>
          )}
        </View>

      </ScrollView>
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────
const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 40 },

  section: { paddingHorizontal: 16, marginTop: 16 },
  sectionTitle: { color: C.text, fontSize: 18, fontWeight: '700', marginBottom: 12 },

  label: { color: C.textDim, fontSize: 13, fontWeight: '600', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: {
    backgroundColor: C.inputBg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.cardBorder,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: C.text,
    fontSize: 15,
  },
  inputMultiline: { minHeight: 72, textAlignVertical: 'top' },

  dateInputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  calendarToggle: {
    width: 44, height: 44, borderRadius: 12,
    backgroundColor: C.inputBg, borderWidth: 1, borderColor: C.cardBorder,
    justifyContent: 'center', alignItems: 'center',
  },

  chipScroll: { marginTop: 10 },
  chip: {
    paddingHorizontal: 14, paddingVertical: 8,
    backgroundColor: C.card, borderRadius: 20,
    borderWidth: 1, borderColor: C.cardBorder,
    marginRight: 8,
  },
  chipActive: { backgroundColor: C.accent + '22', borderColor: C.accent },
  chipText: { color: C.textDim, fontSize: 13 },
  chipTextActive: { color: C.accent },

  previewCard: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: 16, marginTop: 12,
    padding: 14, borderRadius: 12,
    backgroundColor: C.card,
    borderWidth: 1, borderColor: C.green + '44',
  },
  previewDate: { color: C.text, fontSize: 15, fontWeight: '600' },
  previewRelative: { color: C.textDim, fontSize: 13, marginTop: 2 },

  // Calendar
  calendarWrap: {
    backgroundColor: C.card, borderRadius: 16, padding: 14,
    borderWidth: 1, borderColor: C.cardBorder,
  },
  calHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  calNavBtn: { padding: 6 },
  calMonthLabel: { color: C.text, fontSize: 16, fontWeight: '700' },
  calRow: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 6 },
  calDayHeader: { color: C.textDim, fontSize: 12, fontWeight: '600', width: 36, textAlign: 'center' },
  calGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  calCell: {
    width: `${100 / 7}%`, aspectRatio: 1,
    justifyContent: 'center', alignItems: 'center',
    borderRadius: 20,
  },
  calCellSelected: { backgroundColor: C.accent },
  calCellToday: { borderWidth: 1, borderColor: C.accent + '66' },
  calCellText: { color: C.text, fontSize: 14 },
  calCellTextSelected: { color: C.text, fontWeight: '700' },
  calCellTextPast: { color: C.textDim + '44' },

  // Time picker
  timePickerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: C.cardBorder,
  },
  timeLabel: { color: C.textDim, fontSize: 13, fontWeight: '600', textTransform: 'uppercase' },
  timeControls: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  timeUnit: { alignItems: 'center' },
  timeArrow: { padding: 4 },
  timeValue: {
    color: C.text, fontSize: 22, fontWeight: '700', width: 40, textAlign: 'center',
    backgroundColor: C.inputBg, borderRadius: 8, paddingVertical: 6,
  },
  timeColon: { color: C.text, fontSize: 22, fontWeight: '700', marginHorizontal: 2 },
  ampmBtn: {
    backgroundColor: C.accent + '22', borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 10, marginLeft: 8,
  },
  ampmText: { color: C.accent, fontSize: 14, fontWeight: '700' },

  // Create button
  createBtnWrap: { marginHorizontal: 16, marginTop: 20 },
  createBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 15, borderRadius: 14,
  },
  createBtnText: { color: C.text, fontSize: 16, fontWeight: '700', marginLeft: 8 },

  // Meeting list
  meetingCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.card, borderRadius: 14,
    borderWidth: 1, borderColor: C.cardBorder,
    padding: 14, marginBottom: 10,
  },
  meetingDateBadge: {
    width: 50, height: 54, borderRadius: 12,
    backgroundColor: C.accent + '18',
    justifyContent: 'center', alignItems: 'center',
    marginRight: 14,
  },
  meetingDateDay: { color: C.accent, fontSize: 22, fontWeight: '800', lineHeight: 26 },
  meetingDateMonth: { color: C.accent, fontSize: 11, fontWeight: '600', textTransform: 'uppercase' },
  meetingInfo: { flex: 1 },
  meetingTitle: { color: C.text, fontSize: 15, fontWeight: '700' },
  meetingTime: { color: C.textDim, fontSize: 12, marginTop: 3 },
  meetingDesc: { color: C.textDim, fontSize: 12, marginTop: 3, fontStyle: 'italic' },
  meetingRelative: { color: C.green, fontSize: 11, fontWeight: '600', marginTop: 4 },

  // Empty state
  emptyState: { alignItems: 'center', paddingVertical: 40 },
  emptyText: { color: C.textDim, fontSize: 16, fontWeight: '600', marginTop: 12 },
  emptySubtext: { color: C.textDim, fontSize: 13, marginTop: 4, opacity: 0.7 },

  hintText: { color: C.textDim, fontSize: 12, textAlign: 'center', marginTop: 8, opacity: 0.6 },
});
