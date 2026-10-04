// app/finance/index.tsx — Vault Finance Dashboard (the hub's front door).
// Overview totals + health tiles + quick-action grid into every module.
//
// Layout is derived from the measured window via lib/finance/grid — the tile
// row and action grid used to be a hardcoded 4-across and a `width: '22%'`,
// both of which are device assumptions. See the 320 / 390 / 744 artboards in
// Figma N5Y6KcMUPA3LgtWjfHPctz.
//
// The data path below is unchanged: same queries, same paise-exact
// accumulation via sumRupees, same totals.

import React, { useCallback, useState } from 'react';
import { useFinanceTheme } from '../../components/finance/useFinanceTheme';
import { useTheme } from '../../lib/theme';
import { View, Text, ScrollView, StyleSheet, StatusBar, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter, useFocusEffect, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TABULAR, FIN_SHADOW, type FinancePalette, HERO_INK } from '../../constants/financeTheme';
import {
  HeroCard, HeroSplit, StatTile, QuickAction, TileGrid, ActionGrid, FinBody, IconBtn, LoadingState, ErrorState,
} from '../../components/finance/ui';
import { useLoadStatus } from '../../components/finance/useLoad';
import { useMe } from '../../components/finance/useMe';
import { inrShort } from '../../utils/financeFormat';
import { listLedger } from '../../db/ledger';
import { listGroups } from '../../db/chitti';
import { listReminders } from '../../db/reminders';
import { sumRupees } from '../../utils/money';
import { ledgerInterest, ledgerInterestSoFar, startOfDay } from '../../utils/financeRules';
import { ledgerCompoundingNote } from '../../lib/finance/compounding';

interface Totals {
  lent: number; borrowed: number; earned: number; pending: number;
  /** Interest accrued to today on open lent loans (to the end date once past it). */
  accrued: number;
  active: number; overdue: number; today: number; chitti: number;
  /** How the summed compound loans compound, or null when none is compound. */
  compounding: string | null;
}
const ZERO: Totals = { lent: 0, borrowed: 0, earned: 0, pending: 0, accrued: 0, active: 0, overdue: 0, today: 0, chitti: 0, compounding: null };

export default function FinanceDashboard() {
  const { scheme } = useTheme();
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const router = useRouter();
  const me = useMe();
  const insets = useSafeAreaInsets();
  const [t, setT] = useState<Totals>(ZERO);
  const { status, begin, done, fail } = useLoadStatus();

  const reload = useCallback(() => {
    if (!me) return;
    begin();
    (async () => {
      const [ledgers, groups, reminders] = await Promise.all([
        listLedger(me.id), listGroups(me.id), listReminders(me.id),
      ]);
      const acc = { ...ZERO };
      const now = Date.now();
      const todayStart = startOfDay(now);
      const todayEnd = todayStart + 86400000;
      // Statuses (overdue, closed) are brought up to date by listLedger /
      // listGroups themselves; the interest is the ledger detail's own
      // calculator, so a compound loan is no longer summed as simple.
      for (const l of ledgers) {
        const { interest } = ledgerInterest(l);
        // Accumulate in paise: `acc.lent += l.principal` over many rows drifts,
        // and these are the headline numbers on the dashboard.
        if (l.direction === 'lend') {
          acc.lent = sumRupees([acc.lent, l.principal]);
          if (l.status === 'completed') acc.earned = sumRupees([acc.earned, interest]);
          else {
            acc.pending = sumRupees([acc.pending, interest]);
            // Accrued so far; null once past the end date, where interest
            // stops (the ledger detail says so), so the full term has accrued.
            acc.accrued = sumRupees([acc.accrued, ledgerInterestSoFar(l, now) ?? interest]);
          }
        } else { acc.borrowed = sumRupees([acc.borrowed, l.principal]); }
        if (l.status === 'running') acc.active += 1;
        if (l.status === 'overdue') acc.overdue += 1;
      }
      acc.chitti = groups.filter(g => g.status === 'active').length;
      acc.compounding = ledgerCompoundingNote(ledgers.filter(l => l.direction === 'lend'));
      acc.today = reminders.filter(r => r.status === 'active' && r.next_at >= todayStart && r.next_at < todayEnd).length;
      setT(acc);
      done();
    })().catch(fail);
  }, [me, begin, done, fail]);

  useFocusEffect(reload);

  const go = (path: Href) => router.push(path);

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'} backgroundColor="transparent" translucent />
      <ScrollView
        contentContainerStyle={[s.scroll, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 32 }]}
        showsVerticalScrollIndicator={false}
      >
        <FinBody>
          {/* Header */}
          <View style={s.head}>
            <IconBtn icon="arrow-back" label="Go back" onPress={() => router.back()} />
            <View style={s.headTitle}>
              <Text style={s.brand} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>
                Vault Finance
              </Text>
              <Text style={s.brandSub} numberOfLines={1}>All money tools in one place</Text>
            </View>
            <IconBtn icon="search" label="Search finance" onPress={() => go('/finance/search')} />
            <View>
              <IconBtn icon="notifications-outline" label={
                t.today > 0 ? `Reminders, ${t.today} due today` : 'Reminders'
              } onPress={() => go('/finance/reminders')} />
              {t.today > 0 && (
                <View style={s.badge} pointerEvents="none">
                  <Text style={s.badgeTxt}>{t.today}</Text>
                </View>
              )}
            </View>
          </View>

          {status === 'loading' && <LoadingState label="Loading your totals" />}
          {status === 'error' && (
            <ErrorState title="Could not load your totals" sub="Your finance data could not be read. Nothing has been lost." onRetry={reload} />
          )}
          {/* Overview hero. Every ledger is summed, whenever it started, so the
              label says ALL TIME; it used to claim THIS MONTH. */}
          {status === 'ready' && (<>
          <HeroCard>
            <Text style={s.heroLabel}>TOTAL OVERVIEW · ALL TIME</Text>
            <View style={{ marginTop: 12 }}>
              <HeroSplit>
                <View>
                  <Text style={s.heroKey}>Total Lent</Text>
                  <Text style={s.heroVal} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                    {inrShort(t.lent)}
                  </Text>
                </View>
                <View>
                  <Text style={s.heroKey}>Total Borrowed</Text>
                  <Text style={s.heroVal} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                    {inrShort(t.borrowed)}
                  </Text>
                </View>
              </HeroSplit>
            </View>
            {/* Full-term figures, not accrued or received interest: each
                ledger's interest to its end date (a 1-year projection when it
                has none) — what ledgerInterest computes. The words say so.
                Lent side only (borrowed interest is not summed), so each line
                says it is interest you earn. */}
            <View style={s.heroFoot}>
              <Text style={s.heroFootTxt} numberOfLines={2}
                accessibilityLabel={`Interest you earn, full term, on settled loans you lent: ${inrShort(t.earned)}`}>
                Interest you earn, settled loans (full term) {inrShort(t.earned)}
              </Text>
              <Text style={s.heroFootTxt} numberOfLines={2}
                accessibilityLabel={`Interest you earn, full term, expected on open loans you lent, to their end dates: ${inrShort(t.pending)}`}>
                Interest you earn, open loans (full term) {inrShort(t.pending)}
              </Text>
            </View>
            <Text style={[s.heroFootTxt, { marginTop: 8 }]} numberOfLines={2}
              accessibilityLabel={`Interest you have earned so far on open loans you lent: ${inrShort(t.accrued)}`}>
              Interest earned so far, open loans {inrShort(t.accrued)}
            </Text>
            {t.compounding && <Text style={s.heroNote} numberOfLines={3} adjustsFontSizeToFit minimumFontScale={0.8}>{t.compounding}</Text>}
          </HeroCard>

          {/* Health tiles */}
          <View style={{ marginTop: 16 }}>
            <TileGrid>
              <StatTile value={String(t.active)} label="Active loans" tone="good" />
              <StatTile value={String(t.overdue)} label="Overdue" tone="bad" />
              <StatTile value={String(t.today)} label="Today's dues" tone="warn" />
              <StatTile value={String(t.chitti)} label="Lucky Draw groups" tone="brand" />
            </TileGrid>
          </View>
          </>)}

          {/* Quick actions */}
          <Text style={s.section}>Quick Actions</Text>
          <ActionGrid>
            <QuickAction icon="book" label="Ledger Book" onPress={() => go('/finance/ledger')} />
            <QuickAction icon="trending-up" label="Interest" onPress={() => go('/finance/interest')} />
            <QuickAction icon="calculator" label="EMI Calc" onPress={() => go('/finance/emi')} />
            <QuickAction icon="people" label="Lucky Draw" onPress={() => go('/finance/chitti')} />
            <QuickAction icon="notifications" label="Reminders" onPress={() => go('/finance/reminders')} />
            <QuickAction icon="calendar" label="Calendar" onPress={() => go('/finance/calendar')} />
            <QuickAction icon="bar-chart" label="Reports" onPress={() => go('/finance/reports')} />
            <QuickAction icon="bookmark" label="Saved" onPress={() => go('/finance/saved')} />
          </ActionGrid>

          {/* Import / Export */}
          <Pressable
            style={({ pressed }) => [s.ioRow, pressed && { opacity: 0.75 }]}
            onPress={() => go('/finance/io')}
            accessibilityRole="button"
            accessibilityLabel="Import and export. Back up ledgers and Lucky Draw to CSV or Excel"
          >
            <View style={s.ioIcon}><Ionicons name="swap-vertical" size={18} color={FIN.brandDeep} /></View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.ioTitle} numberOfLines={1}>Import / Export</Text>
              <Text style={s.ioSub} numberOfLines={1}>Back up ledgers &amp; Lucky Draw</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={FIN.faint} />
          </Pressable>
        </FinBody>
      </ScrollView>
    </View>
  );
}

const makeStyles = (FIN: FinancePalette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: FIN.bg },
  scroll: { paddingHorizontal: 0 },

  head: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 18 },
  headTitle: { flex: 1, minWidth: 0, paddingHorizontal: 8 },
  brand: { color: FIN.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  brandSub: { color: FIN.sub, fontSize: 12.5, marginTop: 1 },
  badge: {
    position: 'absolute', top: 2, right: 2, minWidth: 17, height: 17, borderRadius: 9,
    backgroundColor: FIN.bad, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
    borderWidth: 1.5, borderColor: FIN.bgTop,
  },
  badgeTxt: { color: FIN.onBrand, fontSize: 9.5, fontWeight: '800' },

  // Hero ink: the FIN_HERO gradient is dark in both schemes (HERO_INK, constants/financeTheme).
  heroLabel: { color: HERO_INK.label, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.9 },
  heroKey: { color: HERO_INK.label, fontSize: 12 },
  heroVal: { color: HERO_INK.strong, fontSize: 25, fontWeight: '800', marginTop: 2, letterSpacing: -0.6, ...TABULAR },
  heroFoot: {
    flexDirection: 'row', justifyContent: 'space-between', gap: 12,
    marginTop: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: HERO_INK.rule,
  },
  heroFootTxt: { color: HERO_INK.soft, fontSize: 12, fontWeight: '600', flexShrink: 1, ...TABULAR },
  heroNote: { color: HERO_INK.soft, fontSize: 11.5, marginTop: 8 },

  section: { color: FIN.text, fontSize: 16, fontWeight: '800', marginTop: 24, marginBottom: 14, letterSpacing: -0.2 },

  ioRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 24,
    backgroundColor: FIN.card, borderRadius: 16, padding: 14,
    borderWidth: 1, borderColor: FIN.glassEdge,
    ...FIN_SHADOW.rest,
    minHeight: 44,
  },
  ioIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: FIN.brandSoft, alignItems: 'center', justifyContent: 'center' },
  ioTitle: { color: FIN.text, fontSize: 14.5, fontWeight: '700' },
  ioSub: { color: FIN.sub, fontSize: 12, marginTop: 1 },
});
