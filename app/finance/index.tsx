// app/finance/index.tsx — Vault Finance Dashboard (the hub's front door).
// Overview totals + health tiles + quick-action grid into every module.

import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, StatusBar } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { FIN } from '../../constants/financeTheme';
import { HeroCard, StatTile, QuickAction } from '../../components/finance/ui';
import { useMe } from '../../components/finance/useMe';
import { inrShort } from '../../utils/financeFormat';
import { listLedger } from '../../db/ledger';
import { listGroups } from '../../db/chitti';
import { listReminders } from '../../db/reminders';
import { round2 } from '../../utils/interest';
import { periodRateToAnnualPct } from '../../utils/finance';

interface Totals {
  lent: number; borrowed: number; earned: number; pending: number;
  active: number; overdue: number; today: number; chitti: number;
}
const ZERO: Totals = { lent: 0, borrowed: 0, earned: 0, pending: 0, active: 0, overdue: 0, today: 0, chitti: 0 };

const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

export default function FinanceDashboard() {
  const router = useRouter();
  const me = useMe();
  const [t, setT] = useState<Totals>(ZERO);

  const reload = useCallback(() => {
    if (!me) return;
    (async () => {
      const [ledgers, groups, reminders] = await Promise.all([
        listLedger(me.id), listGroups(me.id), listReminders(me.id),
      ]);
      const acc = { ...ZERO };
      const todayStart = startOfDay(Date.now());
      const todayEnd = todayStart + 86400000;
      for (const l of ledgers) {
        const annual = periodRateToAnnualPct(l.rate, l.rate_mode, l.period);
        const years = l.end_date ? Math.max(0, (l.end_date - l.start_date) / 31536000000) : 1;
        const interest = round2((l.principal * annual * years) / 100);
        if (l.direction === 'lend') { acc.lent += l.principal; acc.earned += l.status === 'completed' ? interest : 0; acc.pending += l.status === 'completed' ? 0 : interest; }
        else { acc.borrowed += l.principal; }
        if (l.status === 'running') acc.active += 1;
        if (l.status === 'overdue') acc.overdue += 1;
      }
      acc.chitti = groups.filter(g => g.status === 'active').length;
      acc.today = reminders.filter(r => r.status === 'active' && r.next_at >= todayStart && r.next_at < todayEnd).length;
      setT(acc);
    })();
  }, [me]);

  useFocusEffect(reload);

  const go = (path: string) => router.push(path as any);

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="dark-content" backgroundColor={FIN.bg} />
      <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={s.head}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={s.hBtn}>
            <Ionicons name="arrow-back" size={22} color={FIN.text} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={s.brand}>Vault Finance</Text>
            <Text style={s.brandSub}>All money tools in one place</Text>
          </View>
          <TouchableOpacity onPress={() => go('/finance/reminders')} hitSlop={10} style={s.hBtn}>
            <Ionicons name="notifications-outline" size={22} color={FIN.text} />
            {t.today > 0 && <View style={s.badge}><Text style={s.badgeTxt}>{t.today}</Text></View>}
          </TouchableOpacity>
        </View>

        {/* Overview hero */}
        <HeroCard>
          <Text style={s.heroLabel}>TOTAL OVERVIEW · THIS MONTH</Text>
          <View style={s.heroDuo}>
            <View style={{ flex: 1 }}>
              <Text style={s.heroKey}>Total Lent</Text>
              <Text style={s.heroVal}>{inrShort(t.lent)}</Text>
            </View>
            <View style={s.heroDivider} />
            <View style={{ flex: 1 }}>
              <Text style={s.heroKey}>Total Borrowed</Text>
              <Text style={s.heroVal}>{inrShort(t.borrowed)}</Text>
            </View>
          </View>
          <View style={s.heroFoot}>
            <Text style={s.heroFootTxt}>Interest earned {inrShort(t.earned)}</Text>
            <Text style={s.heroFootTxt}>Pending {inrShort(t.pending)}</Text>
          </View>
        </HeroCard>

        {/* Health tiles */}
        <View style={s.tileRow}>
          <StatTile value={String(t.active)} label="Active loans" tone="good" />
          <StatTile value={String(t.overdue)} label="Overdue" tone="bad" />
          <StatTile value={String(t.today)} label="Today's dues" tone="warn" />
          <StatTile value={String(t.chitti)} label="Chitti groups" tone="brand" />
        </View>

        {/* Quick actions */}
        <Text style={s.section}>Quick Actions</Text>
        <View style={s.qaGrid}>
          <QuickAction icon="book" label="Ledger Book" onPress={() => go('/finance/ledger')} colors={[FIN.good, '#0f7a38']} />
          <QuickAction icon="trending-up" label="Interest" onPress={() => go('/finance/interest')} colors={[FIN.brand, FIN.brandDeep]} />
          <QuickAction icon="calculator" label="EMI Calc" onPress={() => go('/finance/emi')} colors={[FIN.info, '#1e40af']} />
          <QuickAction icon="people" label="Chitti Paata" onPress={() => go('/finance/chitti')} colors={['#DB2777', '#9d174d']} />
          <QuickAction icon="notifications" label="Reminders" onPress={() => go('/finance/reminders')} colors={[FIN.warn, '#92400e']} />
          <QuickAction icon="calendar" label="Calendar" onPress={() => go('/finance/calendar')} colors={['#0891B2', '#155e75']} />
          <QuickAction icon="bar-chart" label="Reports" onPress={() => go('/finance/reports')} colors={[FIN.accent, '#5b21b6']} />
          <QuickAction icon="bookmark" label="Saved" onPress={() => go('/finance/saved')} colors={['#475569', '#1e293b']} />
        </View>

        {/* Import / Export */}
        <TouchableOpacity style={s.ioRow} onPress={() => go('/finance/io')} activeOpacity={0.85}>
          <View style={s.ioIcon}><Ionicons name="swap-vertical" size={18} color={FIN.brandDeep} /></View>
          <View style={{ flex: 1 }}>
            <Text style={s.ioTitle}>Import / Export</Text>
            <Text style={s.ioSub}>Back up ledgers &amp; chitti to CSV or Excel</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={FIN.faint} />
        </TouchableOpacity>

        <View style={{ height: 30 }} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  body: { padding: 16, paddingTop: 44 },
  head: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  hBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  brand: { color: FIN.text, fontSize: 22, fontWeight: '800' },
  brandSub: { color: FIN.sub, fontSize: 12.5, marginTop: 1 },
  badge: { position: 'absolute', top: 4, right: 4, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: FIN.bad, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  badgeTxt: { color: '#fff', fontSize: 9, fontWeight: '800' },

  heroLabel: { color: 'rgba(255,255,255,0.8)', fontSize: 10.5, fontWeight: '700', letterSpacing: 0.8 },
  heroDuo: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  heroDivider: { width: 1, height: 40, backgroundColor: 'rgba(255,255,255,0.25)', marginHorizontal: 12 },
  heroKey: { color: 'rgba(255,255,255,0.85)', fontSize: 12 },
  heroVal: { color: '#fff', fontSize: 24, fontWeight: '800', marginTop: 2 },
  heroFoot: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.2)' },
  heroFootTxt: { color: 'rgba(255,255,255,0.9)', fontSize: 12, fontWeight: '600' },

  tileRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  section: { color: FIN.text, fontSize: 16, fontWeight: '800', marginTop: 22, marginBottom: 12 },
  qaGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 16, justifyContent: 'space-between' },

  ioRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: FIN.card, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: FIN.border, marginTop: 22 },
  ioIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: FIN.brandSoft, alignItems: 'center', justifyContent: 'center' },
  ioTitle: { color: FIN.text, fontSize: 14.5, fontWeight: '700' },
  ioSub: { color: FIN.sub, fontSize: 12, marginTop: 1 },
});
