// components/shopbook/reports.tsx — Shop Book: owner dashboard, plans and reports.
// Split out of app/shop-book.tsx on 2026-10-04 and edited since (fixes are
// logged per round). Palette and styles come from ./theme.

import { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Alert, RefreshControl, Share, Modal } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';
import { categoryIcon } from '../../constants/shopCategories';
import { formatMoney, shopOpenState, dateLocale } from '../../utils/shopbook';
import * as SB from '../../services/shopBookService';
import { StatTile, TileGrid, ActionGrid, QuickAction, LoadingState, ErrorState } from '../finance/ui';
import { t } from '../../lib/shopbookI18n';
import { C, s } from './theme';
import { Row, SubHeader, StatCard, Empty, Banner } from './shared';
import { useShopLoad } from './useShopLoad';

export function OwnerDashboard({ shop, onSettings, onCoupons, onSuppliers, onPlans, onReports,
                         onPurchases, onReturns, onAudit, onVerify }: {
  shop: SB.Shop; onSettings: () => void; onCoupons: () => void; onSuppliers: () => void;
  onPlans: () => void; onReports: () => void;
  onPurchases: () => void; onReturns: () => void; onAudit: () => void; onVerify: () => void;
}) {
  const [d, setD] = useState<SB.Dashboard | null>(null);
  const [qr, setQr] = useState(false);
  const deepLink = `vaultchat://shop-book?shop=${shop.id}`;
  const { loading, err, load } = useShopLoad(SB.dashboard, setD);
  const st = shopOpenState(shop);

  return (
    <ScrollView contentContainerStyle={s.body}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
      <Modal visible={qr} transparent animationType="fade" onRequestClose={() => setQr(false)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <Text numberOfLines={1} style={s.modalTitle} accessibilityRole="header">{shop.name}</Text>
            <Text style={[s.hint, { textAlign: 'center' }]}>Customers scan this to open your shop</Text>
            <View style={{ alignItems: 'center', marginVertical: 18, backgroundColor: '#FFFFFF', padding: 14, borderRadius: 14 }}>   {/* theme-exempt: a QR needs a real white quiet zone */}
              <QRCode value={deepLink} size={190} color={C.navyFill} backgroundColor="#ffffff" />
            </View>
            <TouchableOpacity style={s.primaryBtn} accessibilityRole="button"
              onPress={() => Share.share({ message: `Order from ${shop.name} on Shop Book 🛍️\n${deepLink}` }).catch(() => {})}>
              <Ionicons name="share-social-outline" size={18} color={C.onFill} />
              <Text style={s.primaryBtnText}>Share shop link</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.dangerBtn} onPress={() => setQr(false)} accessibilityRole="button"><Text style={s.dangerBtnText}>Close</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>

      {!shop.approved && (
        <Banner tone="warn" icon="hourglass-outline" text={t('owner.pendingApproval')} />
      )}

      <TouchableOpacity style={s.card} onPress={onSettings} accessibilityRole="button"
        accessibilityLabel={`${shop.name}, ${shop.plan === 'pro' ? 'Pro' : 'Free'} plan, ${st.label}. Open shop settings`}
        // The QR button inside cannot be reached through this touchable by a
        // screen reader on iOS, so it is offered as an action as well.
        accessibilityActions={[{ name: 'qr', label: 'Show this shop’s QR code' }]}
        onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'qr') setQr(true); }}>
        <View style={s.shopIcon}><Text style={{ fontSize: 22 }}>{categoryIcon(shop.category)}</Text></View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text numberOfLines={1} style={s.cardTitle}>{shop.name}</Text>
            {shop.verified && <Ionicons name="checkmark-circle" size={16} color={C.blue} />}
            <View style={[s.planTag, shop.plan === 'pro' ? s.planPro : s.planFree]}>
              <Text style={[s.planTagText, shop.plan === 'pro' && { color: C.onFill }]}>{shop.plan === 'pro' ? '★ PRO' : 'FREE'}</Text>
            </View>
          </View>
          <Text style={s.cardSub}>
            {shop.ratingCount > 0 ? `⭐ ${shop.rating} (${shop.ratingCount})` : 'No ratings yet'}
          </Text>
          <View style={[s.badge, st.tone === 'open' ? s.badgeOpen : st.tone === 'soon' ? s.badgeSoon : s.badgeClosed]}>
            <Text style={[s.badgeText, st.tone === 'closed' && { color: C.danger }]}>{st.label}</Text>
          </View>
        </View>
        <TouchableOpacity onPress={() => setQr(true)} accessibilityRole="button" accessibilityLabel="Show this shop’s QR code" hitSlop={8} style={{ padding: 4 }}>
          <Ionicons name="qr-code-outline" size={22} color={C.green} />
        </TouchableOpacity>
        <Ionicons name="settings-outline" size={20} color={C.sub} />
      </TouchableOpacity>

      {(shop.lat == null || shop.lng == null) && (
        <TouchableOpacity style={s.locBanner} onPress={onSettings} activeOpacity={0.85} accessibilityRole="button">
          <Ionicons name="location-outline" size={20} color={C.amber} />
          <View style={{ flex: 1 }}>
            <Text style={s.locBannerTitle}>Set your shop location</Text>
            <Text style={s.locBannerSub}>Nearby customers can’t find you or see your distance until you do. Tap to add it.</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={C.amber} />
        </TouchableOpacity>
      )}

      {/* Was a `minWidth: '46%'` wrap — a two-up device assumption wearing
          percentage clothing, which stayed two-up on an 800dp tablet. TileGrid
          derives the column count from the measured window: 2 on a phone, 4
          once there is room. Same four figures, same sources. */}
      {/* A failed load must not read as a quiet day of zeros. */}
      {!!err && !loading && !d && <ErrorState title="Couldn’t load today’s figures" sub={err} onRetry={load} />}
      {(d || !err) && <TileGrid>
        <StatTile label="Today's Orders" value={String(d?.todayOrders ?? 0)} tone="info" />
        <StatTile label="Today's Sales" value={formatMoney(d?.todaySales ?? 0, shop.currency)} tone="good" />
        <StatTile label="Pending Orders" value={String(d?.pendingOrders ?? 0)} tone="warn" />
        <StatTile label="Total Pending" value={formatMoney(d?.totalPending ?? 0, shop.currency)} tone="bad" />
      </TileGrid>}
      {(d?.lowStock ?? 0) > 0 && (
        <Banner tone="warn" icon="alert-circle-outline"
          text={`${d?.lowStock} product(s) need restocking`} />
      )}

      {/* Margin (P1-A). Shown only when the server had a cost basis to compute
          it from, and always alongside how much of the day's revenue that
          covers — a partial figure presented as a whole one is worse than none. */}
      {d?.grossProfit != null && (
        <View style={s.panel}>
          <Text style={s.panelTitle}>{`Today's margin`}</Text>
          <Row label="Cost of goods" value={formatMoney(d.costOfGoods ?? 0, shop.currency)} />
          <Row label="Gross profit" value={formatMoney(d.grossProfit, shop.currency)} bold tone={C.green} />
          {d.marginCoverage && d.marginCoverage.revenueWithCost < d.marginCoverage.revenueTotal && (
            <Text style={s.hint}>
              Covers {formatMoney(d.marginCoverage.revenueWithCost, shop.currency)} of{' '}
              {formatMoney(d.marginCoverage.revenueTotal, shop.currency)} in sales — the rest has no
              recorded purchase cost yet.
            </Text>
          )}
        </View>
      )}
      {d?.grossProfit == null && (d?.todaySales ?? 0) > 0 && (
        <TouchableOpacity style={s.panel} onPress={onPurchases} accessibilityRole="button">
          <Text style={s.hint}>
            Record what your stock costs to see profit here, not just sales.
          </Text>
        </TouchableOpacity>
      )}
      {(d?.todayPurchases ?? 0) > 0 && (
        <View style={s.panel}>
          <Row label={`Purchases today (${d?.todayPurchases})`}
            value={formatMoney(d?.purchaseSpend ?? 0, shop.currency)} />
        </View>
      )}

      {/* Phase 2 quick links. Was two hand-split rows — a 6 + 2 that only
          looked balanced on the phone it was written on. ActionGrid fits as
          many columns as the window genuinely takes (3-6). Every destination
          is unchanged. */}
      <ActionGrid>
        <QuickAction icon="ticket-outline" label="Offers & Coupons" onPress={onCoupons} />
        <QuickAction icon="cart-outline" label="Purchases & cost" onPress={onPurchases} />
        <QuickAction icon="arrow-undo-outline" label="Returns" onPress={onReturns} />
        <QuickAction
          icon="shield-checkmark-outline"
          label={shop.verified ? 'Verified shop' : 'Get verified'}
          onPress={onVerify}
          colors={shop.verified ? [C.blue, C.blue] : undefined}
        />
        <QuickAction icon="document-text-outline" label="Activity log" onPress={onAudit} />
        <QuickAction icon="business-outline" label="Suppliers" onPress={onSuppliers} />
        {/* The padlock stays in the label: it is the only thing telling a free
            shop why the screen it lands on will ask for money. */}
        <QuickAction
          icon="bar-chart-outline"
          label={`Daily Reports${shop.plan !== 'pro' ? ' 🔒' : ''}`}
          onPress={onReports}
        />
        <QuickAction
          icon={shop.plan === 'pro' ? 'star' : 'arrow-up-circle-outline'}
          label={shop.plan === 'pro' ? 'My Plan' : 'Upgrade to Pro'}
          onPress={onPlans}
          colors={shop.plan === 'pro' ? [C.amber, C.amber] : undefined}
        />
      </ActionGrid>
    </ScrollView>
  );
}

export function OwnerPlans({ plan, requestedAt: knownRequestedAt, onBack, onChanged }: {
  plan: 'free' | 'pro'; requestedAt?: string | null; onBack: () => void; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // When the owner asked for Pro. From /my-shop once the server returns it
  // (written, not deployed); until then known only after asking in this visit
  // — the request endpoint returns the FIRST request's time every call.
  const [requestedAt, setRequestedAt] = useState<string | null>(knownRequestedAt ?? null);
  const requestPro = async () => {
    if (busy) return;
    setBusy(true);
    try { setRequestedAt((await SB.requestPro()).requestedAt); }
    catch (e: any) {
      // Today's server has no such route yet: say that, rather than a failure
      // the owner would keep retrying.
      if (SB.notAvailableYet(e)) {
        Alert.alert('Not available yet',
          'Requesting Pro from the app needs a server update that is not live yet. Nothing was sent, and your plan has not changed.');
      } else {
        Alert.alert('Could not send the request', e?.message ?? 'Try again');
      }
    }
    finally { setBusy(false); }
  };
  // Only a downgrade is the owner's to make. Upgrading used to POST 'pro' here,
  // which set a display column the server never gated on (and is now refused):
  // the app showed ★ PRO for an unpaid shop and Pro screens then failed.
  const downgrade = () => Alert.alert(
    'Move to the Free plan?',
    'Pro features such as advanced reports and stock tracking stop working. No data is deleted, and upgrading again restores them.',
    [
      { text: 'Keep Pro', style: 'cancel' },
      { text: 'Move to Free', style: 'destructive', onPress: async () => {
        setBusy(true);
        try { await SB.setPlan('free'); onChanged(); }
        catch (e: any) { Alert.alert('Could not change the plan', e?.message ?? 'Try again'); }
        finally { setBusy(false); }
      } },
    ],
  );
  const FREE = ['1 shop', 'Up to 300 customers', 'Basic ledger (khata)', 'Order management', 'Pending tracking', 'Push notifications'];
  const PRO = ['Unlimited customers', 'Product & inventory management', 'Daily reports & analytics', 'Coupons & offers', 'Payment tracking & reminders', 'Priority support'];
  return (
    <>
      <SubHeader title="Plans" onBack={onBack} />
      <ScrollView contentContainerStyle={s.body}>
        <View style={[s.planCard, plan === 'free' && s.planCardActive]}>
          {/* No price figures: nothing on the server states one, and a hard-coded
              ₹ amount was a promise in one currency to shops billing in others. */}
          <View style={s.row}><Text style={s.planName}>Free</Text><Text style={s.planPer}>No charge</Text></View>
          {FREE.map((f) => <Text key={f} style={s.planFeat}>✓ {f}</Text>)}
          {plan === 'free'
            ? <View style={[s.btn2Tag]}><Text style={s.btn2TagText}>Current plan</Text></View>
            : <TouchableOpacity style={[s.outlineBtn, busy && { opacity: .6 }]} disabled={busy} onPress={downgrade}
                accessibilityRole="button" accessibilityLabel="Downgrade to the Free plan" accessibilityState={{ disabled: busy }}>
                <Text style={s.outlineBtnText}>Downgrade</Text>
              </TouchableOpacity>}
        </View>
        <View style={[s.planCard, s.planCardPro, plan === 'pro' && s.planCardActive]}>
          <View style={s.row}><Text style={[s.planName, { color: C.navy }]}>Pro ⭐</Text><Text style={s.planPer}>Paid monthly</Text></View>
          {PRO.map((f) => <Text key={f} style={s.planFeat}>✓ {f}</Text>)}
          {plan === 'pro'
            ? <View style={[s.btn2Tag]}><Text style={s.btn2TagText}>Current plan</Text></View>
            : (
              <>
                {/* An honest request, not a self-upgrade: it tells the team and
                    grants nothing until the subscription is paid. */}
                {requestedAt ? (
                  <View style={[s.btn2Tag]} accessibilityLiveRegion="polite">
                    <Text style={s.btn2TagText}>
                      Requested on {new Date(requestedAt).toLocaleDateString(dateLocale())}
                    </Text>
                  </View>
                ) : (
                  <TouchableOpacity style={[s.primaryBtn, busy && { opacity: .6 }]} disabled={busy} onPress={requestPro}
                    accessibilityRole="button" accessibilityLabel="Request Pro" accessibilityState={{ disabled: busy, busy }}>
                    <Text style={s.primaryBtnText}>Request Pro</Text>
                  </TouchableOpacity>
                )}
                <Text style={[s.hint, { marginTop: 8 }]}>Requesting Pro lets our team know. Pro is switched on once your subscription is paid, and this screen then shows it as your current plan — nothing changes until then.</Text>
              </>
            )}
        </View>
        <Text style={s.hint}>No card details are collected in the app.</Text>
      </ScrollView>
    </>
  );
}

// Reports (spec: reports-analytics): basic — daily/weekly/monthly sales and
// pending payments — for every plan; the Advanced tab (yearly, tax report,
// best sellers, top customers, product performance) is Pro-gated server-side.
export function OwnerReports({ plan, currency, onBack, onUpgrade }: {
  plan: 'free' | 'pro'; currency?: string; onBack: () => void; onUpgrade: () => void;
}) {
  const [scope, setScope] = useState<'basic' | 'advanced'>('basic');
  const [data, setData] = useState<SB.Reports | null>(null);
  // The server decides what is Pro: the lock shows when IT refuses, never on
  // the client's guess of the plan.
  const [locked, setLocked] = useState(false);
  const money = (n: number) => formatMoney(n, currency || '₹');

  // A Pro refusal is an answer (show the lock), not a load failure. The last
  // scope's figures are cleared first so they never show under the new tab.
  const fetchReports = useCallback(() => {
    setData(null); setLocked(false);
    return SB.reports(scope).then(
      (r) => ({ data: r as SB.Reports | null, locked: false }),
      (e) => { if (SB.needsUpgrade(e)) return { data: null, locked: true }; throw e; });
  }, [scope]);
  const { loading, err, load } = useShopLoad(fetchReports, (r) => { setData(r.data); setLocked(r.locked); },
    { fallback: 'Could not load the reports' });

  return (
    <>
      <SubHeader title={t('owner.reports')} onBack={onBack} />
      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingTop: 10 }} accessibilityRole="tablist">
        {(['basic', 'advanced'] as const).map((sc) => (
          <TouchableOpacity key={sc} style={[s.filterChip, scope === sc && s.filterChipActive]} onPress={() => setScope(sc)}
            accessibilityRole="tab" accessibilityState={{ selected: scope === sc }}>
            <Text style={[s.filterChipText, scope === sc && s.filterChipTextActive]}>
              {sc === 'basic' ? t('owner.reports.basic') : `${t('owner.reports.advanced')}${plan !== 'pro' ? ' 🔒' : ''}`}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {scope === 'advanced' && locked ? (
        <View style={[s.body, { alignItems: 'center', justifyContent: 'center', flex: 1 }]}>
          <Text style={{ fontSize: 44 }}>🔒</Text>
          <Text style={[s.sectionLabel, { marginTop: 12 }]}>{t('owner.reports.upgrade')}</Text>
          <TouchableOpacity style={[s.primaryBtn, { alignSelf: 'stretch' }]} onPress={onUpgrade} accessibilityRole="button"><Text style={s.primaryBtnText}>See plans</Text></TouchableOpacity>
        </View>
      ) : (
        <ScrollView contentContainerStyle={s.body}>
          {loading && <LoadingState />}
          {!!err && <ErrorState title="Could not load the reports" sub={err} onRetry={load} />}
          {data && scope === 'basic' && (
            <>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <StatCard label={t('owner.reports.pendingPayments')} value={money(data.pendingTotal)} tone="danger" />
                <StatCard label="Customers with dues" value={String(data.pendingCustomers)} tone="amber" />
              </View>
              <Bars title="Sales · last 7 days" rows={data.days} money={money} />
              <Bars title="Sales · weekly" rows={data.weeks} money={money} />
              <Bars title="Sales · monthly" rows={data.months} money={money} />
            </>
          )}
          {data && scope === 'advanced' && (
            <>
              <Bars title="Sales · yearly" rows={data.years ?? []} money={money} />
              <Text style={s.sectionLabel}>{t('owner.reports.taxReport')}</Text>
              {(data.taxReport ?? []).length === 0 && <Empty icon="document-text-outline" text="No invoices with tax yet." />}
              {(data.taxReport ?? []).map((m) => (
                <View key={m.month} style={s.card}>
                  <Text style={[s.cardTitle, { flex: 1 }]}>{m.month}</Text>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={s.price}>{money(m.taxCollected)} tax</Text>
                    <Text style={s.cardSub}>on {money(m.taxableSales)}</Text>
                  </View>
                </View>
              ))}
              <Text style={s.sectionLabel}>{t('owner.reports.topProducts')}</Text>
              {(data.topProducts ?? []).map((p, i) => (
                <View key={p.name} style={s.card}>
                  <View style={s.rankDot}><Text style={s.rankDotText}>{i + 1}</Text></View>
                  <Text numberOfLines={1} style={[s.cardTitle, { flex: 1 }]}>{p.name}</Text>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={s.price}>{p.qty} sold</Text>
                    {p.revenue != null && <Text style={s.cardSub}>{money(p.revenue)}</Text>}
                  </View>
                </View>
              ))}
              <Text style={s.sectionLabel}>{t('owner.reports.topCustomers')}</Text>
              {(data.topCustomers ?? []).map((c2, i) => (
                <View key={c2.customerId} style={s.card}>
                  <View style={s.rankDot}><Text style={s.rankDotText}>{i + 1}</Text></View>
                  <Text style={[s.cardTitle, { flex: 1 }]}>{c2.customerName || 'Customer'}</Text>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={s.price}>{money(c2.spent)}</Text>
                    <Text style={s.cardSub}>{c2.orders} order(s)</Text>
                  </View>
                </View>
              ))}
              <Text style={s.sectionLabel}>Product performance · 30 days</Text>
              {(data.productPerformance ?? []).map((p) => (
                <View key={p.name} style={s.card}>
                  <Text numberOfLines={1} style={[s.cardTitle, { flex: 1 }]}>{p.name}</Text>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={s.price}>{p.revenue != null ? money(p.revenue) : ''}</Text>
                    <Text style={s.cardSub}>{p.qty} sold</Text>
                  </View>
                </View>
              ))}
            </>
          )}
        </ScrollView>
      )}
    </>
  );
}

// One sales bar chart. Declared at module level: defined inside OwnerReports it
// was a new component type on every render, so React remounted every chart.
export function Bars({ title, rows, money }: { title: string; rows: SB.ReportDay[]; money: (n: number) => string }) {
  const max = Math.max(1, ...rows.map((d) => d.sales));
  return (
    <>
      <Text numberOfLines={1} style={s.sectionLabel} accessibilityRole="header">{title}</Text>
      {rows.length === 0 && <Empty icon="bar-chart-outline" text="No completed orders yet." />}
      {rows.map((d) => (
        <View key={d.date} style={{ marginBottom: 10 }} accessible
          accessibilityLabel={`${d.date}: ${money(d.sales)}, ${d.orders} order${d.orders === 1 ? '' : 's'}`}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={s.cardSub}>{d.date}</Text>
            <Text style={[s.price, { marginTop: 0 }]}>{money(d.sales)} · {d.orders} order(s)</Text>
          </View>
          <View style={s.barTrack}><View style={[s.barFill, { width: `${Math.round((d.sales / max) * 100)}%` }]} /></View>
        </View>
      ))}
    </>
  );
}
