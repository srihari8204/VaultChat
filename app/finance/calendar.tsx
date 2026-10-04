// app/finance/calendar.tsx — month calendar aggregating every finance due date:
// ledger end-dates, chitti next-auction dates and reminders.

import React, { useCallback, useMemo, useState } from 'react';
import { useFinanceTheme } from '../../components/finance/useFinanceTheme';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { type FinancePalette } from '../../constants/financeTheme';
import { FinHeader, EmptyState, IconBtn, LoadingState, ErrorState } from '../../components/finance/ui';
import { useLoadStatus } from '../../components/finance/useLoad';
import { useMe } from '../../components/finance/useMe';
import { fmtDateTime } from '../../utils/financeFormat';
import { listLedger } from '../../db/ledger';
import { listReminders } from '../../db/reminders';
import { listGroups } from '../../db/chitti';

interface Ev { at: number; label: string; tone: 'good' | 'bad' | 'warn' | 'brand'; }
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

export default function FinanceCalendar() {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const me = useMe();
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [monthIdx, setMonthIdx] = useState(today.getMonth());
  const [selected, setSelected] = useState<number>(today.getDate());
  const [events, setEvents] = useState<Ev[]>([]);
  const { status, begin, done, fail } = useLoadStatus();

  const reload = useCallback(() => {
    if (!me) return;
    begin();
    (async () => {
      const [ledgers, reminders, groups] = await Promise.all([listLedger(me.id), listReminders(me.id), listGroups(me.id)]);
      const evs: Ev[] = [];
      for (const l of ledgers) if (l.end_date) evs.push({ at: l.end_date, label: `${l.name} — ${l.direction === 'lend' ? 'due back' : 'to repay'}`, tone: l.direction === 'lend' ? 'good' : 'bad' });
      for (const r of reminders) if (r.status === 'active') evs.push({ at: r.next_at, label: r.title, tone: 'warn' });
      for (const g of groups) if (g.status === 'active') evs.push({ at: g.start_date + 30 * 86400000, label: `${g.name} — auction`, tone: 'brand' });
      setEvents(evs);
      done();
    })().catch(fail);
  }, [me, begin, done, fail]);
  useFocusEffect(reload);

  const byDay = useMemo(() => {
    const map: Record<string, Ev[]> = {};
    for (const e of events) (map[dayKey(e.at)] ??= []).push(e);
    return map;
  }, [events]);

  // build the month grid (Mon-first)
  const cells = useMemo(() => {
    const first = new Date(year, monthIdx, 1);
    const startDow = (first.getDay() + 6) % 7; // Mon=0
    const days = new Date(year, monthIdx + 1, 0).getDate();
    const arr: (number | null)[] = Array(startDow).fill(null);
    for (let d = 1; d <= days; d++) arr.push(d);
    while (arr.length % 7 !== 0) arr.push(null);
    return arr;
  }, [year, monthIdx]);

  const step = (dir: -1 | 1) => {
    let m = monthIdx + dir, y = year;
    if (m < 0) { m = 11; y -= 1; } if (m > 11) { m = 0; y += 1; }
    setMonthIdx(m); setYear(y); setSelected(1);
  };

  const selectedKey = `${year}-${monthIdx}-${selected}`;
  const dayEvents = [...(byDay[selectedKey] ?? [])].sort((a, b) => a.at - b.at);
  const toneColor = (t: Ev['tone']) => t === 'good' ? FIN.good : t === 'bad' ? FIN.bad : t === 'brand' ? FIN.brandDeep : FIN.warn;

  return (
    <View style={s.screen}>
      <FinHeader title="Calendar" />
      <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>
        {status === 'loading' && <LoadingState label="Loading due dates" />}
        {status === 'error' && (
          <ErrorState title="Could not load due dates" sub="The calendar below may be missing events. Nothing has been lost." onRetry={reload} />
        )}
        <View style={s.monthHead}>
          <IconBtn icon="chevron-back" label="Previous month" onPress={() => step(-1)} />
          <Text style={s.monthTitle}>{MON[monthIdx]} {year}</Text>
          <IconBtn icon="chevron-forward" label="Next month" onPress={() => step(1)} />
        </View>

        <View style={s.wdRow}>{WD.map(w => <Text key={w} style={s.wd}>{w}</Text>)}</View>
        <View style={s.grid}>
          {cells.map((d, i) => {
            if (d === null) return <View key={i} style={s.cell} />;
            const key = `${year}-${monthIdx}-${d}`;
            const has = !!byDay[key];
            const isToday = d === today.getDate() && monthIdx === today.getMonth() && year === today.getFullYear();
            const isSel = d === selected;
            return (
              <TouchableOpacity key={i} style={s.cell} onPress={() => setSelected(d)} accessibilityRole="button" accessibilityState={{ selected: isSel }} accessibilityLabel={`${MON[monthIdx]} ${d}, ${year}${has ? ', events due' : ''}`}>
                <View style={[s.dayWrap, isSel && s.daySel, isToday && !isSel && s.dayToday]}>
                  <Text style={[s.dayTxt, isSel && { color: FIN.onBrand }]}>{d}</Text>
                </View>
                {has && <View style={[s.evDot, { backgroundColor: FIN.brandDeep }]} />}
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={s.section}>{MON[monthIdx]} {selected} · {dayEvents.length} event{dayEvents.length === 1 ? '' : 's'}</Text>
        {dayEvents.length === 0 ? (
          <EmptyState icon="calendar-outline" title="Nothing due" sub="No finance events on this day." />
        ) : dayEvents.map((e, i) => (
          <View key={i} style={s.evRow}>
            <View style={[s.evBar, { backgroundColor: toneColor(e.tone) }]} />
            <View style={{ flex: 1 }}>
              <Text style={s.evLabel}>{e.label}</Text>
              <Text style={s.evTime}>{fmtDateTime(e.at)}</Text>
            </View>
          </View>
        ))}
        <View style={{ height: 30 }} />
      </ScrollView>
    </View>
  );
}

const makeStyles = (FIN: FinancePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  body: { padding: 16, alignSelf: 'center', width: '100%', maxWidth: FIN.contentMax },
  monthHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6 },
  monthTitle: { flex: 1, color: FIN.text, fontSize: 18, fontWeight: '800', textAlign: 'center' },
  wdRow: { flexDirection: 'row', marginTop: 10 },
  wd: { flex: 1, textAlign: 'center', color: FIN.faint, fontSize: 11, fontWeight: '700' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 },
  cell: { width: `${100 / 7}%`, aspectRatio: 1, alignItems: 'center', justifyContent: 'center' },
  dayWrap: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  daySel: { backgroundColor: FIN.brandDeep },
  dayToday: { borderWidth: 1.5, borderColor: FIN.brand },
  dayTxt: { color: FIN.text, fontSize: 14, fontWeight: '600' },
  evDot: { width: 5, height: 5, borderRadius: 3, marginTop: 2 },
  section: { color: FIN.text, fontSize: 15, fontWeight: '800', marginTop: 18, marginBottom: 12 },
  evRow: { flexDirection: 'row', gap: 12, backgroundColor: FIN.card, borderRadius: 12, padding: 13, marginBottom: 9, borderWidth: 1, borderColor: FIN.glassEdge, shadowColor: '#101828', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 2 },
  evBar: { width: 4, borderRadius: 2 },
  evLabel: { color: FIN.text, fontSize: 14, fontWeight: '700' },
  evTime: { color: FIN.sub, fontSize: 12, marginTop: 2 },
});
