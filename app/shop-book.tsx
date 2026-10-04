// app/shop-book.tsx — SHOP BOOK mini-app.
//
// One screen, two modes (Customer / Shop Owner), each with its own bottom-tab
// set — modelled on interest-calculator.tsx. Text-only catalog (no product
// images in MVP). Talks to the Go backend via services/shopBookService.ts.
//
//   Customer : Find shops → shop details → catalog / type-any-product → cart →
//              place order → track; plus Orders list and per-shop Ledger.
//   Owner    : Dashboard, Orders (mark availability / advance status),
//              Products (add/edit/stock), Khata (per-customer ledger), Settings.

import React, { useCallback, useEffect, useState } from 'react';
import { KeyboardSafe } from '../components/ui';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { getCurrentUserAsync } from './(constants)/authService';
import { type CartsByShop, cartFor, withShopCart, type NotificationTarget } from '../utils/shopbook';
import * as SB from '../services/shopBookService';
// The app already owns theming — persisted 'light' | 'dark' | 'system'. Shop
// Book joins it rather than inventing a second switch.
import { useTheme } from '../lib/theme';
import { LoadingState, ErrorState } from '../components/finance/ui';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t, useShopBookLang, initShopBookLang } from '../lib/shopbookI18n';
import { C, s, applyScheme } from '../components/shopbook/theme';
import { loadErrText, TabBar } from '../components/shopbook/shared';
import { FindShops, ProductSearch, ShopFlow, CustomerProfile, NotificationCenter } from '../components/shopbook/customerViews';
import { MyOrders, OrderTrack, OwnerOrders, ReturnsScreen } from '../components/shopbook/orders';
import { OwnerOrderDetail } from '../components/shopbook/orderDetail';
import { CustomerLedgerView, OwnerKhata } from '../components/shopbook/ledger';
import { OwnerDashboard, OwnerPlans, OwnerReports } from '../components/shopbook/reports';
import { OwnerProducts, PurchasesScreen, OwnerCoupons, OwnerSuppliers } from '../components/shopbook/products';
import { ShopSettings } from '../components/shopbook/settings';
import { VerificationScreen, AuditScreen } from '../components/shopbook/verification';
import { useShopLoad } from '../components/shopbook/useShopLoad';

type Mode = 'customer' | 'owner';

type CustTab = 'shops' | 'orders' | 'profile';

type OwnerTab = 'dashboard' | 'orders' | 'products' | 'khata';

// num() now lives in utils/shopbook.ts beside isNum, where it can be tested.

export default function ShopBookScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ shop?: string }>();
  const initialShopId = typeof params.shop === 'string' ? params.shop : undefined;
  const [mode, setMode] = useState<Mode>('customer');
  const [me, setMe] = useState<{ id: string; name: string } | null>(null);
  const [inbox, setInbox] = useState(false);
  const [unread, setUnread] = useState(0);
  // A tapped notification, waiting for the mode's screen to open it. Cleared
  // by that screen once handled, so remounting the mode later cannot replay it.
  const [pending, setPending] = useState<NotificationTarget | null>(null);
  // One cart per shop, so lines picked at shop A can never be posted to shop B.
  // Held here, above the mode switch: CustomerApp unmounts while the Shop Owner
  // side is open, and a cart kept in it was emptied by a look at one's own shop.
  const [carts, setCarts] = useState<CartsByShop>({});
  // Read from the device, never guessed. The header used to hardcode
  // paddingTop: 48, which floats on a short status bar and tucks the title
  // under the clock on a punch-hole phone.
  const insets = useSafeAreaInsets();
  // Install the palette BEFORE any child renders. Reading useTheme() here is
  // what makes this screen re-render on a scheme change; nothing below is
  // memoized, so every descendant re-renders with it and dereferences the
  // freshly-pointed `s` / `C`.
  //
  // Deliberately NOT keyed on the scheme. A key remounts the subtree, which
  // device testing showed drops the user back to the dashboard mid-task — and
  // these phones schedule night mode at 22:00, so a shopkeeper entering a khata
  // line at 10pm would simply lose their place. Re-render is enough; remount is
  // destructive.
  const { scheme } = useTheme();
  applyScheme(scheme === 'dark' ? 'dark' : 'light');
  useShopBookLang(); // re-render on language change

  useEffect(() => { (async () => {
    await initShopBookLang();
    const u = await getCurrentUserAsync().catch(() => null);
    setMe({ id: u?.id ?? 'local', name: u?.name || u?.email || 'You' });
    // Only the bell's badge count. The inbox it opens loads on its own and
    // shows its own error with a retry, so a miss here hides nothing.
    try { setUnread((await SB.notifications()).unread); } catch { /* badge stays 0 */ }
  })(); }, []);

  const clearPending = useCallback(() => setPending(null), []);
  const readOne = useCallback(() => setUnread((n) => Math.max(0, n - 1)), []);
  const openTarget = (target: NotificationTarget) => {
    // An owner-side target needs the owner screens, a customer one the
    // customer screens; the returns list is the owner's.
    setMode(target.kind === 'returns' ? 'owner' : target.side);
    setPending(target);
    setInbox(false);
  };

  return (
    <IceGround>
      <Stack.Screen options={{ headerShown: false }} />
      {/* The inbox sits OVER the app instead of replacing it. Returning early
          here unmounted the screens below, so closing the inbox dropped the
          user back at the top of the mini-app instead of where they were. */}
      {inbox && (
        <View style={[StyleSheet.absoluteFill, { paddingTop: insets.top }]}>
          <NotificationCenter mode={mode} onBack={() => setInbox(false)} onRead={() => setUnread(0)}
            onReadOne={readOne} onOpen={openTarget} />
        </View>
      )}
      <View style={{ flex: 1, display: inbox ? 'none' : 'flex' }}>
        {/* Header + mode toggle */}
        <View style={[s.header, { paddingTop: insets.top + 10 }]}>
          <TouchableOpacity onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Go back" hitSlop={10} style={s.hBtn}>
            <Ionicons name="arrow-back" size={22} color={C.headerFg} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={s.headerTitle}>🛍️ Shop Book</Text>
            <Text style={s.headerSub}>Find shops • Order • Digital Khata</Text>
          </View>
          <TouchableOpacity onPress={() => setInbox(true)} hitSlop={10} style={s.hBtn} accessibilityRole="button"
            accessibilityLabel={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}>
            <Ionicons name="notifications-outline" size={22} color={C.headerFg} />
            {unread > 0 && <View style={s.cartBadge}><Text style={s.cartBadgeText}>{unread > 9 ? '9+' : unread}</Text></View>}
          </TouchableOpacity>
        </View>
        <View style={s.modeRow} accessibilityRole="tablist">
          {(['customer', 'owner'] as Mode[]).map((m) => (
            <TouchableOpacity key={m} onPress={() => setMode(m)}
              accessibilityRole="tab" accessibilityState={{ selected: mode === m }}
              style={[s.modeBtn, mode === m && s.modeBtnActive]}>
              <Ionicons name={m === 'customer' ? 'person' : 'storefront'} size={15}
                color={mode === m ? C.onFill : C.green} />
              <Text style={[s.modeText, mode === m && s.modeTextActive]}>
                {m === 'customer' ? 'Customer' : 'Shop Owner'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {mode === 'customer'
          ? <CustomerApp me={me} initialShopId={initialShopId} carts={carts} setCarts={setCarts}
              openOrder={pending?.kind === 'order' && pending.side === 'customer' ? pending.orderId : null}
              onOpened={clearPending} />
          : <OwnerApp me={me} open={pending} onOpened={clearPending} />}
      </View>
    </IceGround>
  );
}

/**
 * The ice ground, rendered ONCE for the whole mini-app.
 *
 * Shop Book is a flat route (app/shop-book.tsx), so there is no _layout to hang
 * this on and adding one would mean turning the route into a directory —
 * `vaultchat://shop-book?shop=` deep links must keep resolving, so we don't.
 * Rendering the gradient here costs nothing extra: every screen below already
 * draws on a transparent C.bg, so the gradient IS their background.
 */
function IceGround({ children }: { children: React.ReactNode }) {
  return (
    <View style={s.screen}>
      <LinearGradient
        colors={[C.groundTop, C.groundMid, C.groundBottom]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      {children}
    </View>
  );
}

// ════════════════════════════════════════════════════════════════
//  CUSTOMER
// ════════════════════════════════════════════════════════════════
function CustomerApp({ me, initialShopId, carts, setCarts, openOrder, onOpened }: {
  me: { id: string; name: string } | null; initialShopId?: string;
  carts: CartsByShop; setCarts: React.Dispatch<React.SetStateAction<CartsByShop>>;
  openOrder: string | null; onOpened: () => void;
}) {
  const [tab, setTab] = useState<CustTab>('shops');
  // drill-down within the Shops tab
  const [selShop, setSelShop] = useState<SB.Shop | null>(null);
  const [trackId, setTrackId] = useState<string | null>(null);
  const [ledgerShop, setLedgerShop] = useState<SB.Shop | null>(null);
  const [productSearch, setProductSearch] = useState(false);
  // Phase 2 — favorites shared across screens
  const [favIds, setFavIds] = useState<Set<string>>(new Set());

  // The heart is a TOGGLE on the server, so an unknown favourite state is not
  // "none": tapping a heart that wrongly reads empty would remove the shop.
  const [favErr, setFavErr] = useState(false);
  const loadFavs = useCallback(async () => {
    try { const list = await SB.favorites(); setFavIds(new Set(list.map((sh) => sh.id))); setFavErr(false); }
    catch { setFavErr(true); }
  }, []);
  useEffect(() => { loadFavs(); }, [loadFavs]);

  // Deep link / QR: open a specific shop on first mount.
  useEffect(() => { (async () => {
    if (!initialShopId) return;
    try { const sh = await SB.shopDetails(initialShopId); setTab('shops'); setSelShop(sh); }
    catch (e: any) { Alert.alert('Couldn’t open that shop', e?.message ?? 'Check your connection and try again.'); }
  })(); }, [initialShopId]);

  const toggleFav = useCallback(async (shopId: string) => {
    // optimistic
    setFavIds((prev) => {
      const n = new Set(prev);
      if (n.has(shopId)) n.delete(shopId); else n.add(shopId);
      return n;
    });
    try { await SB.toggleFavorite(shopId); }
    catch (e: any) { Alert.alert('Couldn’t update favourites', loadErrText(e)); loadFavs(); }
  }, [loadFavs]);

  const openTrack = (id: string) => { setTrackId(id); };

  // From the inbox: the order a notification is about.
  useEffect(() => {
    if (!openOrder) return;
    setTab('orders'); setSelShop(null); setLedgerShop(null); setProductSearch(false);
    setTrackId(openOrder);
    onOpened();
  }, [openOrder, onOpened]);

  return (
    <>
      <KeyboardSafe style={{ flex: 1 }} >
        {tab === 'shops' && !selShop && !ledgerShop && !productSearch && (
          <FindShops onOpen={(sh) => { setSelShop(sh); }} favIds={favIds} onToggleFav={toggleFav}
            favErr={favErr} onRetryFavs={loadFavs}
            onProductSearch={() => setProductSearch(true)} />
        )}
        {tab === 'shops' && productSearch && !selShop && (
          <ProductSearch onBack={() => setProductSearch(false)}
            onOpenShop={async (shopId) => {
              try { const sh = await SB.shopDetails(shopId); setProductSearch(false); setSelShop(sh); }
              catch (e: any) { Alert.alert('Error', e?.message ?? 'Could not open shop'); }
            }} />
        )}
        {tab === 'shops' && selShop && !ledgerShop && (
          <ShopFlow
            shop={selShop} cart={cartFor(carts, selShop.id)}
            setCart={(c) => setCarts((prev) => withShopCart(prev, selShop.id, c))}
            onBack={() => setSelShop(null)}
            onPlaced={(id) => {
              const placedAt = selShop.id;
              setCarts((prev) => withShopCart(prev, placedAt, []));
              setSelShop(null); setTab('orders'); openTrack(id);
            }}
            onLedger={() => setLedgerShop(selShop)}
            isFav={favIds.has(selShop.id)} onToggleFav={() => toggleFav(selShop.id)}
          />
        )}
        {tab === 'shops' && ledgerShop && (
          <CustomerLedgerView shop={ledgerShop} onBack={() => setLedgerShop(null)} />
        )}

        {tab === 'orders' && (
          trackId
            ? <OrderTrack orderId={trackId} onBack={() => setTrackId(null)} />
            : <MyOrders onOpen={openTrack} />
        )}

        {tab === 'profile' && <CustomerProfile me={me} />}
      </KeyboardSafe>

      <TabBar
        tabs={[
          { id: 'shops', label: t('tab.shops'), icon: 'storefront' },
          { id: 'orders', label: t('tab.orders'), icon: 'receipt' },
          { id: 'profile', label: t('tab.profile'), icon: 'person-circle' },
        ]}
        active={tab}
        onChange={(t) => { setTab(t as CustTab); setSelShop(null); setLedgerShop(null); setTrackId(null); setProductSearch(false); }}
      />
    </>
  );
}

// ════════════════════════════════════════════════════════════════
//  SHOP OWNER
// ════════════════════════════════════════════════════════════════
function OwnerApp({ me, open, onOpened }: {
  me: { id: string; name: string } | null;
  open: NotificationTarget | null; onOpened: () => void;
}) {
  const [tab, setTab] = useState<OwnerTab>('dashboard');
  const [shop, setShop] = useState<SB.Shop | null>(null);
  // When the owner asked for Pro, if the server says (see myShopAccount).
  const [proRequestedAt, setProRequestedAt] = useState<string | null>(null);
  // An order opened from the inbox, over whichever tab is showing.
  const [orderOpen, setOrderOpen] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [sub, setSub] = useState<
    'coupons' | 'suppliers' | 'plans' | 'reports'
    | 'purchases' | 'returns' | 'audit' | 'verify' | null>(null);

  // A FAILED LOOKUP IS NOT "NO SHOP" (2026-09-17).
  //
  // myShop() legitimately resolves null when the user has no shop, so the empty
  // `catch {}` made a 401 or a timeout indistinguishable from it. On a flaky
  // connection an existing owner was dropped into the blank Create-Shop form
  // with NO cancel (onCancel is undefined when shop is null) — and pressing
  // Create POSTs the empty form to the same endpoint, OVERWRITING their real
  // shop name, hours, address, country and tax config.
  const { loading, err: loadErr, load } = useShopLoad(fetchOwnerShop, (r) => {
    setShop(r.shop); setProRequestedAt(r.proRequestedAt ?? null);
  }, { fallback: 'Could not reach your shop' });

  // From the inbox: an order (over the current tab) or the returns list.
  useEffect(() => {
    if (!open) return;
    // An order opened earlier would otherwise stay on top of the returns list.
    if (open.kind === 'returns') { setOrderOpen(null); setSub('returns'); }
    else if (open.side === 'owner') { setSub(null); setOrderOpen(open.orderId); }
    else return;   // a customer-side target is CustomerApp's
    onOpened();
  }, [open, onOpened]);

  if (loading) return <LoadingState />;

  // Lookup FAILED: say so and offer a retry. Never fall through to the create
  // form — that is the path that overwrites a real shop.
  if (loadErr && !shop) {
    return (
      <View style={[s.screen, { alignItems: 'center', justifyContent: 'center', padding: 28 }]}>
        <ErrorState title="Couldn’t load your shop" sub={loadErr} onRetry={load} />
      </View>
    );
  }

  // An order or the returns list opened from the inbox (or the returns list
  // from the dashboard).
  const opened = !shop ? null
    : orderOpen ? <OwnerOrderDetail orderId={orderOpen} onBack={() => setOrderOpen(null)} />
    : sub === 'returns' ? <ReturnsScreen currency={shop.currency} onBack={() => setSub(null)} />
    : null;

  // No shop yet → force settings/create.
  if (!shop || settings) {
    // Something opened from the inbox shows OVER Shop Settings. Settings stays
    // mounted, hidden, so its unsaved edits survive and Back returns to them;
    // before, the opened order rendered behind Settings and never showed.
    return (
      <>
        {opened}
        <View style={{ flex: 1, display: opened ? 'none' : 'flex' }}>
          <ShopSettings shop={shop} me={me}
            onSaved={(sh) => { setShop((prev) => ({ ...sh, plan: prev?.plan ?? 'free' })); setSettings(false); }}
            onCancel={shop ? () => setSettings(false) : undefined}
          />
        </View>
      </>
    );
  }

  if (opened) return opened;
  if (sub === 'coupons') return <OwnerCoupons currency={shop.currency} onBack={() => setSub(null)} />;
  if (sub === 'suppliers') return <OwnerSuppliers onBack={() => setSub(null)} />;
  if (sub === 'purchases') return <PurchasesScreen currency={shop.currency} onBack={() => { setSub(null); load(); }} />;
  if (sub === 'audit') return <AuditScreen onBack={() => setSub(null)} />;
  if (sub === 'verify') return <VerificationScreen onBack={() => { setSub(null); load(); }} />;
  if (sub === 'plans') return <OwnerPlans plan={shop.plan} requestedAt={proRequestedAt} onBack={() => setSub(null)} onChanged={() => { setSub(null); load(); }} />;
  if (sub === 'reports') return <OwnerReports plan={shop.plan} currency={shop.currency} onBack={() => setSub(null)} onUpgrade={() => setSub('plans')} />;

  return (
    <>
      <KeyboardSafe style={{ flex: 1 }} >
        {tab === 'dashboard' && (
          <OwnerDashboard shop={shop} onSettings={() => setSettings(true)}
            onCoupons={() => setSub('coupons')} onSuppliers={() => setSub('suppliers')}
            onPlans={() => setSub('plans')} onReports={() => setSub('reports')}
            onPurchases={() => setSub('purchases')} onReturns={() => setSub('returns')}
            onAudit={() => setSub('audit')} onVerify={() => setSub('verify')} />
        )}
        {tab === 'orders' && <OwnerOrders />}
        {tab === 'products' && <OwnerProducts shop={shop} />}
        {tab === 'khata' && <OwnerKhata currency={shop.currency} />}
      </KeyboardSafe>
      <TabBar
        tabs={[
          { id: 'dashboard', label: t('tab.dashboard'), icon: 'grid' },
          { id: 'orders', label: t('tab.orders'), icon: 'receipt' },
          { id: 'products', label: t('tab.products'), icon: 'pricetags' },
          { id: 'khata', label: t('tab.khata'), icon: 'book' },
        ]}
        active={tab}
        onChange={(t) => setTab(t as OwnerTab)}
      />
    </>
  );
}

// Shop.plan is a display column; PRO shows only for what the server's
// entitlement says. A server that already returns the entitled plan with the
// shop saves the second request; otherwise it is read from the basic report.
// An unconfirmed plan reads as Free, and every Pro feature is still gated
// server-side either way.
async function fetchOwnerShop() {
  const r = await SB.myShopAccount();
  if (!r.shop) return { shop: null, proRequestedAt: r.proRequestedAt };
  const plan = r.entitledPlan ?? await SB.entitledPlan().catch(() => 'free' as const);
  return { shop: { ...r.shop, plan }, proRequestedAt: r.proRequestedAt };
}
