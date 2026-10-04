// app/finance/calendar.tsx — month calendar aggregating every finance due date:
// ledger end-dates, one auction per month of each active Lucky Draw group, and
// every occurrence of each reminder (recurring ones expanded into the month).

import React, { useCallback, useMemo, useState } from 'react';
import { useFinanceTheme } from '../../components/finance/useFinanceTheme';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { FIN_SHADOW, type FinancePalette } from '../../constants/financeTheme';
import { FinHeader, EmptyState, IconBtn, LoadingState, ErrorState } from '../../components/finance/ui';
import { useLoadStatus } from '../../components/finance/useLoad';
import { useMe } from '../../components/finance/useMe';
import { fmtDateTime } from '../../utils/financeFormat';
import { listLedger, type LedgerEntry } from '../../db/ledger';
import { listReminders, type Reminder } from '../../db/reminders';
import { listGroups, type ChittiGroup } from '../../db/chitti';
import { auctionDate } from '../../utils/financeRules';
import { historyOccurrences, phoneSkips } from '../../lib/finance/reminderSchedule';
import { isUnscheduled } from '../../components/finance/notifyIds';
import { rebuildRecurringAlertsOnce } from '../../components/finance/retriggerOnce';

/** `key` is stable across reloads; `ref` is what tapping the event opens. */
interface Ev {
  key: string; at: number; label: string; tone: 'good' | 'bad' | 'warn' | 'brand';
  ref: { kind: 'ledger' | 'chitti' | 'reminder'; id: string };
}
interface Data { ledgers: LedgerEntry[]; reminders: Reminder[]; groups: ChittiGroup[] }
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

export default function FinanceCalendar() {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const me = useMe();
  const router = useRouter();
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [monthIdx, setMonthIdx] = useState(today.getMonth());
  const [selected, setSelected] = useState<number>(today.getDate());
  const [data, setData] = useState<Data>({ ledgers: [], reminders: [], groups: [] });
  const { status, begin, done, fail } = useLoadStatus();

  const reload = useCallback(() => {
    if (!me) return;
    begin();
    Promise.all([listLedger(me.id), listReminders(me.id), listGroups(me.id)])
      .then(([ledgers, reminders, groups]) => {
        setData({ ledgers, reminders, groups }); done();
        // The one-time anchored alert rebuild also runs from here, so a user
        // who only opens the Calendar is not left on the old triggers.
        rebuildRecurringAlertsOnce(me.id, reminders)
          .then(async (rebuilt) => { if (rebuilt) { const r = await listReminders(me.id); setData((d) => ({ ...d, reminders: r })); } })
          .catch(() => {});
      })
      .catch(fail);
  }, [me, begin, done, fail]);
  useFocusEffect(reload);

  // Events for the VISIBLE month only: recurring reminders and monthly
  // auctions repeat, so they are expanded into whichever month is on screen.
  const events = useMemo(() => {
    const from = new Date(year, monthIdx, 1).getTime();
    const to = new Date(year, monthIdx + 1, 1).getTime();
    const evs: Ev[] = [];
    for (const l of data.ledgers) {
      if (l.end_date && l.status !== 'completed' && l.end_date >= from && l.end_date < to) {
        evs.push({ key: `l-${l.id}`, at: l.end_date, label: `${l.name} — ${l.direction === 'lend' ? 'due back' : 'to repay'}`,
          tone: l.direction === 'lend' ? 'good' : 'bad', ref: { kind: 'ledger', id: l.id } });
      }
    }
    for (const r of data.reminders) {
      // Counted from the series' anchor, so earlier months show it too; a
      // done reminder keeps the dates it ran on, up to when it was last due.
      const done = r.status !== 'active';
      for (const at of historyOccurrences(r, from, to)) {
        // The phone repeats on the anchor's own day number, so a clamped
        // day (30 Apr for a day-31 series) is due here but gets no alert.
        // A reminder whose alert was never scheduled says so, as its card in
        // Reminders does ("Not scheduled: no phone alert").
        const note = done ? ' (done)' : isUnscheduled(r.freq, r.notif_id) ? ' (no phone alert)' : phoneSkips(r, at) ? ` (no phone alert this ${r.freq === 'yearly' ? 'year' : 'month'})` : '';
        evs.push({ key: `r-${r.id}-${at}`, at, label: `${r.title}${note}`, tone: 'warn', ref: { kind: 'reminder', id: r.id } });
      }
    }
    for (const g of data.groups) {
      if (g.status !== 'active') continue;
      for (let m = 1; m <= g.duration; m++) {
        const at = auctionDate(g.start_date, m);
        if (at >= to) break;
        if (at >= from) evs.push({ key: `g-${g.id}-${m}`, at, label: `${g.name} — auction, month ${m}`, tone: 'brand', ref: { kind: 'chitti', id: g.id } });
      }
    }
    return evs;
  }, [data, year, monthIdx]);

  const openEvent = (e: Ev) => {
    if (e.ref.kind === 'ledger') router.push({ pathname: '/finance/ledger/[id]', params: { id: e.ref.id } });
    else if (e.ref.kind === 'chitti') router.push({ pathname: '/finance/chitti/[id]', params: { id: e.ref.id } });
    else router.push({ pathname: '/finance/reminders', params: { focus: e.ref.id } });
  };

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
          <Text style={s.monthTitle} accessibilityRole="header">{MON[monthIdx]} {year}</Text>
          <IconBtn icon="chevron-forward" label="Next month" onPress={() => step(1)} />
        </View>

        <View style={s.wdRow}>{WD.map(w => <Text key={w} style={s.wd}>{w}</Text>)}</View>
        <View style={s.grid}>
          {cells.map((d, i) => {
            // Blank cells have no identity but their slot; days key by date.
            if (d === null) return <View key={`blank-${i}`} style={s.cell} />;
            const key = `${year}-${monthIdx}-${d}`;
            const has = !!byDay[key];
            const isToday = d === today.getDate() && monthIdx === today.getMonth() && year === today.getFullYear();
            const isSel = d === selected;
            return (
              <TouchableOpacity key={key} style={s.cell} onPress={() => setSelected(d)} accessibilityRole="button" accessibilityState={{ selected: isSel }} accessibilityLabel={`${MON[monthIdx]} ${d}, ${year}${has ? ', events due' : ''}`}>
                <View style={[s.dayWrap, isSel && s.daySel, isToday && !isSel && s.dayToday]}>
                  <Text style={[s.dayTxt, isSel && { color: FIN.onBrand }]}>{d}</Text>
                </View>
                {has && <View style={[s.evDot, { backgroundColor: FIN.brandDeep }]} />}
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={s.section}>{MON[monthIdx]} {selected} · {dayEvents.length} event{dayEvents.length === 1 ? '' : 's'}</Text>
        {/* "Nothing due" is a claim about the data, so only once it is read. */}
        {status === 'ready' && dayEvents.length === 0 ? (
          <EmptyState icon="calendar-outline" title="Nothing due" sub="No finance events on this day." />
        ) : dayEvents.map(e => (
          <TouchableOpacity key={e.key} style={s.evRow} activeOpacity={0.85} onPress={() => openEvent(e)}
            accessibilityRole="button"
            accessibilityLabel={`${e.label}, ${fmtDateTime(e.at)}. Open ${e.ref.kind === 'reminder' ? 'reminder' : e.ref.kind === 'chitti' ? 'group' : 'ledger'}`}>
            <View style={[s.evBar, { backgroundColor: toneColor(e.tone) }]} />
            <View style={{ flex: 1 }}>
              <Text style={s.evLabel}>{e.label}</Text>
              <Text style={s.evTime}>{fmtDateTime(e.at)}</Text>
            </View>
          </TouchableOpacity>
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
  evRow: { flexDirection: 'row', gap: 12, backgroundColor: FIN.card, borderRadius: 12, padding: 13, marginBottom: 9, borderWidth: 1, borderColor: FIN.glassEdge, ...FIN_SHADOW.rest },
  evBar: { width: 4, borderRadius: 2 },
  evLabel: { color: FIN.text, fontSize: 14, fontWeight: '700' },
  evTime: { color: FIN.sub, fontSize: 12, marginTop: 2 },
});
