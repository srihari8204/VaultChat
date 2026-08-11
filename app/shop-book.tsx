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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet,
  Alert, ActivityIndicator, RefreshControl, Switch, Platform, KeyboardAvoidingView, Share, Modal,
  Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import * as Location from 'expo-location';
import Voice, { type SpeechResultsEvent } from '@react-native-voice/voice';
import QRCode from 'react-native-qrcode-svg';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { getCurrentUserAsync } from './(constants)/authService';
import { navigateTo } from '../lib/nav/openNavigation';
import { SHOP_CATEGORIES, categoryIcon, categoryLabel } from '../constants/shopCategories';
import {
  formatINR, formatMoney, formatDistance, shopOpenState, orderStatusLabel, orderProgress,
  nextOrderStatus, cartTotal, clientKey, ORDER_STEPS,
  canCustomerCancel, canOwnerCancel, REJECT_REASONS,
  canCustomerCollect, notCollectedGate, isTerminalFailure,
  couponDiscount, couponLabel, starText, loyaltyTier, parseBulkProducts,
  type CartItem, type OrderStatus, type ItemAvailability,
} from '../utils/shopbook';
import * as SB from '../services/shopBookService';
import { listShopLists, saveShopList, deleteShopList, type ShopList } from '../db/shopLists';
import {
  t, useShopBookLang, initShopBookLang, setShopBookLang, SB_LANGUAGES,
} from '../lib/shopbookI18n';

// ── palette (green + navy, from the SHOP BOOK poster) ──────────────
const C = {
  green: '#0B7A3B', greenDark: '#075E54', greenSoft: '#DCFCE7',
  navy: '#1E3A5F', bg: '#F3F4F6', card: '#FFFFFF', border: '#E5E7EB',
  line: '#EEF0F3', text: '#111827', sub: '#6B7280', danger: '#DC2626',
  amber: '#D97706', blue: '#1D4ED8',
};

type Mode = 'customer' | 'owner';
type CustTab = 'shops' | 'orders' | 'profile';
type OwnerTab = 'dashboard' | 'orders' | 'products' | 'khata';

const num = (s: string) => { const n = Number(s); return Number.isFinite(n) ? n : 0; };

export default function ShopBookScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ shop?: string }>();
  const initialShopId = typeof params.shop === 'string' ? params.shop : undefined;
  const [mode, setMode] = useState<Mode>('customer');
  const [me, setMe] = useState<{ id: string; name: string } | null>(null);
  const [inbox, setInbox] = useState(false);
  const [unread, setUnread] = useState(0);
  useShopBookLang(); // re-render on language change

  useEffect(() => { (async () => {
    await initShopBookLang();
    const u = await getCurrentUserAsync().catch(() => null);
    setMe({ id: u?.id ?? 'local', name: u?.name ?? u?.email ?? 'You' });
    try { setUnread((await SB.notifications()).unread); } catch {}
  })(); }, []);

  if (inbox) {
    return (
      <View style={s.screen}>
        <Stack.Screen options={{ headerShown: false }} />
        <NotificationCenter onBack={() => setInbox(false)} onRead={() => setUnread(0)} />
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      {/* Header + mode toggle */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={s.hBtn}>
          <Ionicons name="arrow-back" size={22} color="#fff" />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>🛍️ Shop Book</Text>
          <Text style={s.headerSub}>Find shops • Order • Digital Khata</Text>
        </View>
        <TouchableOpacity onPress={() => setInbox(true)} hitSlop={10} style={s.hBtn}>
          <Ionicons name="notifications-outline" size={22} color="#fff" />
          {unread > 0 && <View style={s.cartBadge}><Text style={s.cartBadgeText}>{unread > 9 ? '9+' : unread}</Text></View>}
        </TouchableOpacity>
      </View>
      <View style={s.modeRow}>
        {(['customer', 'owner'] as Mode[]).map((m) => (
          <TouchableOpacity key={m} onPress={() => setMode(m)}
            style={[s.modeBtn, mode === m && s.modeBtnActive]}>
            <Ionicons name={m === 'customer' ? 'person' : 'storefront'} size={15}
              color={mode === m ? '#fff' : C.green} />
            <Text style={[s.modeText, mode === m && s.modeTextActive]}>
              {m === 'customer' ? 'Customer' : 'Shop Owner'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {mode === 'customer'
        ? <CustomerApp me={me} initialShopId={initialShopId} />
        : <OwnerApp me={me} />}
    </View>
  );
}

// ════════════════════════════════════════════════════════════════
//  CUSTOMER
// ════════════════════════════════════════════════════════════════
function CustomerApp({ me, initialShopId }: { me: { id: string; name: string } | null; initialShopId?: string }) {
  const [tab, setTab] = useState<CustTab>('shops');
  // drill-down within the Shops tab
  const [selShop, setSelShop] = useState<SB.Shop | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [trackId, setTrackId] = useState<string | null>(null);
  const [ledgerShop, setLedgerShop] = useState<SB.Shop | null>(null);
  const [productSearch, setProductSearch] = useState(false);
  // Phase 2 — favorites shared across screens
  const [favIds, setFavIds] = useState<Set<string>>(new Set());

  const loadFavs = useCallback(async () => {
    try { const list = await SB.favorites(); setFavIds(new Set(list.map((sh) => sh.id))); } catch {}
  }, []);
  useEffect(() => { loadFavs(); }, [loadFavs]);

  // Deep link / QR: open a specific shop on first mount.
  useEffect(() => { (async () => {
    if (!initialShopId) return;
    try { const sh = await SB.shopDetails(initialShopId); setTab('shops'); setSelShop(sh); } catch {}
  })(); }, [initialShopId]);

  const toggleFav = useCallback(async (shopId: string) => {
    // optimistic
    setFavIds((prev) => { const n = new Set(prev); n.has(shopId) ? n.delete(shopId) : n.add(shopId); return n; });
    try { await SB.toggleFavorite(shopId); } catch { loadFavs(); }
  }, [loadFavs]);

  const openTrack = (id: string) => { setTrackId(id); };

  return (
    <>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {tab === 'shops' && !selShop && !ledgerShop && !productSearch && (
          <FindShops onOpen={(sh) => { setSelShop(sh); }} favIds={favIds} onToggleFav={toggleFav}
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
            shop={selShop} cart={cart} setCart={setCart}
            onBack={() => setSelShop(null)}
            onPlaced={(id) => { setSelShop(null); setCart([]); setTab('orders'); openTrack(id); }}
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
      </KeyboardAvoidingView>

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

function FindShops({ onOpen, favIds, onToggleFav, onProductSearch }: {
  onOpen: (s: SB.Shop) => void; favIds: Set<string>; onToggleFav: (id: string) => void;
  onProductSearch: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [shops, setShops] = useState<SB.Shop[]>([]);
  const [favShops, setFavShops] = useState<SB.Shop[]>([]);
  const [cat, setCat] = useState('all');
  const [q, setQ] = useState('');
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (category: string, c?: { lat: number; lng: number } | null) => {
    setLoading(true); setErr(null);
    try {
      const list = await SB.nearbyShops(c?.lat, c?.lng, category);
      setShops(list);
    } catch (e: any) { setErr(e?.message ?? 'Could not load shops'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { (async () => {
    let c: { lat: number; lng: number } | null = null;
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        c = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setCoords(c);
      }
    } catch {}
    load('all', c);
    try { setFavShops(await SB.favorites()); } catch {}
  })(); }, [load]);

  const filtered = useMemo(
    () => shops.filter((sh) => !q.trim() || sh.name.toLowerCase().includes(q.trim().toLowerCase())),
    [shops, q],
  );

  return (
    <ScrollView contentContainerStyle={s.body}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={() => load(cat, coords)} tintColor={C.green} />}>
      <View style={s.searchRow}>
        <Ionicons name="search" size={18} color={C.sub} />
        <TextInput style={s.searchInput} placeholder="Search shops nearby" placeholderTextColor={C.sub}
          value={q} onChangeText={setQ} />
      </View>
      <TouchableOpacity style={s.findProductBtn} onPress={onProductSearch}>
        <Ionicons name="pricetag" size={16} color={C.green} />
        <Text style={s.findProductText}>Find a product across shops</Text>
        <Ionicons name="chevron-forward" size={16} color={C.green} style={{ marginLeft: 'auto' }} />
      </TouchableOpacity>
      {!coords && !loading && (
        <Text style={s.hint}>📍 Location off — showing recent shops. Enable location for distance.</Text>
      )}

      {/* favorites strip */}
      {favShops.length > 0 && !q.trim() && (
        <>
          <Text style={s.sectionLabel}>⭐ Favorites</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 4 }}>
            {favShops.map((sh) => (
              <TouchableOpacity key={sh.id} style={s.favCard} onPress={() => onOpen(sh)}>
                <Text style={{ fontSize: 22 }}>{categoryIcon(sh.category)}</Text>
                <Text style={s.favName} numberOfLines={1}>{sh.name}</Text>
                {sh.ratingCount > 0 && <Text style={s.favRating}>{starText(sh.rating)} {sh.rating}</Text>}
              </TouchableOpacity>
            ))}
          </ScrollView>
        </>
      )}

      {/* category chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: 6 }}>
        <Chip label="All" icon="🏬" active={cat === 'all'} onPress={() => { setCat('all'); load('all', coords); }} />
        {SHOP_CATEGORIES.map((c2) => (
          <Chip key={c2.id} label={c2.label} icon={c2.icon} active={cat === c2.id}
            onPress={() => { setCat(c2.id); load(c2.id, coords); }} />
        ))}
      </ScrollView>

      {loading && <ActivityIndicator color={C.green} style={{ marginTop: 24 }} />}
      {err && <Text style={s.error}>{err}</Text>}
      {!loading && !err && filtered.length === 0 && (
        <Empty icon="storefront-outline" text="No shops found nearby yet." />
      )}

      {filtered.map((sh) => (
        <ShopCard key={sh.id} shop={sh} onOpen={() => onOpen(sh)}
          isFav={favIds.has(sh.id)} onToggleFav={() => onToggleFav(sh.id)} />
      ))}
    </ScrollView>
  );
}

function ShopCard({ shop, onOpen, isFav, onToggleFav }: {
  shop: SB.Shop; onOpen: () => void; isFav: boolean; onToggleFav: () => void;
}) {
  const st = shopOpenState(shop);
  return (
    <TouchableOpacity style={s.card} onPress={onOpen} activeOpacity={0.8}>
      <View style={s.shopIcon}><Text style={{ fontSize: 22 }}>{categoryIcon(shop.category)}</Text></View>
      <View style={{ flex: 1 }}>
        <Text style={s.cardTitle}>{shop.name}</Text>
        <Text style={s.cardSub}>
          {categoryLabel(shop.category)}
          {shop.ratingCount > 0 ? `  ·  ⭐ ${shop.rating} (${shop.ratingCount})` : ''}
        </Text>
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {shop.distanceKm != null && (
            <View style={[s.badge, s.badgeDist, { marginTop: 0, flexDirection: 'row', alignItems: 'center' }]}>
              <Ionicons name="location" size={11} color={C.green} style={{ marginRight: 3 }} />
              <Text style={[s.badgeText, { color: C.green }]}>{formatDistance(shop.distanceKm)}</Text>
            </View>
          )}
          <View style={[s.badge, { marginTop: 0 }, st.tone === 'open' ? s.badgeOpen : st.tone === 'soon' ? s.badgeSoon : s.badgeClosed]}>
            <Text style={[s.badgeText, st.tone === 'closed' && { color: C.danger }]}>{st.label}</Text>
          </View>
        </View>
      </View>
      <TouchableOpacity onPress={onToggleFav} hitSlop={10} style={{ padding: 4 }}>
        <Ionicons name={isFav ? 'heart' : 'heart-outline'} size={22} color={isFav ? C.danger : C.sub} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

function ProductSearch({ onBack, onOpenShop }: { onBack: () => void; onOpenShop: (shopId: string) => void }) {
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<SB.ProductHit[]>([]);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [searched, setSearched] = useState(false);

  useEffect(() => { (async () => {
    try {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status === 'granted') {
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      }
    } catch {}
  })(); }, []);

  const [sort, setSort] = useState<'price' | 'nearest' | 'open'>('price');

  const run = async () => {
    if (q.trim().length < 2) return;
    setLoading(true); setSearched(true);
    try {
      setResults(await SB.searchProducts(
        q.trim(), coords?.lat, coords?.lng, sort === 'nearest' ? 'nearest' : 'price'));
    } catch {} finally { setLoading(false); }
  };
  // Re-run when the sort changes after a search.
  useEffect(() => { if (searched) run(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [sort]);

  // "Open now" ranks currently-open shops first (computed client-side from
  // the timing fields; spec: price-comparison / sorting).
  const shown = useMemo(() => {
    if (sort !== 'open') return results;
    const openRank = (h: SB.ProductHit) =>
      shopOpenState({ openTime: h.openTime, closeTime: h.closeTime, status: h.shopStatus,
        weeklyHoliday: h.weeklyHoliday, lunchStart: h.lunchStart, lunchEnd: h.lunchEnd }).isOpen ? 0 : 1;
    return [...results].sort((a, b) => openRank(a) - openRank(b) || (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
  }, [results, sort]);

  return (
    <>
      <SubHeader title={t('shops.compare')} onBack={onBack} />
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <View style={s.searchRow}>
          <Ionicons name="search" size={18} color={C.sub} />
          <TextInput style={s.searchInput} placeholder="e.g. Maggi, Atta, Paracetamol"
            placeholderTextColor={C.sub} value={q} onChangeText={setQ}
            onSubmitEditing={run} returnKeyType="search" autoFocus />
        </View>
        <TouchableOpacity style={s.primaryBtn} onPress={run}><Text style={s.primaryBtnText}>Search nearby shops</Text></TouchableOpacity>

        {searched && (
          <View style={{ flexDirection: 'row', gap: 6, marginTop: 10 }}>
            {([['price', 'Lowest price'], ['nearest', 'Nearest'], ['open', 'Open now']] as const).map(([id, lbl]) => (
              <TouchableOpacity key={id} style={[s.filterChip, sort === id && s.filterChipActive]} onPress={() => setSort(id)}>
                <Text style={[s.filterChipText, sort === id && s.filterChipTextActive]}>{lbl}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {loading && <ActivityIndicator color={C.green} style={{ marginTop: 20 }} />}
        {searched && !loading && results.length === 0 && (
          <Empty icon="search-outline" text="No shop nearby lists that yet." />
        )}
        {shown.map((h, i) => (
          <TouchableOpacity key={`${h.shopId}-${i}`} style={s.card} onPress={() => onOpenShop(h.shopId)}>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{h.productName}{h.unit ? ` · ${h.unit}` : ''}{h.productBrand ? ` (${h.productBrand})` : ''}</Text>
              <Text style={s.cardSub}>
                {h.shopName}{h.distanceKm != null ? ` · ${formatDistance(h.distanceKm)}` : ''}
                {h.ratingCount > 0 ? ` · ⭐ ${h.rating}` : ''}
              </Text>
              <Text style={s.cardSub}>
                {h.inStock ? '🟢 In stock' : '🔴 Out of stock'}
                {h.updatedAt ? ` · updated ${new Date(h.updatedAt).toLocaleDateString('en-IN')}` : ''}
              </Text>
              <Text style={s.price}>{formatMoney(h.price, h.currency || '₹')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={C.sub} />
          </TouchableOpacity>
        ))}
      </ScrollView>
    </>
  );
}

// Shop details → catalog → cart, all in one drill-down.
function ShopFlow({ shop, cart, setCart, onBack, onPlaced, onLedger, isFav, onToggleFav }: {
  shop: SB.Shop; cart: CartItem[]; setCart: (c: CartItem[]) => void;
  onBack: () => void; onPlaced: (orderId: string) => void; onLedger: () => void;
  isFav: boolean; onToggleFav: () => void;
}) {
  const [view, setView] = useState<'details' | 'catalog' | 'cart'>('details');
  const [coupons, setCoupons] = useState<SB.Coupon[]>([]);
  const [ratings, setRatings] = useState<SB.Rating[]>([]);
  const st = shopOpenState(shop);

  useEffect(() => { (async () => {
    try { setCoupons(await SB.shopCoupons(shop.id)); } catch {}
    try { setRatings(await SB.shopRatings(shop.id)); } catch {}
  })(); }, [shop.id]);

  return (
    <>
      <SubHeader title={shop.name}
        onBack={() => (view === 'details' ? onBack() : setView('details'))}
        right={cart.length > 0 ? { icon: 'cart', badge: cart.length, onPress: () => setView('cart') } : undefined}
      />
      {view === 'details' && (
        <ScrollView contentContainerStyle={s.body}>
          <View style={s.card}>
            <View style={s.shopIcon}><Text style={{ fontSize: 26 }}>{categoryIcon(shop.category)}</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{shop.name}</Text>
              <Text style={s.cardSub}>
                {categoryLabel(shop.category)}{shop.distanceKm != null ? ` · ${formatDistance(shop.distanceKm)}` : ''}
                {shop.ratingCount > 0 ? `  ·  ⭐ ${shop.rating} (${shop.ratingCount})` : ''}
              </Text>
              <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}>
                <View style={[s.badge, { marginTop: 0 }, st.tone === 'open' ? s.badgeOpen : st.tone === 'soon' ? s.badgeSoon : s.badgeClosed]}>
                  <Text style={[s.badgeText, st.tone === 'closed' && { color: C.danger }]}>{st.label}</Text>
                </View>
              </View>
            </View>
            <TouchableOpacity onPress={onToggleFav} hitSlop={10} style={{ padding: 4 }}>
              <Ionicons name={isFav ? 'heart' : 'heart-outline'} size={24} color={isFav ? C.danger : C.sub} />
            </TouchableOpacity>
          </View>

          {/* Offers */}
          {coupons.length > 0 && (
            <>
              <Text style={s.sectionLabel}>🏷️ Offers</Text>
              {coupons.map((c2) => (
                <View key={c2.code} style={s.offerCard}>
                  <View style={s.couponCode}><Text style={s.couponCodeText}>{c2.code}</Text></View>
                  <Text style={s.offerText}>{couponLabel(c2)}</Text>
                </View>
              ))}
            </>
          )}

          {shop.distanceKm != null && <InfoRow icon="navigate-outline" label="Distance" value={`${formatDistance(shop.distanceKm)} away`} />}
          <InfoRow icon="time-outline" label="Timings" value={`${shop.openTime} – ${shop.closeTime}`} />
          {!!shop.address && <InfoRow icon="location-outline" label="Address" value={shop.address} />}
          {!!shop.phone && <InfoRow icon="call-outline" label="Phone" value={shop.phone} />}
          <InfoRow icon="bag-check-outline" label="Pickup" value={shop.pickup ? 'Available' : 'No pickup'} />
          <InfoRow icon="hourglass-outline" label="Prep time" value={`~${shop.prepMins} min`} />

          <TouchableOpacity style={s.primaryBtn} onPress={() => setView('catalog')}>
            <Ionicons name="list" size={18} color="#fff" />
            <Text style={s.primaryBtnText}>View Catalog</Text>
          </TouchableOpacity>
          {shop.lat != null && shop.lng != null && (
            <TouchableOpacity style={s.outlineBtn} onPress={() => openDirections(shop)}>
              <Ionicons name="navigate-outline" size={18} color={C.green} />
              <Text style={s.outlineBtnText}>
                Directions{shop.distanceKm != null ? ` · ${formatDistance(shop.distanceKm)}` : ''}
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={s.outlineBtn} onPress={onLedger}>
            <Ionicons name="book-outline" size={18} color={C.green} />
            <Text style={s.outlineBtnText}>My Ledger with this shop</Text>
          </TouchableOpacity>

          {/* Reviews */}
          {ratings.length > 0 && (
            <>
              <Text style={s.sectionLabel}>Reviews</Text>
              {ratings.slice(0, 5).map((rt, i) => (
                <View key={i} style={s.card}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.stars}>{starText(rt.stars)}</Text>
                    {!!rt.review && <Text style={s.cardSub}>{rt.review}</Text>}
                    <Text style={s.reviewName}>— {rt.customerName || 'Customer'}</Text>
                  </View>
                </View>
              ))}
            </>
          )}
        </ScrollView>
      )}
      {view === 'catalog' && (
        <Catalog shop={shop} cart={cart} setCart={setCart} onCart={() => setView('cart')} />
      )}
      {view === 'cart' && (
        <CartView shop={shop} cart={cart} setCart={setCart} onPlaced={onPlaced} coupons={coupons} />
      )}
    </>
  );
}

function Catalog({ shop, cart, setCart, onCart }: {
  shop: SB.Shop; cart: CartItem[]; setCart: (c: CartItem[]) => void; onCart: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<SB.Product[]>([]);
  const [q, setQ] = useState('');
  // "Type any product" form
  const [tName, setTName] = useState('');
  const [tBrand, setTBrand] = useState('');
  const [tQty, setTQty] = useState('1');
  const [tNote, setTNote] = useState('');
  const [listening, setListening] = useState(false);

  useEffect(() => { (async () => {
    try { setProducts(await SB.shopProducts(shop.id)); }
    catch {} finally { setLoading(false); }
  })(); }, [shop.id]);

  // Voice ordering — speak a product name into "Type any product".
  useEffect(() => {
    Voice.onSpeechResults = (e: SpeechResultsEvent) => { const t = e.value?.[0]; if (t) setTName(t); };
    Voice.onSpeechEnd = () => setListening(false);
    Voice.onSpeechError = () => setListening(false);
    return () => { Voice.destroy().then(() => Voice.removeAllListeners()).catch(() => {}); };
  }, []);
  const mic = async () => {
    try {
      if (listening) { await Voice.stop(); setListening(false); return; }
      setListening(true); await Voice.start('en-IN');
    } catch { setListening(false); Alert.alert('Voice unavailable', 'Speech input is not available on this device/build.'); }
  };

  // `price` here is what we display; the server re-prices from productId when
  // the line came from the catalog. A free-typed line carries no productId and
  // reaches the owner as a request to quote.
  const add = (name: string, brand: string, qty: number, price: number, note: string,
               unit = '', taxPercent = 0, productId?: string) => {
    setCart([...cart, { key: clientKey(), productId, name, brand, qty, price, note, unit, taxPercent }]);
  };

  const filtered = products.filter(
    (p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()) || p.brand.toLowerCase().includes(q.trim().toLowerCase()),
  );

  return (
    <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      <View style={s.searchRow}>
        <Ionicons name="search" size={18} color={C.sub} />
        <TextInput style={s.searchInput} placeholder="Search products" placeholderTextColor={C.sub}
          value={q} onChangeText={setQ} />
      </View>

      {/* Type any product */}
      <View style={s.panel}>
        <Text style={s.panelTitle}>✍️ Type any product</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TextInput style={[s.input, { flex: 1, marginBottom: 0 }]} placeholder="Product name (e.g. Maggi)" placeholderTextColor={C.sub}
            value={tName} onChangeText={setTName} />
          <TouchableOpacity style={[s.micBtn, listening && s.micBtnOn]} onPress={mic}>
            <Ionicons name={listening ? 'stop' : 'mic'} size={20} color={listening ? '#fff' : C.green} />
          </TouchableOpacity>
        </View>
        {listening
          ? <Text style={[s.hint, { color: C.green }]}>🎤 Listening… say the product name</Text>
          : <Text style={s.hint}>Tap the mic to speak instead of typing</Text>}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TextInput style={[s.input, { flex: 1 }]} placeholder="Brand (optional)" placeholderTextColor={C.sub}
            value={tBrand} onChangeText={setTBrand} />
          <TextInput style={[s.input, { width: 80 }]} placeholder="Qty" placeholderTextColor={C.sub}
            keyboardType="numeric" value={tQty} onChangeText={setTQty} />
        </View>
        <TextInput style={s.input} placeholder="Note (e.g. small pack)" placeholderTextColor={C.sub}
          value={tNote} onChangeText={setTNote} />
        <TouchableOpacity style={s.primaryBtn} onPress={() => {
          if (!tName.trim()) return;
          add(tName.trim(), tBrand.trim(), Math.max(1, num(tQty)), 0, tNote.trim());
          setTName(''); setTBrand(''); setTQty('1'); setTNote('');
        }}>
          <Ionicons name="add" size={18} color="#fff" />
          <Text style={s.primaryBtnText}>Add to Order</Text>
        </TouchableOpacity>
      </View>

      <Text style={s.sectionLabel}>Catalog</Text>
      {loading && <ActivityIndicator color={C.green} style={{ marginTop: 16 }} />}
      {!loading && filtered.length === 0 && <Empty icon="pricetags-outline" text="No listed products. Use “Type any product” above." />}
      {filtered.map((p) => (
        <View key={p.id} style={s.card}>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>{p.name}{p.unit ? ` · ${p.unit}` : ''}</Text>
            <Text style={s.cardSub}>{[p.brand, p.category].filter(Boolean).join(' · ')}</Text>
            <Text style={s.price}>{formatINR(p.price)}{!p.inStock ? '  ·  Out of stock' : ''}</Text>
          </View>
          <TouchableOpacity style={[s.addBtn, !p.inStock && { opacity: 0.4 }]} disabled={!p.inStock}
            onPress={() => add(p.name, p.brand, 1, p.price, '', p.unit, p.taxPercent, p.id)}>
            <Text style={s.addBtnText}>Add</Text>
          </TouchableOpacity>
        </View>
      ))}

      {cart.length > 0 && (
        <TouchableOpacity style={s.stickyCart} onPress={onCart}>
          <Text style={s.stickyCartText}>View Cart ({cart.length})</Text>
          <Text style={s.stickyCartText}>{formatINR(cartTotal(cart))}</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

function CartView({ shop, cart, setCart, onPlaced, coupons }: {
  shop: SB.Shop; cart: CartItem[]; setCart: (c: CartItem[]) => void;
  onPlaced: (id: string) => void; coupons: SB.Coupon[];
}) {
  const [note, setNote] = useState('');
  const [placing, setPlacing] = useState(false);
  const [couponInput, setCouponInput] = useState('');
  const [applied, setApplied] = useState<SB.Coupon | null>(null);
  const [couponMsg, setCouponMsg] = useState('');

  const setQty = (key: string, d: number) =>
    setCart(cart.map((it) => it.key === key ? { ...it, qty: Math.max(1, it.qty + d) } : it));
  const remove = (key: string) => setCart(cart.filter((it) => it.key !== key));

  const subtotal = cartTotal(cart);
  const discount = couponDiscount(subtotal, applied);
  const total = Math.max(0, subtotal - discount);

  const applyCoupon = () => {
    const code = couponInput.trim().toUpperCase();
    const found = coupons.find((c2) => c2.code.toUpperCase() === code);
    if (!found) { setCouponMsg('Invalid code'); setApplied(null); return; }
    if (subtotal < found.minOrder) { setCouponMsg(`Min order ${formatINR(found.minOrder)}`); setApplied(null); return; }
    setApplied(found); setCouponMsg(`Applied · ${couponLabel(found)}`);
  };

  // One key for this cart, reused by every retry — including the retry the
  // customer triggers by confirming a price change — so a flaky connection
  // cannot turn one order into two.
  const idemKey = useRef(clientKey()).current;

  const place = async (confirmPricing = false) => {
    if (cart.length === 0) return;
    setPlacing(true);
    try {
      const res = await SB.placeOrder(
        shop.id,
        cart.map((it) => ({
          productId: it.productId,
          name: it.name, brand: it.brand, qty: it.qty, price: it.price, note: it.note,
          unit: it.unit, taxPercent: it.taxPercent,
        })),
        note.trim(),
        { couponCode: applied?.code, idempotencyKey: idemKey, confirmPricing },
      );
      onPlaced(res.id);
    } catch (e: any) {
      // The shop's prices moved since this cart was built. Show the customer
      // exactly what changed and let them decide — never re-price silently.
      const pc = SB.priceChangesFrom(e);
      if (pc) {
        const lines = pc.changes
          .map((c) => `${c.name}${c.brand ? ` (${c.brand})` : ''}: ${formatMoney(c.oldPrice, shop.currency)} → ${formatMoney(c.newPrice, shop.currency)}`)
          .join('\n');
        Alert.alert(
          'Price changed at the shop',
          `${lines}\n\nNew total: ${formatMoney(pc.total, shop.currency)}`,
          [
            { text: 'Back to cart', style: 'cancel' },
            { text: 'Order at new price', onPress: () => { void place(true); } },
          ],
        );
        return;
      }
      Alert.alert('Could not place order', e?.message ?? 'Try again.');
    } finally { setPlacing(false); }
  };

  return (
    <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      <Text style={s.sectionLabel}>Review order · {shop.name}</Text>
      {cart.map((it) => (
        <View key={it.key} style={s.card}>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>{it.name}{it.brand ? ` (${it.brand})` : ''}</Text>
            {!!it.note && <Text style={s.cardSub}>📝 {it.note}</Text>}
            <Text style={s.price}>{it.price > 0 ? formatINR(it.price) : 'Price on confirm'}</Text>
          </View>
          <View style={s.qtyRow}>
            <TouchableOpacity style={s.qtyBtn} onPress={() => setQty(it.key, -1)}><Text style={s.qtyBtnText}>−</Text></TouchableOpacity>
            <Text style={s.qtyText}>{it.qty}</Text>
            <TouchableOpacity style={s.qtyBtn} onPress={() => setQty(it.key, 1)}><Text style={s.qtyBtnText}>+</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => remove(it.key)} style={{ marginLeft: 8 }}>
              <Ionicons name="trash-outline" size={18} color={C.danger} />
            </TouchableOpacity>
          </View>
        </View>
      ))}
      {cart.length === 0 && <Empty icon="cart-outline" text="Cart is empty." />}

      {cart.length > 0 && (
        <>
          {/* Coupon */}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
            <TextInput style={[s.input, { flex: 1, marginBottom: 0 }]} placeholder="Coupon code" placeholderTextColor={C.sub}
              autoCapitalize="characters" value={couponInput} onChangeText={setCouponInput} />
            <TouchableOpacity style={[s.outlineBtn, { marginTop: 0, paddingHorizontal: 18 }]} onPress={applyCoupon}>
              <Text style={s.outlineBtnText}>Apply</Text>
            </TouchableOpacity>
          </View>
          {!!couponMsg && <Text style={[s.hint, { color: applied ? C.green : C.danger }]}>{couponMsg}</Text>}

          <TextInput style={s.input} placeholder="Order note (e.g. pack before 8 PM)" placeholderTextColor={C.sub}
            value={note} onChangeText={setNote} />

          {/* Totals */}
          <View style={s.panel}>
            <Row label="Subtotal" value={formatINR(subtotal)} />
            {discount > 0 && <Row label={`Discount (${applied?.code})`} value={`− ${formatINR(discount)}`} tone={C.green} />}
            <View style={{ height: 1, backgroundColor: C.border, marginVertical: 6 }} />
            <Row label="Total" value={formatINR(total)} bold />
          </View>

          <TouchableOpacity style={[s.primaryBtn, placing && { opacity: 0.6 }]} disabled={placing}
            onPress={() => { void place(); }}>
            {placing ? <ActivityIndicator color="#fff" /> : <>
              <Ionicons name="checkmark-circle" size={18} color="#fff" />
              <Text style={s.primaryBtnText}>Place Order</Text>
            </>}
          </TouchableOpacity>
        </>
      )}
    </ScrollView>
  );
}

function Row({ label, value, tone, bold }: { label: string; value: string; tone?: string; bold?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
      <Text style={[{ color: C.sub, fontSize: 14 }, bold && { color: C.text, fontWeight: '800', fontSize: 16 }]}>{label}</Text>
      <Text style={[{ color: tone ?? C.text, fontSize: 14, fontWeight: '600' }, bold && { fontWeight: '800', fontSize: 16 }]}>{value}</Text>
    </View>
  );
}

function MyOrders({ onOpen }: { onOpen: (id: string) => void }) {
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<SB.OrderSummary[]>([]);
  const load = useCallback(async () => {
    setLoading(true);
    try { setOrders(await SB.myOrders()); } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <ScrollView contentContainerStyle={s.body}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
      <Text style={s.sectionLabel}>My Orders</Text>
      {loading && <ActivityIndicator color={C.green} style={{ marginTop: 16 }} />}
      {!loading && orders.length === 0 && <Empty icon="receipt-outline" text="No orders yet." />}
      {orders.map((o) => (
        <TouchableOpacity key={o.id} style={s.card} onPress={() => onOpen(o.id)}>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>{o.shopName}</Text>
            <Text style={s.cardSub}>{o.id.slice(0, 8).toUpperCase()} · {formatMoney(o.total, o.currency || '₹')}</Text>
            <StatusPill status={o.status} />
          </View>
          <Ionicons name="chevron-forward" size={20} color={C.sub} />
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

// Shop names, addresses and product names are free text — escape before they
// go anywhere near the bill markup, or one apostrophe-heavy shop name breaks
// the layout.
const esc = (s: string) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

// The printable bill. Carries the shop's identity (name, owner, address,
// phone, tax id) — a receipt that cannot say who issued it is not a receipt —
// and prices in the shop's own currency, not a hardcoded ₹.
function buildBillHtml(order: SB.OrderDetail): string {
  const shop = order.shop ?? { name: '', address: '', phone: '', ownerName: '', taxConfig: {} } as SB.OrderDetail['shop'];
  const cur = order.currency || '₹';
  const m = (n: number) => esc(formatMoney(n, cur));
  const placed = new Date(order.createdAt);

  // Tax identifiers are country-driven (GSTIN / VAT no. / EIN / ABN …), so
  // render whatever the shop actually configured rather than assuming GST.
  const taxLines = Object.entries(shop.taxConfig ?? {})
    .filter(([, v]) => String(v ?? '').trim() !== '')
    .map(([k, v]) => `<div>${esc(k.toUpperCase())}: <b>${esc(String(v))}</b></div>`)
    .join('');

  const rows = order.items.map((it) => {
    const unavailable = it.availability === 'unavailable';
    const name = `${esc(it.name)}${it.brand ? ` <span class="muted">(${esc(it.brand)})</span>` : ''}`
      + `${it.unit ? ` <span class="muted">· ${esc(it.unit)}</span>` : ''}`;
    return `<tr${unavailable ? ' class="struck"' : ''}>
      <td>${name}${unavailable ? ' <span class="muted">— not available</span>' : ''}</td>
      <td class="num">${esc(String(it.qty))}</td>
      <td class="num">${it.price > 0 ? m(it.price) : '—'}</td>
      <td class="num">${it.price > 0 ? m(it.price * it.qty) : '—'}</td>
    </tr>`;
  }).join('');

  const subtotal = order.items.reduce((s, it) => s + (it.price || 0) * (it.qty || 0), 0);

  return `<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    *{box-sizing:border-box}
    body{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;color:#111;margin:0;padding:32px 28px;font-size:14px}
    .head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;
          border-bottom:2px solid #0B7A3B;padding-bottom:14px}
    .shop{font-size:21px;font-weight:700;color:#0B7A3B;margin:0 0 4px}
    .muted{color:#6B7280}
    .meta{text-align:right;font-size:12px;color:#4B5563;line-height:1.7;white-space:nowrap}
    .tag{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;
         font-weight:700;background:#E8F5EE;color:#0B7A3B;letter-spacing:.3px}
    table{width:100%;border-collapse:collapse;margin-top:22px}
    th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.6px;
       color:#4B5563;border-bottom:1px solid #D1D5DB;padding:0 0 8px}
    td{padding:9px 0;border-bottom:1px solid #F3F4F6;vertical-align:top;line-height:1.5}
    th.num,td.num{text-align:right}
    .struck td{color:#9CA3AF;text-decoration:line-through}
    .totals{margin-left:auto;margin-top:14px;width:62%}
    .totals td{border:none;padding:5px 0}
    .totals .lbl{color:#4B5563}
    .grand td{border-top:2px solid #111;padding-top:11px;font-size:17px;font-weight:700}
    .foot{margin-top:30px;padding-top:14px;border-top:1px solid #F3F4F6;
          font-size:11px;color:#6B7280;line-height:1.7}
  </style></head>
  <body>
    <div class="head">
      <div>
        <p class="shop">${esc(shop.name) || 'Shop Book'}</p>
        ${shop.ownerName ? `<div class="muted">${esc(shop.ownerName)}</div>` : ''}
        ${shop.address ? `<div class="muted">${esc(shop.address)}</div>` : ''}
        ${shop.phone ? `<div class="muted">☎ ${esc(shop.phone)}</div>` : ''}
        ${taxLines ? `<div style="margin-top:6px;font-size:12px">${taxLines}</div>` : ''}
      </div>
      <div class="meta">
        <span class="tag">${esc(orderStatusLabel(order.status))}</span>
        <div style="margin-top:8px">Order <b>${esc(order.id.slice(0, 8).toUpperCase())}</b></div>
        <div>${esc(placed.toLocaleDateString())}</div>
        <div>${esc(placed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</div>
      </div>
    </div>

    <table>
      <thead><tr>
        <th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <table class="totals">
      <tr><td class="lbl">Subtotal</td><td class="num">${m(subtotal)}</td></tr>
      ${order.discount > 0
        ? `<tr><td class="lbl">Discount${order.couponCode ? ` (${esc(order.couponCode)})` : ''}</td>
             <td class="num" style="color:#0B7A3B">− ${m(order.discount)}</td></tr>` : ''}
      ${order.delivery && order.deliveryFee > 0
        ? `<tr><td class="lbl">Delivery</td><td class="num">${m(order.deliveryFee)}</td></tr>` : ''}
      <tr class="grand"><td>Total</td><td class="num">${m(order.total)}</td></tr>
    </table>

    ${order.note ? `<div class="foot">Note: ${esc(order.note)}</div>` : ''}
    <div class="foot">
      This is a pickup order receipt${shop.name ? ` from ${esc(shop.name)}` : ''}.
      ${taxLines ? '' : 'Not a tax invoice.'}
      <div>Generated by Shop Book</div>
    </div>
  </body></html>`;
}

// A Shop Book realtime event. Payload carries identifiers only — never the new
// state — so a listener's only correct reaction is to re-fetch.
interface ShopBookEvent {
  event: string;
  title: string;
  body: string;
  data: { orderId?: string; shopId?: string; status?: string; [k: string]: any };
}

// Subscribes to the socket for the life of the caller. Registration is async
// (the socket may still be connecting), so the returned unsubscribe is safe to
// call before it has finished attaching.
function onShopBookEvent(handler: (ev: ShopBookEvent) => void): () => void {
  let detach: (() => void) | null = null;
  let cancelled = false;
  import('../lib/socket')
    .then((sock) => {
      if (cancelled) return;
      detach = sock.addPersistentListener<ShopBookEvent>('shopbook:event', handler);
    })
    .catch(() => {}); // no socket → push and the inbox still carry the news
  return () => {
    cancelled = true;
    detach?.();
  };
}

function OrderTrack({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const [loading, setLoading] = useState(true);
  const [order, setOrder] = useState<SB.OrderDetail | null>(null);
  const [stars, setStars] = useState(0);
  const [review, setReview] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancelAsk, setCancelAsk] = useState(false);
  const [invoice, setInvoice] = useState(false);
  const [returning, setReturning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setOrder(await SB.orderDetails(orderId)); } catch {} finally { setLoading(false); }
  }, [orderId]);
  useEffect(() => { load(); }, [load]);

  // Realtime (P1-E): the shop moves the order and this screen follows, without
  // the customer pulling to refresh while standing in the shop.
  //
  // The socket event is only a HINT that something changed — we re-fetch the
  // authoritative state rather than trusting the payload. That is also why the
  // screen is correct after a cold start, when no event was ever received.
  useEffect(() => {
    let alive = true;
    const stop = onShopBookEvent((ev) => {
      if (!alive) return;
      if (ev?.data?.orderId && ev.data.orderId !== orderId) return;
      load();
    });
    return () => { alive = false; stop(); };
  }, [orderId, load]);

  const decide = async (itemId: string, accept: boolean) => {
    try { await SB.decideAlternative(orderId, itemId, accept); load(); }
    catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
  };

  const cancelOrder = async (reason: string) => {
    setBusy(true);
    try { await SB.cancelOrder(orderId, reason); load(); }
    catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  // Only the customer can confirm collection (spec: order-management / D5a).
  const confirmCollected = async () => {
    setBusy(true);
    try { await SB.collectOrder(orderId); load(); }
    catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  const submitRating = async () => {
    if (stars < 1) { Alert.alert('Tap a star to rate'); return; }
    setBusy(true);
    try { await SB.rateOrder(orderId, stars, review.trim()); load(); }
    catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  const repeat = async () => {
    if (!order) return;
    setBusy(true);
    try {
      await SB.placeOrder(order.shopId,
        order.items.map((it) => ({
          name: it.name, brand: it.brand, qty: it.qty, price: it.price, note: it.note,
          unit: it.unit, taxPercent: it.taxPercent,
        })),
        'Repeat order');
      Alert.alert('Order placed', 'Your repeat order was sent to the shop.');
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  const share = async () => {
    if (!order) return;
    const lines = order.items.map((it) => `• ${it.name}${it.brand ? ` (${it.brand})` : ''} × ${it.qty}`);
    await Share.share({
      message: `🛍️ Shop Book order ${order.id.slice(0, 8).toUpperCase()}\n${lines.join('\n')}\nTotal: ${formatINR(order.total)}`,
    }).catch(() => {});
  };

  const bill = async () => {
    if (!order) return;
    const html = buildBillHtml(order);
    try {
      const { uri } = await Print.printToFileAsync({ html });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Order receipt' });
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Could not create the bill'); }
  };

  if (invoice) return <InvoiceView orderId={orderId} onBack={() => setInvoice(false)} />;
  if (returning && order) {
    return <ReturnRequest order={order} onDone={() => { setReturning(false); load(); }} />;
  }

  const money = (n: number) => formatMoney(n, order?.currency || '₹');
  const failed = order && isTerminalFailure(order.status);
  return (
    <>
      <SubHeader title={t('orders.track')} onBack={onBack}
        right={order ? { icon: 'share-social-outline', onPress: share } : undefined} />
      <ReasonModal visible={cancelAsk} title={t('orders.cancelReason')}
        onSubmit={(reason) => cancelOrder(reason)} onClose={() => setCancelAsk(false)} />
      <ScrollView contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
        {loading && !order && <ActivityIndicator color={C.green} style={{ marginTop: 24 }} />}
        {order && (
          <>
            <StatusPill status={order.status} big />
            {/* cancelled/rejected: reason banner instead of progress steps */}
            {failed ? (
              <View style={[s.panel, { borderColor: C.danger }]}>
                <Text style={{ color: C.danger, fontWeight: '700' }}>
                  {order.status === 'rejected'
                    ? `${t('orders.rejectedByShop')}${order.rejectReason ? ` — ${REJECT_REASONS.find((r) => r.code === order.rejectReason)?.label ?? order.rejectReason}` : ''}`
                    : order.status === 'not_collected'
                      ? (order.notCollectedReason === 'expired'
                          ? 'This order was not collected in time and has been closed.'
                          : `The shop closed this order as not collected${order.notCollectedReason ? ` — ${order.notCollectedReason}` : ''}.`)
                      : `${order.cancelledBy === 'customer' ? t('orders.cancelledByYou') : t('orders.cancelledByShop')}${order.cancelReason ? ` — ${order.cancelReason}` : ''}`}
                </Text>
              </View>
            ) : (
              <View style={s.stepper}>
                {ORDER_STEPS.map((step, i) => {
                  const done = orderProgress(order.status) >= i / (ORDER_STEPS.length - 1);
                  return (
                    <View key={step} style={{ alignItems: 'center', flex: 1 }}>
                      <View style={[s.stepDot, done && s.stepDotDone]}>
                        {done && <Ionicons name="checkmark" size={12} color="#fff" />}
                      </View>
                      <Text style={s.stepLabel}>{orderStatusLabel(step)}</Text>
                    </View>
                  );
                })}
              </View>
            )}

            {/* timestamped timeline (spec: order-management / tracking) */}
            {order.timeline.length > 0 && (
              <View style={s.panel}>
                {order.timeline.map((ev, i) => (
                  <View key={`${ev.status}-${i}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 3 }}>
                    <View style={[s.pillDot, { backgroundColor: C.green }]} />
                    <Text style={[s.cardSub, { flex: 1 }]}>
                      {orderStatusLabel(ev.status)}{ev.note ? ` · ${ev.note}` : ''}
                    </Text>
                    <Text style={[s.cardSub, { fontSize: 11 }]}>
                      {new Date(ev.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            {/* who the order is with — previously the tracking screen never said */}
            {!!order.shop?.name && (
              <View style={s.panel}>
                <Text style={s.panelTitle}>{order.shop.name}</Text>
                {!!order.shop.ownerName && <Text style={s.cardSub}>{order.shop.ownerName}</Text>}
                {!!order.shop.address && <Text style={s.cardSub}>📍 {order.shop.address}</Text>}
                {!!order.shop.phone && (
                  <TouchableOpacity onPress={() => Linking.openURL(`tel:${order.shop.phone}`)}>
                    <Text style={[s.cardSub, { color: C.green }]}>☎ {order.shop.phone}</Text>
                  </TouchableOpacity>
                )}
                {Object.entries(order.shop.taxConfig ?? {})
                  .filter(([, v]) => String(v ?? '').trim() !== '')
                  .map(([k, v]) => (
                    <Text key={k} style={s.cardSub}>{k.toUpperCase()}: {String(v)}</Text>
                  ))}
              </View>
            )}

            <Text style={s.sectionLabel}>Items</Text>
            {order.items.map((it) => (
              <View key={it.id} style={s.card}>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>{it.name}{it.brand ? ` (${it.brand})` : ''}{it.unit ? ` · ${it.unit}` : ''} × {it.qty}</Text>
                  {!!it.note && <Text style={s.cardSub}>📝 {it.note}</Text>}
                  <AvailabilityTag a={it.availability} altName={it.altName} />
                  {it.availability === 'alternative' && (
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                      <TouchableOpacity style={s.smallGreen} onPress={() => decide(it.id, true)}>
                        <Text style={s.smallGreenText}>
                          {t('orders.acceptAlt')} {it.altName}{it.altPrice > 0 ? ` (${money(it.altPrice)})` : ''}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={s.smallOutline} onPress={() => decide(it.id, false)}>
                        <Text style={s.smallOutlineText}>{t('orders.rejectAlt')}</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
                <Text style={s.price}>{it.price > 0 ? money(it.price * it.qty) : '—'}</Text>
              </View>
            ))}

            <View style={s.panel}>
              {order.discount > 0 && <Row label={`Discount (${order.couponCode})`} value={`− ${money(order.discount)}`} tone={C.green} />}
              <Row label={t('common.total')} value={money(order.total)} bold />
            </View>

            {/* collection is the customer's assertion, not the shop's (D5a) */}
            {canCustomerCollect(order.status) && (
              <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy}
                onPress={confirmCollected}>
                <Ionicons name="bag-check" size={18} color="#fff" />
                <Text style={s.primaryBtnText}>{t('orders.collected')}</Text>
              </TouchableOpacity>
            )}

            {/* customer may cancel only while the order is still pending */}
            {canCustomerCancel(order.status) && (
              <TouchableOpacity style={s.dangerBtn} disabled={busy} onPress={() => setCancelAsk(true)}>
                <Text style={s.dangerBtnText}>{t('orders.cancel')}</Text>
              </TouchableOpacity>
            )}

            {/* Repeat + Share + Invoice */}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity style={[s.outlineBtn, { flex: 1 }]} disabled={busy} onPress={repeat}>
                <Ionicons name="repeat" size={18} color={C.green} />
                <Text style={s.outlineBtnText}>Repeat order</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.outlineBtn, { flex: 1 }]} onPress={order.hasInvoice ? () => setInvoice(true) : bill}>
                <Ionicons name="receipt-outline" size={18} color={C.green} />
                <Text style={s.outlineBtnText}>{order.hasInvoice ? t('orders.invoice') : 'Bill / Receipt'}</Text>
              </TouchableOpacity>
            </View>

            {/* Returns (P1-B). Only on a completed order, and only inside the
                window — offering it later would be an invitation to a refusal. */}
            {order.status === 'completed' && (
              <TouchableOpacity style={s.outlineBtn} onPress={() => setReturning(true)}>
                <Ionicons name="arrow-undo-outline" size={18} color={C.green} />
                <Text style={s.outlineBtnText}>Return an item</Text>
              </TouchableOpacity>
            )}

            {/* Rating */}
            {order.status === 'completed' && (
              order.rated ? (
                <View style={[s.panel, { alignItems: 'center' }]}>
                  <Text style={{ color: C.green, fontWeight: '700' }}>✓ Thanks for rating this order</Text>
                </View>
              ) : (
                <View style={s.panel}>
                  <Text style={s.panelTitle}>Rate this order</Text>
                  <View style={{ flexDirection: 'row', gap: 6, marginVertical: 8 }}>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <TouchableOpacity key={n} onPress={() => setStars(n)}>
                        <Ionicons name={n <= stars ? 'star' : 'star-outline'} size={30} color={C.amber} />
                      </TouchableOpacity>
                    ))}
                  </View>
                  <TextInput style={s.input} placeholder="Write a review (optional)" placeholderTextColor={C.sub}
                    value={review} onChangeText={setReview} />
                  <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={submitRating}>
                    <Text style={s.primaryBtnText}>Submit Rating</Text>
                  </TouchableOpacity>
                </View>
              )
            )}
          </>
        )}
      </ScrollView>
    </>
  );
}

function CustomerLedgerView({ shop, onBack }: { shop: SB.Shop; onBack: () => void }) {
  const [loading, setLoading] = useState(true);
  const [ledger, setLedger] = useState<SB.Ledger | null>(null);
  useEffect(() => { (async () => {
    try { setLedger(await SB.customerLedger(shop.id)); } catch {} finally { setLoading(false); }
  })(); }, [shop.id]);

  return (
    <>
      <SubHeader title={`Ledger · ${shop.name}`} onBack={onBack} />
      <ScrollView contentContainerStyle={s.body}>
        {loading && <ActivityIndicator color={C.green} style={{ marginTop: 24 }} />}
        {ledger && (
          <>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <StatCard label="Total Pending" value={formatINR(ledger.pending)} tone="danger" />
              <StatCard label="Total Paid" value={formatINR(ledger.totalPaid)} tone="green" />
            </View>
            <Text style={s.sectionLabel}>Transactions</Text>
            {ledger.entries.length === 0 && <Empty icon="book-outline" text="No transactions yet." />}
            {ledger.entries.map((e) => (
              <LedgerRow key={e.id} entry={e} />
            ))}
          </>
        )}
      </ScrollView>
    </>
  );
}

function CustomerProfile({ me }: { me: { id: string; name: string } | null }) {
  const [loyalty, setLoyalty] = useState<SB.Loyalty | null>(null);
  const [lists, setLists] = useState<ShopList[]>([]);
  const [newName, setNewName] = useState('');
  const [newItems, setNewItems] = useState('');
  const [adding, setAdding] = useState(false);
  const [ledgers, setLedgers] = useState<SB.LedgerSummary[]>([]);
  const lang = useShopBookLang();

  const loadLists = useCallback(async () => {
    if (!me) return;
    try { setLists(await listShopLists(me.id)); } catch {}
  }, [me]);

  useEffect(() => { (async () => {
    try { setLoyalty(await SB.loyalty()); } catch {}
    try { setLedgers((await SB.myLedgers()).ledgers); } catch {}
    loadLists();
  })(); }, [loadLists]);

  const addList = async () => {
    if (!me || !newName.trim()) return;
    await saveShopList({ user_id: me.id, name: newName.trim(), items: newItems.trim() });
    setNewName(''); setNewItems(''); setAdding(false); loadLists();
  };

  const removeList = async (id: string) => { await deleteShopList(id); loadLists(); };

  const shareList = async (l: ShopList) => {
    await Share.share({ message: `🛒 ${l.name}\n${l.items}` }).catch(() => {});
  };

  return (
    <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      <View style={s.card}>
        <View style={s.shopIcon}><Ionicons name="person" size={22} color={C.green} /></View>
        <View style={{ flex: 1 }}>
          <Text style={s.cardTitle}>{me?.name ?? 'You'}</Text>
          <Text style={s.cardSub}>Customer · Always free</Text>
        </View>
      </View>

      {/* Loyalty */}
      <View style={s.loyaltyCard}>
        <View style={{ flex: 1 }}>
          <Text style={s.loyaltyPoints}>{loyalty?.points ?? 0} pts</Text>
          <Text style={s.loyaltyTier}>{loyaltyTier(loyalty?.points ?? 0)} member</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={s.loyaltySub}>{loyalty?.completedOrders ?? 0} orders</Text>
          <Text style={s.loyaltySub}>Spent {formatINR(loyalty?.totalSpent ?? 0)}</Text>
        </View>
      </View>
      <Text style={s.hint}>Earn 1 point for every ₹100 spent on completed orders.</Text>

      {/* Pending across shops (spec: customer-accounts / dashboard) */}
      {ledgers.some((l) => l.pending > 0) && (
        <>
          <Text style={s.sectionLabel}>💰 {t('profile.pendingAcross')}</Text>
          {ledgers.filter((l) => l.pending > 0).map((l) => (
            <View key={l.shopId} style={s.card}>
              <View style={{ flex: 1 }}>
                <Text style={s.cardTitle}>{l.shopName}</Text>
                <Text style={s.cardSub}>{t('common.pending')}</Text>
              </View>
              <Text style={[s.price, { color: C.danger }]}>{formatMoney(l.pending, l.currency)}</Text>
            </View>
          ))}
        </>
      )}

      {/* Language (spec: localization) */}
      <Text style={s.sectionLabel}>🌐 {t('lang.title')}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {SB_LANGUAGES.map((l) => (
          <TouchableOpacity key={l.id} style={[s.chip, lang === l.id && s.chipActive]}
            onPress={() => setShopBookLang(l.id)}>
            <Text style={[s.chipText, lang === l.id && { color: '#fff' }]}>{l.native}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Shopping lists */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
        <Text style={s.sectionLabel}>🛒 Shopping Lists</Text>
        <TouchableOpacity onPress={() => setAdding((v) => !v)}>
          <Ionicons name={adding ? 'close' : 'add-circle'} size={26} color={C.green} />
        </TouchableOpacity>
      </View>
      {adding && (
        <View style={s.panel}>
          <TextInput style={s.input} placeholder="List name (e.g. Monthly groceries)" placeholderTextColor={C.sub}
            value={newName} onChangeText={setNewName} />
          <TextInput style={[s.input, { height: 90, textAlignVertical: 'top' }]} multiline
            placeholder={'Items, one per line:\nAtta 5kg\nSugar 1kg\nOil 1L'} placeholderTextColor={C.sub}
            value={newItems} onChangeText={setNewItems} />
          <TouchableOpacity style={s.primaryBtn} onPress={addList}><Text style={s.primaryBtnText}>Save List</Text></TouchableOpacity>
        </View>
      )}
      {lists.length === 0 && !adding && <Empty icon="list-outline" text="No saved lists yet." />}
      {lists.map((l) => (
        <View key={l.id} style={s.card}>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>{l.name}</Text>
            <Text style={s.cardSub} numberOfLines={2}>{l.items.split('\n').filter(Boolean).join(' · ') || 'Empty'}</Text>
          </View>
          <TouchableOpacity onPress={() => shareList(l)} hitSlop={8} style={{ padding: 4 }}>
            <Ionicons name="share-social-outline" size={20} color={C.green} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => removeList(l.id)} hitSlop={8} style={{ padding: 4 }}>
            <Ionicons name="trash-outline" size={20} color={C.danger} />
          </TouchableOpacity>
        </View>
      ))}
    </ScrollView>
  );
}

// ════════════════════════════════════════════════════════════════
//  SHOP OWNER
// ════════════════════════════════════════════════════════════════
function OwnerApp({ me }: { me: { id: string; name: string } | null }) {
  const [tab, setTab] = useState<OwnerTab>('dashboard');
  const [loading, setLoading] = useState(true);
  const [shop, setShop] = useState<SB.Shop | null>(null);
  const [settings, setSettings] = useState(false);
  const [sub, setSub] = useState<
    'coupons' | 'suppliers' | 'plans' | 'reports'
    | 'purchases' | 'returns' | 'audit' | 'verify' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setShop(await SB.myShop()); } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (loading) return <ActivityIndicator color={C.green} style={{ marginTop: 40 }} />;

  // No shop yet → force settings/create.
  if (!shop || settings) {
    return (
      <ShopSettings shop={shop} me={me}
        onSaved={(sh) => { setShop(sh); setSettings(false); }}
        onCancel={shop ? () => setSettings(false) : undefined}
      />
    );
  }

  if (sub === 'coupons') return <OwnerCoupons onBack={() => setSub(null)} />;
  if (sub === 'suppliers') return <OwnerSuppliers onBack={() => setSub(null)} />;
  if (sub === 'purchases') return <PurchasesScreen currency={shop.currency} onBack={() => { setSub(null); load(); }} />;
  if (sub === 'returns') return <ReturnsScreen currency={shop.currency} onBack={() => setSub(null)} />;
  if (sub === 'audit') return <AuditScreen onBack={() => setSub(null)} />;
  if (sub === 'verify') return <VerificationScreen onBack={() => { setSub(null); load(); }} />;
  if (sub === 'plans') return <OwnerPlans plan={shop.plan} onBack={() => setSub(null)} onChanged={() => { setSub(null); load(); }} />;
  if (sub === 'reports') return <OwnerReports plan={shop.plan} currency={shop.currency} onBack={() => setSub(null)} onUpgrade={() => setSub('plans')} />;

  return (
    <>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {tab === 'dashboard' && (
          <OwnerDashboard shop={shop} onSettings={() => setSettings(true)}
            onCoupons={() => setSub('coupons')} onSuppliers={() => setSub('suppliers')}
            onPlans={() => setSub('plans')} onReports={() => setSub('reports')}
            onPurchases={() => setSub('purchases')} onReturns={() => setSub('returns')}
            onAudit={() => setSub('audit')} onVerify={() => setSub('verify')} />
        )}
        {tab === 'orders' && <OwnerOrders />}
        {tab === 'products' && <OwnerProducts shop={shop} />}
        {tab === 'khata' && <OwnerKhata />}
      </KeyboardAvoidingView>
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

function OwnerDashboard({ shop, onSettings, onCoupons, onSuppliers, onPlans, onReports,
                         onPurchases, onReturns, onAudit, onVerify }: {
  shop: SB.Shop; onSettings: () => void; onCoupons: () => void; onSuppliers: () => void;
  onPlans: () => void; onReports: () => void;
  onPurchases: () => void; onReturns: () => void; onAudit: () => void; onVerify: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [d, setD] = useState<SB.Dashboard | null>(null);
  const [qr, setQr] = useState(false);
  const deepLink = `vaultchat://shop-book?shop=${shop.id}`;
  const load = useCallback(async () => {
    setLoading(true);
    try { setD(await SB.dashboard()); } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const st = shopOpenState(shop);

  return (
    <ScrollView contentContainerStyle={s.body}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
      <Modal visible={qr} transparent animationType="fade" onRequestClose={() => setQr(false)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>{shop.name}</Text>
            <Text style={[s.hint, { textAlign: 'center' }]}>Customers scan this to open your shop</Text>
            <View style={{ alignItems: 'center', marginVertical: 18, backgroundColor: '#fff', padding: 14, borderRadius: 14 }}>
              <QRCode value={deepLink} size={190} color={C.navy} backgroundColor="#ffffff" />
            </View>
            <TouchableOpacity style={s.primaryBtn} onPress={() => Share.share({ message: `Order from ${shop.name} on Shop Book 🛍️\n${deepLink}` })}>
              <Ionicons name="share-social-outline" size={18} color="#fff" />
              <Text style={s.primaryBtnText}>Share shop link</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.dangerBtn} onPress={() => setQr(false)}><Text style={s.dangerBtnText}>Close</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>

      {!shop.approved && (
        <View style={[s.panel, { borderColor: C.amber }]}>
          <Text style={{ color: C.amber, fontWeight: '700' }}>⏳ {t('owner.pendingApproval')}</Text>
        </View>
      )}

      <TouchableOpacity style={s.card} onPress={onSettings}>
        <View style={s.shopIcon}><Text style={{ fontSize: 22 }}>{categoryIcon(shop.category)}</Text></View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={s.cardTitle}>{shop.name}</Text>
            {shop.verified && <Ionicons name="checkmark-circle" size={16} color={C.blue} />}
            <View style={[s.planTag, shop.plan === 'pro' ? s.planPro : s.planFree]}>
              <Text style={[s.planTagText, shop.plan === 'pro' && { color: '#fff' }]}>{shop.plan === 'pro' ? '★ PRO' : 'FREE'}</Text>
            </View>
          </View>
          <Text style={s.cardSub}>
            {shop.ratingCount > 0 ? `⭐ ${shop.rating} (${shop.ratingCount})` : 'No ratings yet'}
          </Text>
          <View style={[s.badge, st.tone === 'open' ? s.badgeOpen : st.tone === 'soon' ? s.badgeSoon : s.badgeClosed]}>
            <Text style={[s.badgeText, st.tone === 'closed' && { color: C.danger }]}>{st.label}</Text>
          </View>
        </View>
        <TouchableOpacity onPress={() => setQr(true)} hitSlop={8} style={{ padding: 4 }}>
          <Ionicons name="qr-code-outline" size={22} color={C.green} />
        </TouchableOpacity>
        <Ionicons name="settings-outline" size={20} color={C.sub} />
      </TouchableOpacity>

      {(shop.lat == null || shop.lng == null) && (
        <TouchableOpacity style={s.locBanner} onPress={onSettings} activeOpacity={0.85}>
          <Ionicons name="location-outline" size={20} color={C.amber} />
          <View style={{ flex: 1 }}>
            <Text style={s.locBannerTitle}>Set your shop location</Text>
            <Text style={s.locBannerSub}>Nearby customers can’t find you or see your distance until you do. Tap to add it.</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={C.amber} />
        </TouchableOpacity>
      )}

      <View style={s.statGrid}>
        <StatCard label="Today's Orders" value={String(d?.todayOrders ?? 0)} tone="navy" />
        <StatCard label="Today's Sales" value={formatMoney(d?.todaySales ?? 0, shop.currency)} tone="green" />
        <StatCard label="Pending Orders" value={String(d?.pendingOrders ?? 0)} tone="amber" />
        <StatCard label="Total Pending" value={formatMoney(d?.totalPending ?? 0, shop.currency)} tone="danger" />
      </View>
      {(d?.lowStock ?? 0) > 0 && (
        <View style={[s.panel, { borderColor: C.amber }]}>
          <Text style={{ color: C.amber, fontWeight: '700' }}>⚠️ {d?.lowStock} product(s) need restocking</Text>
        </View>
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
        <TouchableOpacity style={s.panel} onPress={onPurchases}>
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

      {/* Phase 2 quick links */}
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
        <TouchableOpacity style={s.linkCard} onPress={onCoupons}>
          <Text style={{ fontSize: 24 }}>🏷️</Text>
          <Text style={s.linkCardText}>Offers & Coupons</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.linkCard} onPress={onPurchases}>
          <Ionicons name="cart-outline" size={20} color={C.green} />
          <Text style={s.linkCardText}>Purchases &amp; cost</Text>
          <Ionicons name="chevron-forward" size={18} color={C.sub} />
        </TouchableOpacity>
        <TouchableOpacity style={s.linkCard} onPress={onReturns}>
          <Ionicons name="arrow-undo-outline" size={20} color={C.green} />
          <Text style={s.linkCardText}>Returns</Text>
          <Ionicons name="chevron-forward" size={18} color={C.sub} />
        </TouchableOpacity>
        <TouchableOpacity style={s.linkCard} onPress={onVerify}>
          <Ionicons name="shield-checkmark-outline" size={20} color={shop.verified ? C.blue : C.green} />
          <Text style={s.linkCardText}>{shop.verified ? 'Verified shop' : 'Get verified'}</Text>
          <Ionicons name="chevron-forward" size={18} color={C.sub} />
        </TouchableOpacity>
        <TouchableOpacity style={s.linkCard} onPress={onAudit}>
          <Ionicons name="document-text-outline" size={20} color={C.green} />
          <Text style={s.linkCardText}>Activity log</Text>
          <Ionicons name="chevron-forward" size={18} color={C.sub} />
        </TouchableOpacity>
        <TouchableOpacity style={s.linkCard} onPress={onSuppliers}>
          <Text style={{ fontSize: 24 }}>🚚</Text>
          <Text style={s.linkCardText}>Suppliers</Text>
        </TouchableOpacity>
      </View>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
        <TouchableOpacity style={s.linkCard} onPress={onReports}>
          <Text style={{ fontSize: 24 }}>📊</Text>
          <Text style={s.linkCardText}>Daily Reports{shop.plan !== 'pro' ? ' 🔒' : ''}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.linkCard} onPress={onPlans}>
          <Text style={{ fontSize: 24 }}>{shop.plan === 'pro' ? '⭐' : '⬆️'}</Text>
          <Text style={s.linkCardText}>{shop.plan === 'pro' ? 'My Plan' : 'Upgrade to Pro'}</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

function OwnerPlans({ plan, onBack, onChanged }: {
  plan: 'free' | 'pro'; onBack: () => void; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const change = async (next: 'free' | 'pro') => {
    setBusy(true);
    try { await SB.setPlan(next); onChanged(); }
    catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };
  const FREE = ['1 shop', 'Up to 300 customers', 'Basic ledger (khata)', 'Order management', 'Pending tracking', 'Push notifications'];
  const PRO = ['Unlimited customers', 'Product & inventory management', 'Daily reports & analytics', 'Coupons & offers', 'Payment tracking & reminders', 'Priority support'];
  return (
    <>
      <SubHeader title="Plans" onBack={onBack} />
      <ScrollView contentContainerStyle={s.body}>
        <View style={[s.planCard, plan === 'free' && s.planCardActive]}>
          <View style={s.row}><Text style={s.planName}>Free</Text><Text style={s.planPrice}>₹0<Text style={s.planPer}>/mo</Text></Text></View>
          {FREE.map((f) => <Text key={f} style={s.planFeat}>✓ {f}</Text>)}
          {plan === 'free'
            ? <View style={[s.btn2Tag]}><Text style={s.btn2TagText}>Current plan</Text></View>
            : <TouchableOpacity style={[s.outlineBtn, busy && { opacity: .6 }]} disabled={busy} onPress={() => change('free')}><Text style={s.outlineBtnText}>Downgrade</Text></TouchableOpacity>}
        </View>
        <View style={[s.planCard, s.planCardPro, plan === 'pro' && s.planCardActive]}>
          <View style={s.row}><Text style={[s.planName, { color: C.navy }]}>Pro ⭐</Text><Text style={[s.planPrice, { color: C.navy }]}>₹499<Text style={s.planPer}>/mo</Text></Text></View>
          {PRO.map((f) => <Text key={f} style={s.planFeat}>✓ {f}</Text>)}
          {plan === 'pro'
            ? <View style={[s.btn2Tag]}><Text style={s.btn2TagText}>Current plan</Text></View>
            : <TouchableOpacity style={[s.primaryBtn, busy && { opacity: .6 }]} disabled={busy} onPress={() => change('pro')}><Text style={s.primaryBtnText}>Upgrade to Pro</Text></TouchableOpacity>}
        </View>
        <Text style={s.hint}>Payment is handled offline with the shop — activate Pro here once you’ve upgraded. No card details are collected in the app.</Text>
      </ScrollView>
    </>
  );
}

// Reports (spec: reports-analytics): basic — daily/weekly/monthly sales and
// pending payments — for every plan; the Advanced tab (yearly, tax report,
// best sellers, top customers, product performance) is Pro-gated server-side.
function OwnerReports({ plan, currency, onBack, onUpgrade }: {
  plan: 'free' | 'pro'; currency?: string; onBack: () => void; onUpgrade: () => void;
}) {
  const [scope, setScope] = useState<'basic' | 'advanced'>('basic');
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<SB.Reports | null>(null);
  const money = (n: number) => formatMoney(n, currency || '₹');

  useEffect(() => { (async () => {
    if (scope === 'advanced' && plan !== 'pro') { setData(null); return; }
    setLoading(true);
    try { setData(await SB.reports(scope)); } catch {} finally { setLoading(false); }
  })(); }, [scope, plan]);

  const Bars = ({ title, rows }: { title: string; rows: SB.ReportDay[] }) => {
    const max = Math.max(1, ...rows.map((d) => d.sales));
    return (
      <>
        <Text style={s.sectionLabel}>{title}</Text>
        {rows.length === 0 && <Empty icon="bar-chart-outline" text="No completed orders yet." />}
        {rows.map((d) => (
          <View key={d.date} style={{ marginBottom: 10 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={s.cardSub}>{d.date}</Text>
              <Text style={[s.price, { marginTop: 0 }]}>{money(d.sales)} · {d.orders} order(s)</Text>
            </View>
            <View style={s.barTrack}><View style={[s.barFill, { width: `${Math.round((d.sales / max) * 100)}%` }]} /></View>
          </View>
        ))}
      </>
    );
  };

  return (
    <>
      <SubHeader title={t('owner.reports')} onBack={onBack} />
      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingTop: 10 }}>
        {(['basic', 'advanced'] as const).map((sc) => (
          <TouchableOpacity key={sc} style={[s.filterChip, scope === sc && s.filterChipActive]} onPress={() => setScope(sc)}>
            <Text style={[s.filterChipText, scope === sc && s.filterChipTextActive]}>
              {sc === 'basic' ? t('owner.reports.basic') : `${t('owner.reports.advanced')}${plan !== 'pro' ? ' 🔒' : ''}`}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {scope === 'advanced' && plan !== 'pro' ? (
        <View style={[s.body, { alignItems: 'center', justifyContent: 'center', flex: 1 }]}>
          <Text style={{ fontSize: 44 }}>🔒</Text>
          <Text style={[s.sectionLabel, { marginTop: 12 }]}>{t('owner.reports.upgrade')}</Text>
          <TouchableOpacity style={[s.primaryBtn, { alignSelf: 'stretch' }]} onPress={onUpgrade}><Text style={s.primaryBtnText}>Upgrade to Pro</Text></TouchableOpacity>
        </View>
      ) : (
        <ScrollView contentContainerStyle={s.body}>
          {loading && <ActivityIndicator color={C.green} style={{ marginTop: 20 }} />}
          {data && scope === 'basic' && (
            <>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <StatCard label={t('owner.reports.pendingPayments')} value={money(data.pendingTotal)} tone="danger" />
                <StatCard label="Customers with dues" value={String(data.pendingCustomers)} tone="amber" />
              </View>
              <Bars title="Sales · last 7 days" rows={data.days} />
              <Bars title="Sales · weekly" rows={data.weeks} />
              <Bars title="Sales · monthly" rows={data.months} />
            </>
          )}
          {data && scope === 'advanced' && (
            <>
              <Bars title="Sales · yearly" rows={data.years ?? []} />
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
                  <Text style={[s.cardTitle, { flex: 1 }]}>{p.name}</Text>
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
                  <Text style={[s.cardTitle, { flex: 1 }]}>{p.name}</Text>
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

function OwnerCoupons({ onBack }: { onBack: () => void }) {
  const [loading, setLoading] = useState(true);
  const [coupons, setCoupons] = useState<SB.Coupon[]>([]);
  const [code, setCode] = useState('');
  const [kind, setKind] = useState<'percent' | 'flat'>('percent');
  const [value, setValue] = useState('');
  const [minOrder, setMinOrder] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setCoupons(await SB.ownerCoupons()); } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!code.trim() || num(value) <= 0) { Alert.alert('Enter code and value'); return; }
    setBusy(true);
    try {
      await SB.saveCoupon({ code: code.trim(), kind, value: num(value), minOrder: num(minOrder), active: true });
      setCode(''); setValue(''); setMinOrder(''); load();
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  const remove = async (id?: string) => { if (!id) return; await SB.deleteCoupon(id); load(); };

  return (
    <>
      <SubHeader title="Offers & Coupons" onBack={onBack} />
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
        <View style={s.panel}>
          <Text style={s.panelTitle}>New coupon</Text>
          <TextInput style={s.input} placeholder="Code (e.g. SAVE10)" placeholderTextColor={C.sub}
            autoCapitalize="characters" value={code} onChangeText={setCode} />
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
            <TouchableOpacity style={[s.statusBtn, kind === 'percent' && s.statusBtnActive]} onPress={() => setKind('percent')}>
              <Text style={[s.statusBtnText, kind === 'percent' && { color: '#fff' }]}>% Percent</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.statusBtn, kind === 'flat' && s.statusBtnActive]} onPress={() => setKind('flat')}>
              <Text style={[s.statusBtnText, kind === 'flat' && { color: '#fff' }]}>₹ Flat</Text>
            </TouchableOpacity>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput style={[s.input, { flex: 1 }]} placeholder={kind === 'percent' ? 'Percent off' : 'Rupees off'}
              placeholderTextColor={C.sub} keyboardType="numeric" value={value} onChangeText={setValue} />
            <TextInput style={[s.input, { flex: 1 }]} placeholder="Min order ₹" placeholderTextColor={C.sub}
              keyboardType="numeric" value={minOrder} onChangeText={setMinOrder} />
          </View>
          <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={add}>
            <Text style={s.primaryBtnText}>Add Coupon</Text>
          </TouchableOpacity>
        </View>

        <Text style={s.sectionLabel}>Active coupons</Text>
        {loading && <ActivityIndicator color={C.green} />}
        {!loading && coupons.length === 0 && <Empty icon="pricetag-outline" text="No coupons yet." />}
        {coupons.map((c2) => (
          <View key={c2.id} style={s.card}>
            <View style={s.couponCode}><Text style={s.couponCodeText}>{c2.code}</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{couponLabel(c2)}</Text>
              <Text style={s.cardSub}>{c2.active ? 'Active' : 'Inactive'}</Text>
            </View>
            <TouchableOpacity onPress={() => remove(c2.id)} hitSlop={8} style={{ padding: 4 }}>
              <Ionicons name="trash-outline" size={20} color={C.danger} />
            </TouchableOpacity>
          </View>
        ))}
      </ScrollView>
    </>
  );
}

function OwnerSuppliers({ onBack }: { onBack: () => void }) {
  const [loading, setLoading] = useState(true);
  const [suppliers, setSuppliers] = useState<SB.Supplier[]>([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [items, setItems] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setSuppliers(await SB.suppliers()); } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!name.trim()) { Alert.alert('Enter supplier name'); return; }
    setBusy(true);
    try {
      await SB.saveSupplier({ name: name.trim(), phone: phone.trim(), items: items.trim(), note: note.trim() });
      setName(''); setPhone(''); setItems(''); setNote(''); load();
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  const remove = async (id?: string) => { if (!id) return; await SB.deleteSupplier(id); load(); };

  return (
    <>
      <SubHeader title="Suppliers" onBack={onBack} />
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
        <View style={s.panel}>
          <Text style={s.panelTitle}>New supplier</Text>
          <TextInput style={s.input} placeholder="Supplier / vendor name" placeholderTextColor={C.sub}
            value={name} onChangeText={setName} />
          <TextInput style={s.input} placeholder="Phone" placeholderTextColor={C.sub}
            keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
          <TextInput style={s.input} placeholder="Items supplied (e.g. Atta, Rice, Oil)" placeholderTextColor={C.sub}
            value={items} onChangeText={setItems} />
          <TextInput style={s.input} placeholder="Note (optional)" placeholderTextColor={C.sub}
            value={note} onChangeText={setNote} />
          <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={add}>
            <Text style={s.primaryBtnText}>Add Supplier</Text>
          </TouchableOpacity>
        </View>

        <Text style={s.sectionLabel}>My suppliers</Text>
        {loading && <ActivityIndicator color={C.green} />}
        {!loading && suppliers.length === 0 && <Empty icon="cube-outline" text="No suppliers yet." />}
        {suppliers.map((sup) => (
          <View key={sup.id} style={s.card}>
            <View style={s.shopIcon}><Ionicons name="cube" size={20} color={C.green} /></View>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{sup.name}</Text>
              {!!sup.phone && <Text style={s.cardSub}>📞 {sup.phone}</Text>}
              {!!sup.items && <Text style={s.cardSub}>{sup.items}</Text>}
            </View>
            <TouchableOpacity onPress={() => remove(sup.id)} hitSlop={8} style={{ padding: 4 }}>
              <Ionicons name="trash-outline" size={20} color={C.danger} />
            </TouchableOpacity>
          </View>
        ))}
      </ScrollView>
    </>
  );
}

const OWNER_ORDER_TABS: { id: string; label: string }[] = [
  { id: 'pending', label: 'New' }, { id: 'accepted', label: 'Accepted' },
  { id: 'preparing', label: 'Preparing' }, { id: 'packing', label: 'Packing' },
  { id: 'ready', label: 'Ready' }, { id: 'completed', label: 'Completed' },
  { id: 'all', label: 'All' },
];

function OwnerOrders() {
  const [filter, setFilter] = useState('pending');
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<SB.OrderSummary[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async (f: string) => {
    setLoading(true);
    try { setOrders(await SB.ownerOrders(f)); } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(filter); }, [filter, load]);

  // A new order should appear on the owner's list the moment it is placed —
  // they may be standing at the counter with the app already open (P1-E).
  useEffect(() => {
    const stop = onShopBookEvent(() => load(filter));
    return stop;
  }, [filter, load]);

  if (open) return <OwnerOrderDetail orderId={open} onBack={() => { setOpen(null); load(filter); }} />;

  return (
    <>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filterBar} contentContainerStyle={{ paddingHorizontal: 12 }}>
        {OWNER_ORDER_TABS.map((t) => (
          <TouchableOpacity key={t.id} style={[s.filterChip, filter === t.id && s.filterChipActive]} onPress={() => setFilter(t.id)}>
            <Text style={[s.filterChipText, filter === t.id && s.filterChipTextActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <ScrollView contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => load(filter)} tintColor={C.green} />}>
        {loading && <ActivityIndicator color={C.green} style={{ marginTop: 16 }} />}
        {!loading && orders.length === 0 && <Empty icon="receipt-outline" text={`No ${filter} orders.`} />}
        {orders.map((o) => (
          <TouchableOpacity key={o.id} style={s.card} onPress={() => setOpen(o.id)}>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{o.customerName || 'Customer'}</Text>
              <Text style={s.cardSub}>{o.id.slice(0, 8).toUpperCase()} · {formatINR(o.total)}</Text>
              <StatusPill status={o.status} />
            </View>
            <Ionicons name="chevron-forward" size={20} color={C.sub} />
          </TouchableOpacity>
        ))}
      </ScrollView>
    </>
  );
}

function OwnerOrderDetail({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const [loading, setLoading] = useState(true);
  const [order, setOrder] = useState<SB.OrderDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejectAsk, setRejectAsk] = useState(false);
  const [cancelAsk, setCancelAsk] = useState(false);
  const [notCollectAsk, setNotCollectAsk] = useState(false);
  const [billing, setBilling] = useState(false);
  const [altFor, setAltFor] = useState<string | null>(null);
  const [altName, setAltName] = useState('');
  const [altPrice, setAltPrice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { setOrder(await SB.orderDetails(orderId)); } catch {} finally { setLoading(false); }
  }, [orderId]);
  useEffect(() => { load(); }, [load]);

  const setAvail = async (itemId: string, a: ItemAvailability, name = '', price = 0) => {
    try { await SB.setItemAvailability(orderId, itemId, a, name, price); load(); }
    catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
  };

  const submitAlt = () => {
    if (!altFor || !altName.trim()) { Alert.alert(t('owner.suggestAlt'), 'Enter the alternative product'); return; }
    setAvail(altFor, 'alternative', altName.trim(), num(altPrice));
    setAltFor(null); setAltName(''); setAltPrice('');
  };

  const setStatus = async (status: OrderStatus, reason = '') => {
    setBusy(true);
    try { await SB.setOrderStatus(orderId, status, reason); load(); }
    catch (e: any) {
      // Accepting reserves stock. If the shelf can't cover it the order is
      // untouched — name the items so the owner's next move (an alternative,
      // or rejecting as out of stock) is obvious.
      const short = SB.shortfallsFrom(e);
      if (short?.length) {
        Alert.alert(
          'Not enough stock',
          short.map((x) => `${x.name}: you have ${x.available} ${x.unit}, the order wants ${x.wanted}`).join('\n')
            + '\n\nSuggest an alternative, mark the item unavailable, or reject the order.',
        );
        return;
      }
      Alert.alert('Error', e?.message ?? 'Try again');
    }
    finally { setBusy(false); }
  };

  const money = (n: number) => formatMoney(n, order?.currency || '₹');
  const next = order ? nextOrderStatus(order.status) : null;
  const reviewed = order ? order.items.every((it) => it.availability !== 'pending' && it.availability !== 'alternative') : false;
  const terminal = order && ['completed', 'cancelled', 'rejected', 'not_collected'].includes(order.status);
  // Ready orders wait for the customer; after 24h the owner can write one off.
  const uncollected = order
    ? notCollectedGate(order.status, order.timeline)
    : { allowed: false, hoursLeft: 0 };

  // Billing sits between packing and Ready: weigh out, price, then hand over.
  if (billing) return <BillScreen orderId={orderId} onBack={() => { setBilling(false); load(); }} />;

  return (
    <>
      <SubHeader title={t('owner.newOrder')} onBack={onBack} />
      <ReasonModal visible={rejectAsk} title={t('owner.rejectReason')} codes={REJECT_REASONS}
        onSubmit={(text, code) => setStatus('rejected', code === 'other' ? 'other' : code ?? 'other')}
        onClose={() => setRejectAsk(false)} />
      <ReasonModal visible={cancelAsk} title={t('orders.cancelReason')}
        onSubmit={(reason) => setStatus('cancelled', reason)} onClose={() => setCancelAsk(false)} />
      <ReasonModal visible={notCollectAsk} title="Why was it not collected?"
        onSubmit={(reason) => setStatus('not_collected', reason)} onClose={() => setNotCollectAsk(false)} />
      {/* alternative suggestion: name + price, cross-platform */}
      <Modal visible={altFor != null} transparent animationType="fade" onRequestClose={() => setAltFor(null)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>{t('owner.suggestAlt')}</Text>
            <TextInput style={s.input} placeholder={t('owner.altName')} placeholderTextColor={C.sub}
              value={altName} onChangeText={setAltName} autoFocus />
            <TextInput style={s.input} placeholder={t('owner.altPrice')} placeholderTextColor={C.sub}
              value={altPrice} onChangeText={setAltPrice} keyboardType="numeric" />
            <TouchableOpacity style={s.primaryBtn} onPress={submitAlt}>
              <Text style={s.primaryBtnText}>{t('common.save')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.dangerBtn} onPress={() => setAltFor(null)}>
              <Text style={s.dangerBtnText}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
      <ScrollView contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
        {order && (
          <>
            <StatusPill status={order.status} big />
            {!!order.note && <Text style={s.hint}>📝 {order.note}</Text>}
            {isTerminalFailure(order.status) && (
              <View style={[s.panel, { borderColor: C.danger }]}>
                <Text style={{ color: C.danger, fontWeight: '700' }}>
                  {order.status === 'rejected'
                    ? (REJECT_REASONS.find((r) => r.code === order.rejectReason)?.label ?? order.rejectReason)
                    : order.status === 'not_collected'
                      ? `Not collected: ${order.notCollectedReason === 'expired' ? 'closed automatically after 7 days' : order.notCollectedReason}`
                      : `${order.cancelledBy === 'customer' ? 'Customer cancelled' : 'Cancelled'}: ${order.cancelReason}`}
                </Text>
              </View>
            )}
            <Text style={s.sectionLabel}>Items — mark availability</Text>
            {order.items.map((it) => (
              <View key={it.id} style={s.card}>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>{it.name}{it.brand ? ` (${it.brand})` : ''}{it.unit ? ` · ${it.unit}` : ''} × {it.qty}</Text>
                  {!!it.note && <Text style={s.cardSub}>📝 {it.note}</Text>}
                  <AvailabilityTag a={it.availability} altName={it.altName} />
                  {order.status === 'pending' && (
                    <View style={{ flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                      <TouchableOpacity style={s.smallGreen} onPress={() => setAvail(it.id, 'available')}>
                        <Text style={s.smallGreenText}>{t('owner.markAvailable')}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={s.smallOutline} onPress={() => setAvail(it.id, 'unavailable')}>
                        <Text style={s.smallOutlineText}>{t('owner.markUnavailable')}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={s.smallOutline} onPress={() => { setAltFor(it.id); setAltName(''); setAltPrice(''); }}>
                        <Text style={s.smallOutlineText}>{t('owner.suggestAlt')}</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
                <Text style={s.price}>{it.price > 0 ? money(it.price * it.qty) : '—'}</Text>
              </View>
            ))}
            <View style={s.totalRow}>
              <Text style={s.totalLabel}>{t('common.total')}</Text>
              <Text style={s.totalValue}>{money(order.total)}</Text>
            </View>

            {!terminal && (
              <>
                {order.status === 'pending' && (
                  <>
                    {!reviewed && <Text style={s.hint}>⏳ {t('owner.reviewFirst')}</Text>}
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <TouchableOpacity
                        style={[s.primaryBtn, { flex: 2 }, (busy || !reviewed) && { opacity: 0.6 }]}
                        disabled={busy || !reviewed} onPress={() => setStatus('accepted')}>
                        <Ionicons name="checkmark-circle" size={18} color="#fff" />
                        <Text style={s.primaryBtnText}>{t('owner.accept')}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[s.dangerBtn, { flex: 1, marginTop: 12 }]} disabled={busy} onPress={() => setRejectAsk(true)}>
                        <Text style={s.dangerBtnText}>{t('owner.reject')}</Text>
                      </TouchableOpacity>
                    </View>
                  </>
                )}
                {/* Weigh out and price before the customer is told it's Ready
                    — after that the total is what they were quoted (P0-C). */}
                {['accepted', 'preparing', 'packing'].includes(order.status) && (
                  <TouchableOpacity style={s.outlineBtn} onPress={() => setBilling(true)}>
                    <Ionicons name="calculator-outline" size={18} color={C.green} />
                    <Text style={s.outlineBtnText}>Bill · {money(order.total)}</Text>
                  </TouchableOpacity>
                )}
                {order.status !== 'pending' && next && (
                  <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={() => setStatus(next)}>
                    <Ionicons name="arrow-forward-circle" size={18} color="#fff" />
                    <Text style={s.primaryBtnText}>{`Mark as ${orderStatusLabel(next)}`}</Text>
                  </TouchableOpacity>
                )}
                {/* Ready → Collected is the customer's to make; the shop can
                    only write the order off once it has waited 24h (D5a). */}
                {order.status === 'ready' && (
                  <>
                    <Text style={s.hint}>⏳ Waiting for the customer to confirm pickup.</Text>
                    <TouchableOpacity
                      style={[s.dangerBtn, (busy || !uncollected.allowed) && { opacity: 0.6 }]}
                      disabled={busy || !uncollected.allowed} onPress={() => setNotCollectAsk(true)}>
                      <Text style={s.dangerBtnText}>
                        {uncollected.allowed
                          ? 'Not collected'
                          : `Not collected · available in ${uncollected.hoursLeft}h`}
                      </Text>
                    </TouchableOpacity>
                  </>
                )}
                {canOwnerCancel(order.status) && order.status !== 'pending' && (
                  <TouchableOpacity style={s.dangerBtn} disabled={busy} onPress={() => setCancelAsk(true)}>
                    <Text style={s.dangerBtnText}>{t('orders.cancel')}</Text>
                  </TouchableOpacity>
                )}
              </>
            )}
          </>
        )}
      </ScrollView>
    </>
  );
}

function OwnerProducts({ shop }: { shop: SB.Shop }) {
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<SB.Product[]>([]);
  const [edit, setEdit] = useState<SB.Product | 'new' | 'bulk' | 'stock' | null>(null);
  const [seeding, setSeeding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setProducts(await SB.ownerProducts()); } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // One-tap category starter catalog (server-managed; spec: product-catalog).
  // Items land with price 0 + disabled — the owner prices and activates them.
  const seedStarter = async () => {
    setSeeding(true);
    try {
      const items = await SB.starterCatalog(shop.category);
      const have = new Set(products.map((p) => p.name.toLowerCase()));
      const fresh = items.filter((it) => !have.has(it.name.toLowerCase()));
      if (fresh.length === 0) { Alert.alert(t('owner.starterCatalog'), 'Your catalog already has these items.'); return; }
      await SB.bulkAddProducts(fresh.map((it) => ({ name: it.name, unit: it.unit, price: 0 })));
      Alert.alert(t('owner.starterCatalog'), t('owner.starterLoaded'));
      load();
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setSeeding(false); }
  };

  if (edit === 'bulk') return <BulkAdd onDone={() => { setEdit(null); load(); }} />;
  if (edit === 'stock') return <StockScreen currency={shop.currency} onBack={() => { setEdit(null); load(); }} />;
  if (edit) return <ProductEditor product={edit === 'new' ? null : edit} currency={shop.currency} onDone={() => { setEdit(null); load(); }} />;

  return (
    <ScrollView contentContainerStyle={s.body}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TouchableOpacity style={[s.primaryBtn, { flex: 1, marginTop: 0 }]} onPress={() => setEdit('new')}>
          <Ionicons name="add" size={18} color="#fff" />
          <Text style={s.primaryBtnText}>Add Product</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.outlineBtn, { flex: 1, marginTop: 0 }]} onPress={() => setEdit('bulk')}>
          <Ionicons name="documents-outline" size={18} color={C.green} />
          <Text style={s.outlineBtnText}>Bulk add</Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity style={[s.outlineBtn, seeding && { opacity: 0.6 }]} disabled={seeding} onPress={seedStarter}>
        {seeding ? <ActivityIndicator color={C.green} /> : <Ionicons name="sparkles-outline" size={18} color={C.green} />}
        <Text style={s.outlineBtnText}>{t('owner.starterCatalog')} · {categoryLabel(shop.category)}</Text>
      </TouchableOpacity>
      {products.some((p) => p.trackStock) && (
        <TouchableOpacity style={s.outlineBtn} onPress={() => setEdit('stock')}>
          <Ionicons name="cube-outline" size={18} color={C.green} />
          <Text style={s.outlineBtnText}>Stock</Text>
        </TouchableOpacity>
      )}
      {loading && <ActivityIndicator color={C.green} style={{ marginTop: 16 }} />}
      {!loading && products.length === 0 && <Empty icon="pricetags-outline" text="No products yet." />}
      {products.map((p) => (
        <TouchableOpacity key={p.id} style={s.card} onPress={() => setEdit(p)}>
          <View style={{ flex: 1 }}>
            <Text style={[s.cardTitle, !p.enabled && { color: C.sub }]}>{p.name}{p.unit ? ` · ${p.unit}` : ''}</Text>
            <Text style={s.cardSub}>{[p.brand, p.category].filter(Boolean).join(' · ')}</Text>
            <Text style={s.price}>{formatMoney(p.price, shop.currency)} · {p.inStock ? 'In stock' : 'Out of stock'}{!p.enabled ? ' · Disabled' : ''}</Text>
          </View>
          <Ionicons name="create-outline" size={20} color={C.sub} />
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

function ProductEditor({ product, currency, onDone }: {
  product: SB.Product | null; currency?: string; onDone: () => void;
}) {
  const [name, setName] = useState(product?.name ?? '');
  const [brand, setBrand] = useState(product?.brand ?? '');
  const [category, setCategory] = useState(product?.category ?? '');
  const [unit, setUnit] = useState(product?.unit ?? '');
  const [price, setPrice] = useState(product ? String(product.price) : '');
  const [taxPercent, setTaxPercent] = useState(product && product.taxPercent > 0 ? String(product.taxPercent) : '');
  const [inStock, setInStock] = useState(product?.inStock ?? true);
  const [enabled, setEnabled] = useState(product?.enabled ?? true);
  // P0-B: counted stock is opt-in per product and Pro-gated server-side.
  const [trackStock, setTrackStock] = useState(product?.trackStock ?? false);
  const [costPrice, setCostPrice] = useState(product?.costPrice ? String(product.costPrice) : '');
  const [reorderLevel, setReorderLevel] = useState(product?.reorderLevel ? String(product.reorderLevel) : '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) { Alert.alert('Name required'); return; }
    setBusy(true);
    try {
      await SB.saveProduct({
        id: product?.id, name: name.trim(), brand: brand.trim(), category: category.trim(),
        unit: unit.trim(), price: num(price), taxPercent: num(taxPercent), inStock, enabled,
        trackStock, costPrice: num(costPrice), reorderLevel: num(reorderLevel),
      });
      onDone();
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  const del = async () => {
    if (!product) return;
    setBusy(true);
    try { await SB.deleteProduct(product.id); onDone(); }
    catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <SubHeader title={product ? 'Edit Product' : 'Add Product'} onBack={onDone} />
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <Field label="Product name" value={name} onChange={setName} placeholder="Aashirvaad Atta" />
        <Field label="Brand (optional)" value={brand} onChange={setBrand} placeholder="Aashirvaad" />
        <Field label="Category" value={category} onChange={setCategory} placeholder="Groceries" />
        <Field label="Unit" value={unit} onChange={setUnit} placeholder="5kg" />
        <Field label={`Price (${currency || '₹'})`} value={price} onChange={setPrice} placeholder="285" keyboardType="numeric" />
        <Field label="Tax % (optional)" value={taxPercent} onChange={setTaxPercent} placeholder="5" keyboardType="numeric" />
        <Field label={`Cost price (${currency || '₹'}, optional)`} value={costPrice} onChange={setCostPrice}
          placeholder="240" keyboardType="numeric" />
        <ToggleRow label="Count stock for this product" value={trackStock} onChange={setTrackStock} />
        {trackStock ? (
          <>
            <Text style={s.hint}>
              Stock is counted, reserved when you accept an order, and consumed when the
              customer collects. Record what you have on the Stock tab.
            </Text>
            <Field label="Reorder level (alert below this)" value={reorderLevel} onChange={setReorderLevel}
              placeholder="5" keyboardType="numeric" />
          </>
        ) : (
          <ToggleRow label="In stock" value={inStock} onChange={setInStock} />
        )}
        <ToggleRow label="Enabled (visible to customers)" value={enabled} onChange={setEnabled} />
        <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={save}>
          <Text style={s.primaryBtnText}>{product ? 'Save Changes' : 'Add Product'}</Text>
        </TouchableOpacity>
        {product && (
          <TouchableOpacity style={s.dangerBtn} disabled={busy} onPress={del}>
            <Text style={s.dangerBtnText}>Delete Product</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </>
  );
}

// The customer's side of a return (P1-B): pick lines and quantities, say why.
// The refund figure comes back from the server, priced from the ORIGINAL line —
// a price rise since the sale must not change what is owed back.
function ReturnRequest({ order, onDone }: { order: SB.OrderDetail; onDone: () => void }) {
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(clientKey());
  const money = (n: number) => formatMoney(n, order.currency);

  const lines = order.items.filter((i) => i.availability !== 'unavailable' && !i.removed);

  const submit = async () => {
    const items = lines
      .map((l) => ({ orderItemId: l.id, qty: num(qty[l.id] ?? '') }))
      .filter((x) => x.qty > 0);
    if (items.length === 0) { Alert.alert('Choose what you are returning'); return; }
    if (!reason.trim()) { Alert.alert('Tell the shop why', 'A reason is required.'); return; }
    setBusy(true);
    try {
      const r = await SB.requestReturn(order.id, reason.trim(), items, key.current);
      key.current = clientKey();
      Alert.alert('Return requested',
        `The shop will review it. If approved, ${money(r.refundTotal)} will be credited to your account.`);
      onDone();
    } catch (e: any) {
      Alert.alert(e?.body?.code === 'return_window_closed' ? 'Too late to return' : 'Could not request',
        e?.message ?? 'Try again');
    } finally { setBusy(false); }
  };

  return (
    <>
      <SubHeader title="Return an item" onBack={onDone} />
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <Text style={s.hint}>
          Enter how much of each item is coming back. You can return part of a line.
        </Text>
        {lines.map((l) => {
          const billed = l.qty;
          return (
            <View key={l.id} style={s.card}>
              <View style={{ flex: 1 }}>
                <Text style={s.cardTitle}>{l.name}{l.brand ? ` (${l.brand})` : ''}</Text>
                <Text style={s.cardSub}>
                  You were billed {billed}{l.unit ? ` ${l.unit}` : ''} · {money(l.price)} each
                </Text>
              </View>
              <TextInput
                style={[s.input, { width: 80, marginBottom: 0, paddingVertical: 6, textAlign: 'center' }]}
                keyboardType="numeric" placeholder="0" placeholderTextColor={C.sub}
                value={qty[l.id] ?? ''} onChangeText={(v) => setQty({ ...qty, [l.id]: v })} />
            </View>
          );
        })}
        <Field label="Why are you returning it?" value={reason} onChange={setReason}
          placeholder="e.g. Bag was torn" />
        <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={submit}>
          {busy ? <ActivityIndicator color="#fff" />
                : <Text style={s.primaryBtnText}>Request return</Text>}
        </TouchableOpacity>
        <Text style={s.hint}>
          The shop reviews every return. Your original bill is never changed — an approved
          return produces a separate credit note.
        </Text>
      </ScrollView>
    </>
  );
}

// Purchases (P1-A). Stock arriving with a price on it — the other half of a
// sale, and the only thing that makes margin computable.
function PurchasesScreen({ currency, onBack }: { currency?: string; onBack: () => void }) {
  const [rows, setRows] = useState<SB.PurchaseSummary[]>([]);
  const [spend, setSpend] = useState(0);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [supplier, setSupplier] = useState('');
  const [invNo, setInvNo] = useState('');
  const [items, setItems] = useState<SB.PurchaseItemInput[]>([]);
  const [products, setProducts] = useState<SB.Product[]>([]);
  const [pick, setPick] = useState<SB.Product | null>(null);
  const [qty, setQty] = useState('');
  const [cost, setCost] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(clientKey());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await SB.purchases();
      setRows(r.purchases); setSpend(r.totalSpend);
      setProducts(await SB.ownerProducts());
    } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const money = (n: number) => formatMoney(n, currency);

  const addLine = () => {
    if (!pick || num(qty) <= 0) { Alert.alert('Pick a product and a quantity'); return; }
    setItems([...items, {
      productId: pick.id, name: pick.name, unit: pick.unit,
      qty: num(qty), costPrice: num(cost), taxPercent: pick.taxPercent,
    }]);
    setPick(null); setQty(''); setCost('');
  };

  const save = async () => {
    if (items.length === 0) { Alert.alert('Add at least one item'); return; }
    setBusy(true);
    try {
      await SB.createPurchase({
        supplierName: supplier.trim(), invoiceNumber: invNo.trim(),
        items, idempotencyKey: key.current,
      });
      key.current = clientKey();
      setAdding(false); setSupplier(''); setInvNo(''); setItems([]);
      load();
    } catch (e: any) {
      // The server refuses the same supplier invoice twice — that double-count
      // is the classic mistake when moving off paper.
      Alert.alert(e?.body?.code === 'duplicate_supplier_invoice'
        ? 'Already recorded' : 'Could not save', e?.message ?? 'Try again');
    } finally { setBusy(false); }
  };

  if (adding) {
    const draftTotal = items.reduce((s, it) => s + it.qty * it.costPrice, 0);
    return (
      <>
        <SubHeader title="Record a purchase" onBack={() => setAdding(false)} />
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <Field label="Supplier" value={supplier} onChange={setSupplier} placeholder="Metro Wholesale" />
          <Field label="Their invoice number" value={invNo} onChange={setInvNo} placeholder="MW-8891" />
          <Text style={s.hint}>
            The invoice number stops the same delivery being entered twice.
          </Text>

          <Text style={s.sectionLabel}>Items</Text>
          {items.map((it, i) => (
            <View key={i} style={s.card}>
              <View style={{ flex: 1 }}>
                <Text style={s.cardTitle}>{it.name}{it.unit ? ` · ${it.unit}` : ''}</Text>
                <Text style={s.cardSub}>{it.qty} × {money(it.costPrice)}</Text>
              </View>
              <TouchableOpacity onPress={() => setItems(items.filter((_, j) => j !== i))}>
                <Ionicons name="trash-outline" size={18} color={C.danger} />
              </TouchableOpacity>
            </View>
          ))}

          <View style={s.panel}>
            <Text style={s.panelTitle}>Add an item</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {products.map((p) => (
                  <Chip key={p.id} label={p.name} icon="cube-outline"
                    active={pick?.id === p.id} onPress={() => setPick(p)} />
                ))}
              </View>
            </ScrollView>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Field label="Quantity" value={qty} onChange={setQty} placeholder="10" keyboardType="numeric" />
              </View>
              <View style={{ flex: 1 }}>
                <Field label={`Cost each (${currency || '₹'})`} value={cost} onChange={setCost}
                  placeholder="200" keyboardType="numeric" />
              </View>
            </View>
            <TouchableOpacity style={s.outlineBtn} onPress={addLine}>
              <Ionicons name="add" size={18} color={C.green} />
              <Text style={s.outlineBtnText}>Add to purchase</Text>
            </TouchableOpacity>
          </View>

          {items.length > 0 && (
            <View style={s.panel}>
              <Row label="Goods total (before tax)" value={money(draftTotal)} bold />
              <Text style={s.hint}>{`Tax is added by the server from each product's rate.`}</Text>
            </View>
          )}
          <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={save}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryBtnText}>Save purchase</Text>}
          </TouchableOpacity>
        </ScrollView>
      </>
    );
  }

  return (
    <>
      <SubHeader title="Purchases" onBack={onBack} />
      <ScrollView contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
        <TouchableOpacity style={[s.primaryBtn, { marginTop: 0 }]} onPress={() => setAdding(true)}>
          <Ionicons name="add" size={18} color="#fff" />
          <Text style={s.primaryBtnText}>Record a purchase</Text>
        </TouchableOpacity>
        {rows.length > 0 && (
          <View style={s.panel}>
            <Row label="Total spend" value={money(spend)} bold />
          </View>
        )}
        {!loading && rows.length === 0 && (
          <Empty icon="cart-outline" text="No purchases yet. Recording what stock costs is what makes profit reporting possible." />
        )}
        {rows.map((p) => (
          <View key={p.id} style={s.card}>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{p.supplierName || 'Supplier'}</Text>
              <Text style={s.cardSub}>
                {p.purchasedOn}{p.invoiceNumber ? ` · ${p.invoiceNumber}` : ''} · {p.itemCount} item(s)
              </Text>
            </View>
            <Text style={s.price}>{money(p.total)}</Text>
          </View>
        ))}
      </ScrollView>
    </>
  );
}

// Returns (P1-B). The owner decides; approval issues a credit note and puts
// sellable goods back. Refusing requires saying why.
function ReturnsScreen({ currency, onBack }: { currency?: string; onBack: () => void }) {
  const [rows, setRows] = useState<SB.ShopReturn[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refuse, setRefuse] = useState<SB.ShopReturn | null>(null);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { setRows(await SB.shopReturns()); } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const money = (n: number) => formatMoney(n, currency);

  const approve = (rt: SB.ShopReturn) => {
    Alert.alert('Approve this return?',
      `${money(rt.refundTotal)} will be credited to ${rt.customerName || 'the customer'}, and a credit note issued against the original invoice.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Approve · goods resellable',
          onPress: () => void decide(rt, true, true),
        },
        {
          text: 'Approve · goods damaged',
          onPress: () => void decide(rt, true, false),
        },
      ]);
  };

  const decide = async (rt: SB.ShopReturn, ok: boolean, restock = true, why = '') => {
    setBusy(true);
    try {
      await SB.decideReturn(rt.id, ok, { restock, note: why, settlement: 'credit' });
      setRefuse(null); setNote(''); load();
    } catch (e: any) { Alert.alert('Could not record', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <SubHeader title="Returns" onBack={onBack} />
      <Modal visible={!!refuse} transparent animationType="fade" onRequestClose={() => setRefuse(null)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>Why are you declining?</Text>
            <Text style={s.hint}>The customer sees this. A refusal with no reason is the most complained-about outcome of any returns process.</Text>
            <TextInput style={s.input} placeholder="e.g. Item shows use beyond inspection"
              placeholderTextColor={C.sub} value={note} onChangeText={setNote} autoFocus multiline />
            <TouchableOpacity style={s.dangerBtn}
              onPress={() => { if (note.trim() && refuse) void decide(refuse, false, true, note.trim()); }}>
              <Text style={s.dangerBtnText}>Decline return</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.outlineBtn} onPress={() => setRefuse(null)}>
              <Text style={s.outlineBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <ScrollView contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
        {!loading && rows.length === 0 && <Empty icon="arrow-undo-outline" text="No returns." />}
        {rows.map((rt) => (
          <View key={rt.id} style={s.card}>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{rt.customerName || 'Customer'} · {money(rt.refundTotal)}</Text>
              <Text style={s.cardSub}>📝 {rt.reason}</Text>
              {!!rt.decisionNote && <Text style={s.cardSub}>↳ {rt.decisionNote}</Text>}
              <Text style={[s.cardSub, {
                color: rt.status === 'completed' ? C.green : rt.status === 'rejected' ? C.danger : C.sub,
              }]}>
                {rt.status === 'requested' ? 'Awaiting your decision' : rt.status}
              </Text>
              {rt.status === 'requested' && (
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                  <TouchableOpacity style={[s.primaryBtn, { flex: 1, marginTop: 0 }]}
                    disabled={busy} onPress={() => approve(rt)}>
                    <Text style={s.primaryBtnText}>Approve</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[s.dangerBtn, { flex: 1, marginTop: 0 }]}
                    disabled={busy} onPress={() => { setRefuse(rt); setNote(''); }}>
                    <Text style={s.dangerBtnText}>Decline</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </View>
        ))}
      </ScrollView>
    </>
  );
}

// The shop's own audit trail (P1-F). Append-only server-side; read-only here.
function AuditScreen({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<SB.AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try { setRows(await SB.auditLog()); } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const describe = (e: SB.AuditEntry) => {
    const b = e.before ?? {}, a = e.after ?? {};
    switch (e.action) {
      case 'product.price_change': return `${a.name ?? 'Product'}: ${b.price} → ${a.price}`;
      case 'product.create':       return `Added ${a.name}`;
      case 'purchase.create':      return `${a.supplier ?? 'Purchase'} · ${a.items} item(s)`;
      case 'return.approve':       return `Return approved · refund ${a.refundTotal}`;
      case 'return.reject':        return 'Return declined';
      case 'document.upload':      return `Uploaded ${a.kind}`;
      case 'verification.submit':  return 'Submitted for verification';
      case 'location.request':     return 'Requested a location change';
      default:
        if (e.action.startsWith('stock.')) return `Stock ${b.onHand} → ${a.onHand}`;
        return e.action;
    }
  };

  return (
    <>
      <SubHeader title="Activity log" onBack={onBack} />
      <ScrollView contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
        <Text style={s.hint}>
          Every price change, stock correction, purchase and refund. This record cannot be edited or deleted — including by you.
        </Text>
        {!loading && rows.length === 0 && <Empty icon="document-text-outline" text="Nothing recorded yet." />}
        {rows.map((e) => (
          <View key={e.id} style={s.card}>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{describe(e)}</Text>
              <Text style={s.cardSub}>
                {e.actor || 'Owner'} · {new Date(e.at).toLocaleString('en-IN')}
              </Text>
              {!!e.reason && <Text style={s.cardSub}>📝 {e.reason}</Text>}
            </View>
          </View>
        ))}
      </ScrollView>
    </>
  );
}

// Verification (P1-D): what's missing, what's uploaded, and where it stands.
function VerificationScreen({ onBack }: { onBack: () => void }) {
  const [docs, setDocs] = useState<SB.ShopDocument[]>([]);
  const [accepted, setAccepted] = useState<string[]>([]);
  const [state, setState] = useState<SB.VerifyState>('unverified');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await SB.shopDocuments();
      setDocs(r.documents); setAccepted(r.accepted ?? []);
      setState(r.verifyState); setNote(r.verifyNote);
    } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    setBusy(true);
    try {
      const r = await SB.submitVerification();
      setState(r.verifyState);
      Alert.alert('Submitted', 'Your shop is now queued for review.');
    } catch (e: any) {
      const missing = SB.missingForVerification(e);
      Alert.alert(missing ? 'Not ready yet' : 'Could not submit',
        missing ? `Still needed:\n• ${missing.join('\n• ')}` : (e?.message ?? 'Try again'));
    } finally { setBusy(false); }
  };

  const view = async (d: SB.ShopDocument) => {
    try {
      const { url } = await SB.documentUrl(d.id);
      Linking.openURL(url);
    } catch (e: any) { Alert.alert('Could not open', e?.message ?? 'Try again'); }
  };

  const STATE_COPY: Record<SB.VerifyState, { label: string; tone: string; hint: string }> = {
    unverified:     { label: 'Not verified', tone: C.sub, hint: 'Verified shops get a badge customers can see.' },
    pending_review: { label: 'Under review', tone: C.amber, hint: 'We are looking at your shop. Nothing more is needed from you.' },
    verified:       { label: 'Verified ✅', tone: C.green, hint: 'Your address is now fixed — moving it needs approval.' },
    rejected:       { label: 'Not approved', tone: C.danger, hint: 'Fix what is noted below and submit again.' },
    suspended:      { label: 'Suspended', tone: C.danger, hint: 'Your shop is not listed. Contact support.' },
  };
  const copy = STATE_COPY[state];

  return (
    <>
      <SubHeader title="Verification" onBack={onBack} />
      <ScrollView contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
        <View style={s.panel}>
          <Text style={[s.panelTitle, { color: copy.tone }]}>{copy.label}</Text>
          <Text style={s.hint}>{copy.hint}</Text>
          {!!note && <Text style={[s.cardSub, { color: C.danger, marginTop: 6 }]}>📝 {note}</Text>}
        </View>

        {accepted.length > 0 && (
          <>
            <Text style={s.sectionLabel}>Documents for your country</Text>
            <Text style={s.hint}>All optional — upload whichever apply to your business.</Text>
          </>
        )}
        {accepted.map((kind) => {
          const have = docs.find((d) => d.kind === kind);
          return (
            <View key={kind} style={s.card}>
              <View style={{ flex: 1 }}>
                <Text style={s.cardTitle}>{kind}</Text>
                <Text style={[s.cardSub, {
                  color: have?.status === 'accepted' ? C.green
                       : have?.status === 'rejected' ? C.danger : C.sub,
                }]}>
                  {have ? (have.status === 'pending' ? 'Uploaded · awaiting review' : have.status) : 'Not uploaded'}
                </Text>
                {!!have?.reviewNote && <Text style={[s.cardSub, { color: C.danger }]}>{have.reviewNote}</Text>}
              </View>
              {have && (
                <TouchableOpacity onPress={() => view(have)}>
                  <Ionicons name="eye-outline" size={20} color={C.green} />
                </TouchableOpacity>
              )}
            </View>
          );
        })}
        <Text style={s.hint}>
          Documents are uploaded from Shop Settings and are visible only to you and the review team.
        </Text>

        {(state === 'unverified' || state === 'rejected') && (
          <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={submit}>
            {busy ? <ActivityIndicator color="#fff" />
                  : <Text style={s.primaryBtnText}>Submit for verification</Text>}
          </TouchableOpacity>
        )}
      </ScrollView>
    </>
  );
}

// Live bill (P0-C). The owner weighs out what they packed and the total moves.
//
// Every number on this screen came from the server's last response. The client
// holds no arithmetic at all: it posts the change, and re-renders whatever
// comes back. That is why a customer can never be charged a total this screen
// invented.
function BillScreen({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const [bill, setBill] = useState<SB.Bill | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [qtyDraft, setQtyDraft] = useState<Record<string, string>>({});
  const [discount, setDiscount] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addQty, setAddQty] = useState('1');
  const [addPrice, setAddPrice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const b = await SB.getBill(orderId);
      setBill(b);
      setDiscount(b.billDiscount > 0 ? String(b.billDiscount) : '');
    } catch (e: any) { Alert.alert('Bill', e?.message ?? 'Could not load'); }
    finally { setLoading(false); }
  }, [orderId]);
  useEffect(() => { load(); }, [load]);

  // One helper for every edit: post it, take the server's bill as the truth.
  const patch = async (p: SB.BillUpdate) => {
    setBusy(true);
    try { setBill(await SB.updateBill(orderId, p)); }
    catch (e: any) { Alert.alert('Could not update the bill', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  const money = (n: number) => formatMoney(n, bill?.currency ?? '₹');

  if (loading || !bill) {
    return (
      <>
        <SubHeader title="Bill" onBack={onBack} />
        <ActivityIndicator color={C.green} style={{ marginTop: 24 }} />
      </>
    );
  }

  return (
    <>
      <SubHeader title="Bill" onBack={onBack} />
      <Modal visible={addOpen} transparent animationType="fade" onRequestClose={() => setAddOpen(false)}>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>Add an item</Text>
            <TextInput style={s.input} placeholder="Item name" placeholderTextColor={C.sub}
              value={addName} onChangeText={setAddName} autoFocus />
            <TextInput style={s.input} placeholder="Quantity" placeholderTextColor={C.sub}
              keyboardType="numeric" value={addQty} onChangeText={setAddQty} />
            <TextInput style={s.input} placeholder={`Price (${bill.currency}) — catalog items price themselves`}
              placeholderTextColor={C.sub} keyboardType="numeric" value={addPrice} onChangeText={setAddPrice} />
            <TouchableOpacity style={s.primaryBtn} onPress={() => {
              const name = addName.trim();
              if (!name) return;
              setAddOpen(false);
              void patch({ add: { name, qty: Math.max(0, num(addQty)) || 1, price: num(addPrice) } });
              setAddName(''); setAddQty('1'); setAddPrice('');
            }}>
              <Text style={s.primaryBtnText}>Add</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.dangerBtn} onPress={() => setAddOpen(false)}>
              <Text style={s.dangerBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        {!bill.editable && (
          <Text style={[s.hint, { color: C.danger }]}>
            This bill is final — the order has moved past packing.
          </Text>
        )}
        {bill.lines.filter((l) => l.availability !== 'unavailable').map((l) => (
          <View key={l.id} style={[s.card, l.removed && { opacity: 0.45 }]}>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{l.name}{l.brand ? ` (${l.brand})` : ''}</Text>
              <Text style={s.cardSub}>
                Ordered {l.requestedQty}{l.unit ? ` ${l.unit}` : ''} · {money(l.price)}
                {l.taxPercent > 0 ? ` · ${l.taxPercent}% tax` : ''}
              </Text>
              {bill.editable && !l.removed && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  <Text style={s.cardSub}>Packed</Text>
                  <TextInput
                    style={[s.input, { width: 90, marginBottom: 0, paddingVertical: 6 }]}
                    keyboardType="numeric"
                    placeholder={String(l.requestedQty)} placeholderTextColor={C.sub}
                    value={qtyDraft[l.id] ?? (l.weighed ? String(l.fulfilledQty) : '')}
                    onChangeText={(v) => setQtyDraft({ ...qtyDraft, [l.id]: v })}
                    onBlur={() => {
                      const raw = qtyDraft[l.id];
                      if (raw == null) return;
                      // Empty clears back to "as requested" rather than zero —
                      // a blank box must never silently mean "packed nothing".
                      void patch({ lines: [{ id: l.id, fulfilledQty: raw.trim() === '' ? null : num(raw) }] });
                      setQtyDraft({ ...qtyDraft, [l.id]: undefined as any });
                    }}
                  />
                  <TouchableOpacity onPress={() => patch({ lines: [{ id: l.id, removed: true }] })}>
                    <Ionicons name="trash-outline" size={18} color={C.danger} />
                  </TouchableOpacity>
                </View>
              )}
              {l.removed && bill.editable && (
                <TouchableOpacity onPress={() => patch({ lines: [{ id: l.id, removed: false }] })}>
                  <Text style={[s.cardSub, { color: C.green }]}>Put back</Text>
                </TouchableOpacity>
              )}
            </View>
            <Text style={s.price}>{money(l.total)}</Text>
          </View>
        ))}

        {bill.editable && (
          <>
            <TouchableOpacity style={s.outlineBtn} onPress={() => setAddOpen(true)}>
              <Ionicons name="add" size={18} color={C.green} />
              <Text style={s.outlineBtnText}>Add an item</Text>
            </TouchableOpacity>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
              <View style={{ flex: 1 }}>
                <Field label={`Discount (${bill.currency})`} value={discount} onChange={setDiscount}
                  placeholder="0" keyboardType="numeric" />
              </View>
              <TouchableOpacity style={[s.outlineBtn, { marginTop: 0, paddingHorizontal: 18 }]}
                onPress={() => patch({ billDiscount: num(discount) })}>
                <Text style={s.outlineBtnText}>Apply</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        <View style={s.panel}>
          <Row label="Item subtotal" value={money(bill.subtotal)} />
          {bill.discount > 0 && <Row label="Discount" value={`− ${money(bill.discount)}`} tone={C.green} />}
          {bill.taxTotal > 0 && <Row label="Tax" value={money(bill.taxTotal)} />}
          {bill.deliveryFee > 0 && <Row label="Delivery" value={money(bill.deliveryFee)} />}
          {bill.roundOff !== 0 && (
            <Row label="Round off" value={`${bill.roundOff > 0 ? '+' : '−'} ${money(Math.abs(bill.roundOff))}`} />
          )}
          <View style={{ height: 1, backgroundColor: C.border, marginVertical: 6 }} />
          <Row label="Total" value={money(bill.total)} bold />
        </View>
        {busy && <ActivityIndicator color={C.green} />}
        <Text style={s.hint}>
          Totals are calculated by the server from the quantities you record here.
        </Text>
      </ScrollView>
    </>
  );
}

// Stock (P0-B). Deliberately one screen: the position, and the one action that
// changes it. Every change needs a reason, because the movement ledger is only
// worth keeping if it answers "where did 8 kg go?".
function StockScreen({ currency, onBack }: { currency?: string; onBack: () => void }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<SB.StockRow[]>([]);
  const [lowCount, setLowCount] = useState(0);
  const [sel, setSel] = useState<SB.StockRow | null>(null);
  const [kind, setKind] = useState<SB.StockMoveKind>('purchase');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<SB.StockMovement[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await SB.stockList();
      setRows(r.stock); setLowCount(r.lowCount);
    } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const openItem = async (row: SB.StockRow) => {
    setSel(row); setQty(''); setReason(''); setKind('purchase'); setHistory([]);
    try { setHistory(await SB.stockMovements(row.productId)); } catch {}
  };

  const submit = async () => {
    if (!sel) return;
    const q = num(qty);
    if (q === 0) { Alert.alert('Enter a quantity'); return; }
    if (!reason.trim()) { Alert.alert('Reason required', 'Stock never changes silently.'); return; }
    setBusy(true);
    try {
      await SB.adjustStock(sel.productId, kind, q, reason.trim());
      setSel(null); load();
    } catch (e: any) { Alert.alert('Could not record', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  const KINDS: { k: SB.StockMoveKind; label: string }[] = [
    { k: 'purchase', label: 'Stock in' },
    { k: 'opening', label: 'Opening' },
    { k: 'damage', label: 'Damaged' },
    { k: 'return', label: 'Returned' },
    { k: 'adjustment', label: 'Correction' },
  ];

  if (sel) {
    return (
      <>
        <SubHeader title={sel.name} onBack={() => setSel(null)} />
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <StatCard label="On hand" value={String(sel.onHand)} tone="navy" />
            <StatCard label="Reserved" value={String(sel.reserved)} tone="amber" />
            <StatCard label="Available" value={String(sel.available)} tone={sel.low ? 'danger' : 'green'} />
          </View>
          <View style={s.panel}>
            <Text style={s.panelTitle}>Record a movement</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
              {KINDS.map((k) => (
                <Chip key={k.k} label={k.label} icon="cube-outline"
                  active={kind === k.k} onPress={() => setKind(k.k)} />
              ))}
            </View>
            <Field label={`Quantity (${sel.unit || 'units'})`} value={qty} onChange={setQty}
              placeholder={kind === 'adjustment' ? '-2 or 5' : '10'} keyboardType="numeric" />
            <Field label="Reason" value={reason} onChange={setReason}
              placeholder={kind === 'damage' ? 'Dropped a crate' : 'Supplier delivery'} />
            <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={submit}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryBtnText}>Record</Text>}
            </TouchableOpacity>
          </View>
          <Text style={s.sectionLabel}>History</Text>
          {history.length === 0 && <Empty icon="time-outline" text="No movements yet." />}
          {history.map((m) => {
            const d = m.onHandDelta || m.reservedDelta;
            return (
              <View key={m.id} style={s.card}>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>{m.kind.replace(/_/g, ' ')}</Text>
                  <Text style={s.cardSub}>
                    {[m.reason, m.actor].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                <Text style={[s.price, { color: d < 0 ? C.danger : C.green }]}>
                  {d > 0 ? '+' : ''}{d}{m.reservedDelta && !m.onHandDelta ? ' held' : ''}
                </Text>
              </View>
            );
          })}
        </ScrollView>
      </>
    );
  }

  return (
    <>
      <SubHeader title="Stock" onBack={onBack} />
      <ScrollView contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
        {lowCount > 0 && (
          <Text style={[s.hint, { color: C.danger }]}>
            ⚠️ {lowCount} product(s) at or below their reorder level.
          </Text>
        )}
        {loading && <ActivityIndicator color={C.green} style={{ marginTop: 16 }} />}
        {!loading && rows.length === 0 && (
          <Empty icon="cube-outline" text="No counted products. Turn on “Count stock” on a product to start." />
        )}
        {rows.map((row) => (
          <TouchableOpacity key={row.productId} style={s.card} onPress={() => openItem(row)}>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{row.name}{row.unit ? ` · ${row.unit}` : ''}</Text>
              <Text style={s.cardSub}>
                {row.available} available{row.reserved > 0 ? ` · ${row.reserved} reserved` : ''}
                {row.costPrice > 0 ? ` · cost ${formatMoney(row.costPrice, currency)}` : ''}
              </Text>
            </View>
            {row.low && <Text style={[s.price, { color: C.danger }]}>LOW</Text>}
            <Ionicons name="chevron-forward" size={18} color={C.sub} />
          </TouchableOpacity>
        ))}
      </ScrollView>
    </>
  );
}

function BulkAdd({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => parseBulkProducts(text), [text]);

  const save = async () => {
    if (parsed.length === 0) { Alert.alert('Nothing to add', 'Paste one product per line.'); return; }
    setBusy(true);
    try {
      const res = await SB.bulkAddProducts(parsed.map((p) => ({ name: p.name, brand: p.brand, unit: p.unit, price: p.price })));
      Alert.alert('Added', `${res.added} product(s) added to your catalog.`);
      onDone();
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <SubHeader title="Bulk add products" onBack={onDone} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <Text style={s.hint}>
            Paste one product per line. Formats accepted:{'\n'}
            • Aashirvaad Atta 5kg 285{'\n'}
            • Tata Salt, Tata, 1kg, 20{'\n'}
            • Fortune Oil, 145
          </Text>
          <TextInput style={[s.input, { height: 200, textAlignVertical: 'top' }]} multiline
            placeholder={'Aashirvaad Atta 5kg 285\nFortune Oil 1L 145\nTata Salt 1kg 20'}
            placeholderTextColor={C.sub} value={text} onChangeText={setText} />
          {parsed.length > 0 && (
            <>
              <Text style={s.sectionLabel}>Preview · {parsed.length} product(s)</Text>
              {parsed.slice(0, 8).map((p, i) => (
                <View key={i} style={s.card}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.cardTitle}>{p.name}{p.unit ? ` · ${p.unit}` : ''}{p.brand ? ` (${p.brand})` : ''}</Text>
                  </View>
                  <Text style={s.price}>{formatINR(p.price)}</Text>
                </View>
              ))}
              {parsed.length > 8 && <Text style={s.hint}>…and {parsed.length - 8} more</Text>}
            </>
          )}
          <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={save}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryBtnText}>Add {parsed.length || ''} product(s)</Text>}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

function OwnerKhata() {
  const [loading, setLoading] = useState(true);
  const [customers, setCustomers] = useState<SB.CustomerPending[]>([]);
  const [sel, setSel] = useState<SB.CustomerPending | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setCustomers(await SB.ownerLedgerSummary()); } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (sel) return <KhataDetail customer={sel} onBack={() => { setSel(null); load(); }} />;

  return (
    <ScrollView contentContainerStyle={s.body}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
      <Text style={s.sectionLabel}>Customer Khata</Text>
      {loading && <ActivityIndicator color={C.green} style={{ marginTop: 16 }} />}
      {!loading && customers.length === 0 && <Empty icon="people-outline" text="No customer ledgers yet." />}
      {customers.map((c) => (
        <TouchableOpacity key={c.customerId} style={s.card} onPress={() => setSel(c)}>
          <View style={s.shopIcon}><Ionicons name="person" size={20} color={C.green} /></View>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>{c.customerName || 'Customer'}</Text>
            <Text style={[s.price, { color: c.pending > 0 ? C.danger : C.green }]}>
              {c.pending > 0 ? `Pending ${formatINR(c.pending)}` : 'Settled'}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={C.sub} />
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

function KhataDetail({ customer, onBack }: { customer: SB.CustomerPending; onBack: () => void }) {
  const [loading, setLoading] = useState(true);
  const [ledger, setLedger] = useState<SB.Ledger | null>(null);
  const [amount, setAmount] = useState('');
  const [remark, setRemark] = useState('');
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState<SB.PaymentMethod>('cash');

  const load = useCallback(async () => {
    setLoading(true);
    try { setLedger(await SB.ownerCustomerLedger(customer.customerId)); } catch {} finally { setLoading(false); }
  }, [customer.customerId]);
  useEffect(() => { load(); }, [load]);

  // A key per entry the owner is composing: a retry of THIS payment resolves
  // to the row already written, but the next payment gets its own key.
  const entryKey = useRef(clientKey());

  const add = async (type: 'purchase' | 'payment') => {
    const amt = num(amount);
    if (amt <= 0) { Alert.alert('Enter an amount'); return; }
    setBusy(true);
    try {
      if (type === 'payment') {
        // Money received is a payment RECORD — method and reference included,
        // and it posts its own khata entry server-side (P0-E). Partial is
        // normal: whatever is left simply stays pending.
        await SB.recordPayment({
          customerId: customer.customerId, amount: amt, method,
          reference: remark.trim(), idempotencyKey: entryKey.current,
        });
      } else {
        await SB.addLedgerEntry(customer.customerId, type, amt, remark.trim(), entryKey.current);
      }
      entryKey.current = clientKey();
      setAmount(''); setRemark(''); load();
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  const remind = async () => {
    setBusy(true);
    try {
      const res = await SB.sendReminder(customer.customerId);
      Alert.alert(res.sent ? 'Reminder sent' : 'Nothing to remind',
        res.sent ? 'A payment reminder was pushed to the customer.' : 'This customer has no pending balance.');
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <SubHeader title={customer.customerName || 'Customer'} onBack={onBack} />
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
        {ledger && (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <StatCard label="Pending" value={formatINR(ledger.pending)} tone="danger" />
            <StatCard label="Paid" value={formatINR(ledger.totalPaid)} tone="green" />
          </View>
        )}
        {(ledger?.pending ?? 0) > 0 && (
          <TouchableOpacity style={[s.outlineBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={remind}>
            <Ionicons name="notifications-outline" size={18} color={C.green} />
            <Text style={s.outlineBtnText}>Send payment reminder</Text>
          </TouchableOpacity>
        )}
        <View style={s.panel}>
          <Text style={s.panelTitle}>Add entry</Text>
          <TextInput style={s.input} placeholder="Amount (₹)" placeholderTextColor={C.sub}
            keyboardType="numeric" value={amount} onChangeText={setAmount} />
          <TextInput style={s.input} placeholder="Reference / remark (UPI ref, cheque no…)"
            placeholderTextColor={C.sub} value={remark} onChangeText={setRemark} />
          {/* How the money arrived. Recorded on the payment, not guessed from
              the remark — reconciliation later depends on it. */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            {(['cash', 'upi', 'bank', 'card', 'other'] as SB.PaymentMethod[]).map((m) => (
              <Chip key={m} label={m.toUpperCase()} icon="cash-outline"
                active={method === m} onPress={() => setMethod(m)} />
            ))}
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity style={[s.primaryBtn, { flex: 1 }, busy && { opacity: 0.6 }]} disabled={busy} onPress={() => add('purchase')}>
              <Text style={s.primaryBtnText}>+ Purchase</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.outlineBtn, { flex: 1 }]} disabled={busy} onPress={() => add('payment')}>
              <Text style={s.outlineBtnText}>+ Payment</Text>
            </TouchableOpacity>
          </View>
        </View>
        <Text style={s.sectionLabel}>History</Text>
        {ledger?.entries.length === 0 && <Empty icon="book-outline" text="No transactions yet." />}
        {ledger?.entries.map((e) => <LedgerRow key={e.id} entry={e} />)}
      </ScrollView>
    </>
  );
}

function ShopSettings({ shop, me, onSaved, onCancel }: {
  shop: SB.Shop | null; me: { id: string; name: string } | null;
  onSaved: (s: SB.Shop) => void; onCancel?: () => void;
}) {
  const [name, setName] = useState(shop?.name ?? '');
  const [category, setCategory] = useState(shop?.category ?? 'grocery');
  const [address, setAddress] = useState(shop?.address ?? '');
  const [phone, setPhone] = useState(shop?.phone ?? '');
  const [openTime, setOpenTime] = useState(shop?.openTime ?? '09:00');
  const [closeTime, setCloseTime] = useState(shop?.closeTime ?? '21:00');
  const [status, setStatus] = useState(shop?.status ?? 'open');
  const [pickup, setPickup] = useState(shop?.pickup ?? true);
  const [prep, setPrep] = useState(shop ? String(shop.prepMins) : '20');
  const [weeklyHoliday, setWeeklyHoliday] = useState(shop?.weeklyHoliday ?? '');
  const [lunchStart, setLunchStart] = useState(shop?.lunchStart ?? '');
  const [lunchEnd, setLunchEnd] = useState(shop?.lunchEnd ?? '');
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(
    shop?.lat != null && shop?.lng != null ? { lat: shop.lat, lng: shop.lng } : null);
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  // Country Tax Engine: selecting a country loads its currency + optional
  // tax fields (spec: country-tax-engine). All tax fields stay optional.
  const [countryList, setCountryList] = useState<SB.CountryConfig[]>([]);
  const [country, setCountry] = useState(shop?.country ?? 'IN');
  const [taxConfig, setTaxConfig] = useState<Record<string, string | boolean>>(shop?.taxConfig ?? {});
  useEffect(() => { (async () => {
    try { setCountryList(await SB.countries()); } catch {}
  })(); }, []);
  const countryCfg = countryList.find((c2) => c2.code === country);

  // Capture the shop's GPS location. `silent` skips the success alert (used for
  // the frictionless auto-capture when a new shop form first opens). Returns the
  // captured coords (or null) so the caller can use them without waiting on state.
  const useLocation = async (silent = false): Promise<{ lat: number; lng: number } | null> => {
    setLocating(true);
    try {
      const { status: perm } = await Location.requestForegroundPermissionsAsync();
      if (perm !== 'granted') {
        if (!silent) {
          Alert.alert(
            'Location needed',
            'A shop location is required so nearby customers can find you and see how far away you are. Please enable location permission in Settings.',
          );
        }
        return null;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const c = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      setCoords(c);
      if (!silent) Alert.alert('Location set', 'Your shop location was captured.');
      return c;
    } catch {
      if (!silent) Alert.alert('Could not get location', 'Please try again with GPS on.');
      return null;
    } finally { setLocating(false); }
  };

  // Auto-capture location the first time a new shop is being created, so most
  // owners never have to think about it — location is required to save.
  useEffect(() => {
    if (!shop && !coords) { useLocation(true); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (!name.trim()) { Alert.alert('Shop name required'); return; }
    // Location is mandatory — it's what powers nearby discovery + distance.
    let loc = coords;
    if (!loc) {
      loc = await useLocation();
      if (!loc) {
        Alert.alert('Shop location required', 'Tap “Use current location” to set where your shop is, then save.');
        return;
      }
    }
    setBusy(true);
    try {
      await SB.saveShop({
        name: name.trim(), category, address: address.trim(), phone: phone.trim(),
        openTime: openTime.trim(), closeTime: closeTime.trim(), status,
        pickup, prepMins: num(prep), weeklyHoliday,
        lunchStart: lunchStart.trim(), lunchEnd: lunchEnd.trim(),
        lat: loc.lat, lng: loc.lng,
        country, taxConfig,
      });
      const fresh = await SB.myShop();
      if (fresh) onSaved(fresh);
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <SubHeader title={shop ? 'Shop Settings' : 'Create Your Shop'} onBack={onCancel} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          {!shop && <Text style={s.hint}>Set up your shop once — customers nearby can then find you and order.</Text>}
          <Field label="Shop name" value={name} onChange={setName} placeholder="Sri Lakshmi Kirana" />
          <Text style={s.fieldLabel}>Category</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
            {SHOP_CATEGORIES.map((c2) => (
              <Chip key={c2.id} label={c2.label} icon={c2.icon} active={category === c2.id} onPress={() => setCategory(c2.id)} />
            ))}
          </ScrollView>
          <Field label="Address" value={address} onChange={setAddress} placeholder="#10, Main Road" />
          <Field label="Phone" value={phone} onChange={setPhone} placeholder="98765 43210" keyboardType="phone-pad" />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}><Field label="Opens" value={openTime} onChange={setOpenTime} placeholder="09:00" /></View>
            <View style={{ flex: 1 }}><Field label="Closes" value={closeTime} onChange={setCloseTime} placeholder="21:00" /></View>
          </View>
          <Field label="Prep time (mins)" value={prep} onChange={setPrep} placeholder="20" keyboardType="numeric" />
          <ToggleRow label="Pickup available" value={pickup} onChange={setPickup} />

          <Text style={s.fieldLabel}>Lunch break (optional)</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}><Field label="From" value={lunchStart} onChange={setLunchStart} placeholder="13:30" /></View>
            <View style={{ flex: 1 }}><Field label="To" value={lunchEnd} onChange={setLunchEnd} placeholder="16:30" /></View>
          </View>

          <Text style={s.fieldLabel}>Weekly holiday</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
            <Chip label="None" icon="—" active={weeklyHoliday === ''} onPress={() => setWeeklyHoliday('')} />
            {[['sun','Sun'],['mon','Mon'],['tue','Tue'],['wed','Wed'],['thu','Thu'],['fri','Fri'],['sat','Sat']].map(([id, lbl]) => (
              <Chip key={id} label={lbl} icon="📅" active={weeklyHoliday === id} onPress={() => setWeeklyHoliday(id)} />
            ))}
          </ScrollView>

          <Text style={s.fieldLabel}>Shop status</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            {([
              ['open', `🟢 ${t('owner.status.open')}`], ['busy', `🟡 ${t('owner.status.busy')}`],
              ['closed', `🔴 ${t('owner.status.closed')}`], ['holiday', `📅 ${t('owner.status.holiday')}`],
              ['vacation', `🏖️ ${t('owner.status.vacation')}`],
            ] as const).map(([st, lbl]) => (
              <TouchableOpacity key={st} style={[s.statusBtn, status === st && s.statusBtnActive]} onPress={() => setStatus(st)}>
                <Text style={[s.statusBtnText, status === st && { color: '#fff' }]}>{lbl}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Country + tax engine */}
          <Text style={s.fieldLabel}>{t('owner.country')}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
            {countryList.map((c2) => (
              <Chip key={c2.code} label={`${c2.name} (${c2.currencySymbol})`} icon="🌍"
                active={country === c2.code} onPress={() => setCountry(c2.code)} />
            ))}
          </ScrollView>
          {countryCfg && (
            <>
              <Text style={s.fieldLabel}>{t('owner.taxDetails')} — {countryCfg.taxType}</Text>
              <Text style={s.hint}>{t('owner.taxNote')}</Text>
              {countryCfg.taxFields.map((f) => f.type === 'bool' ? (
                <ToggleRow key={f.id} label={f.label} value={taxConfig[f.id] === true}
                  onChange={(v) => setTaxConfig((cfg) => ({ ...cfg, [f.id]: v }))} />
              ) : (
                <Field key={f.id} label={f.label}
                  value={typeof taxConfig[f.id] === 'string' ? (taxConfig[f.id] as string) : ''}
                  onChange={(v) => setTaxConfig((cfg) => ({ ...cfg, [f.id]: v }))}
                  placeholder={f.label} />
              ))}
              {countryCfg.documents.length > 0 && (
                <Text style={s.hint}>📄 Optional documents for verification: {countryCfg.documents.join(', ')}</Text>
              )}
            </>
          )}

          <Text style={s.fieldLabel}>Shop location (required)</Text>
          <TouchableOpacity style={[s.outlineBtn, locating && { opacity: 0.6 }]} disabled={locating} onPress={() => useLocation()}>
            {locating
              ? <ActivityIndicator color={C.green} />
              : <Ionicons name={coords ? 'checkmark-circle' : 'location'} size={18} color={C.green} />}
            <Text style={s.outlineBtnText}>
              {locating ? 'Getting location…' : coords ? 'Location captured ✓ — update' : 'Use current location'}
            </Text>
          </TouchableOpacity>
          {!coords && !locating && (
            <Text style={s.hint}>📍 Required so nearby customers can find your shop and see the distance.</Text>
          )}
          <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={save}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryBtnText}>{shop ? 'Save Settings' : 'Create Shop'}</Text>}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

// ════════════════════════════════════════════════════════════════
//  upgrade surfaces — notification inbox, reason modal, invoice
// ════════════════════════════════════════════════════════════════

function NotificationCenter({ onBack, onRead }: { onBack: () => void; onRead: () => void }) {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<SB.Notification[]>([]);
  const load = useCallback(async () => {
    setLoading(true);
    try { setItems((await SB.notifications()).notifications); } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const markAll = async () => {
    try { await SB.markNotificationsRead(); onRead(); load(); } catch {}
  };

  return (
    <>
      <SubHeader title={t('notif.title')} onBack={onBack}
        right={{ icon: 'checkmark-done-outline', onPress: markAll }} />
      <ScrollView contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
        {!loading && items.length === 0 && <Empty icon="notifications-off-outline" text={t('notif.empty')} />}
        {items.map((n) => (
          <View key={n.id} style={[s.card, !n.read && { borderColor: C.green }]}>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{n.title}</Text>
              {!!n.body && <Text style={s.cardSub}>{n.body}</Text>}
              <Text style={[s.cardSub, { fontSize: 11 }]}>{new Date(n.createdAt).toLocaleString('en-IN')}</Text>
            </View>
            {!n.read && <View style={[s.pillDot, { backgroundColor: C.green }]} />}
          </View>
        ))}
        {items.length > 0 && (
          <TouchableOpacity style={s.outlineBtn} onPress={markAll}>
            <Ionicons name="checkmark-done" size={18} color={C.green} />
            <Text style={s.outlineBtnText}>{t('notif.markAllRead')}</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </>
  );
}

// Cross-platform "why?" prompt (Alert.prompt is iOS-only): free-text reason,
// optionally preceded by the fixed rejection reason codes.
function ReasonModal({ visible, title, codes, placeholder, onSubmit, onClose }: {
  visible: boolean; title: string; codes?: typeof REJECT_REASONS;
  placeholder?: string; onSubmit: (reason: string, code?: string) => void; onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => { if (visible) { setText(''); setCode(null); } }, [visible]);
  const needText = !codes || code === 'other';
  const submit = () => {
    if (codes && !code) { Alert.alert(title, 'Pick a reason'); return; }
    if (needText && !text.trim()) { Alert.alert(title, 'Please give a reason'); return; }
    onSubmit(text.trim(), code ?? undefined);
    onClose();
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.modalWrap}>
        <View style={s.modalCard}>
          <Text style={s.modalTitle}>{title}</Text>
          {codes && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 10 }}>
              {codes.map((rc) => (
                <TouchableOpacity key={rc.code} style={[s.chip, code === rc.code && s.chipActive]}
                  onPress={() => setCode(rc.code)}>
                  <Text style={[s.chipText, code === rc.code && { color: '#fff' }]}>{rc.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          {needText && (
            <TextInput style={s.input} placeholder={placeholder ?? 'Reason'} placeholderTextColor={C.sub}
              value={text} onChangeText={setText} autoFocus />
          )}
          <TouchableOpacity style={s.primaryBtn} onPress={submit}>
            <Text style={s.primaryBtnText}>{t('common.save')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.dangerBtn} onPress={onClose}>
            <Text style={s.dangerBtnText}>{t('common.cancel')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// Country-rule-driven invoice (spec: invoicing). Tax lines appear only when
// the shop configured tax details — the backend snapshot decides, not the UI.
function InvoiceView({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const [inv, setInv] = useState<SB.Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { (async () => {
    try { setInv(await SB.orderInvoice(orderId)); }
    catch (e: any) { Alert.alert('Invoice', e?.message ?? 'Not available yet'); }
    finally { setLoading(false); }
  })(); }, [orderId]);

  const sharePdf = async () => {
    if (!inv) return;
    const money = (n: number) => formatMoney(n, inv.currency);
    const taxRows = inv.taxBreakdown.map((b) =>
      `<p style="text-align:right;margin:2px 0;color:#333">${b.label}: ${money(b.amount)}</p>`).join('');
    const taxIds = Object.entries(inv.business.tax ?? {})
      .filter(([, v]) => v && v !== true).map(([k, v]) => `${k.toUpperCase()}: ${v}`).join(' · ');
    const rows = inv.items.map((it) =>
      `<tr><td style="padding:6px 0">${it.name}${it.brand ? ` (${it.brand})` : ''}${it.unit ? ` · ${it.unit}` : ''}</td>
       <td style="text-align:center">${it.qty}</td>
       <td style="text-align:right">${money(it.price * it.qty)}</td></tr>`).join('');
    const html = `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="font-family:-apple-system,Roboto,sans-serif;color:#111;padding:28px">
        <h2 style="color:#0B7A3B;margin:0">${inv.business.name}</h2>
        <p style="color:#666;margin:4px 0">${inv.business.address}${inv.business.phone ? ` · ${inv.business.phone}` : ''}</p>
        ${taxIds ? `<p style="color:#666;margin:2px 0;font-size:13px">${taxIds}</p>` : ''}
        <p style="margin:12px 0 4px"><b>${inv.invoiceNo}</b> · ${new Date(inv.createdAt).toLocaleDateString('en-IN')}</p>
        <p style="color:#666;margin:0 0 14px">Billed to: ${inv.customerName || 'Customer'}</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <thead><tr style="border-bottom:1px solid #ddd"><th align="left">Item</th><th>Qty</th><th align="right">Amount</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <hr style="margin:14px 0;border:none;border-top:1px solid #eee"/>
        <p style="text-align:right;margin:2px 0">Subtotal: ${money(inv.subtotal)}</p>
        ${inv.discount > 0 ? `<p style="text-align:right;margin:2px 0;color:#0B7A3B">Discount: − ${money(inv.discount)}</p>` : ''}
        ${taxRows}
        <h3 style="text-align:right;margin:8px 0">Total: ${money(inv.total)}</h3>
        <p style="color:#888;font-size:12px;text-align:center;margin-top:22px">Thank you for shopping with us!</p>
      </body></html>`;
    try {
      const { uri } = await Print.printToFileAsync({ html });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: inv.invoiceNo });
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Could not create the invoice PDF'); }
  };

  const money = (n: number) => formatMoney(n, inv?.currency ?? '₹');
  return (
    <>
      <SubHeader title={t('orders.invoice')} onBack={onBack}
        right={inv ? { icon: 'share-social-outline', onPress: sharePdf } : undefined} />
      <ScrollView contentContainerStyle={s.body}>
        {loading && <ActivityIndicator color={C.green} style={{ marginTop: 24 }} />}
        {inv && (
          <>
            <View style={s.panel}>
              <Text style={[s.cardSub, { textTransform: 'uppercase', letterSpacing: 1 }]}>
                {inv.kind === 'tax' ? 'Tax Invoice' : 'Invoice'}
              </Text>
              <Text style={s.panelTitle}>{inv.business.name}</Text>
              {!!inv.business.address && <Text style={s.cardSub}>{inv.business.address}</Text>}
              {/* Only the tax identifiers the shop actually filled in — a
                  blank statutory field on a retail bill reads as an error. */}
              {Object.entries(inv.business.tax ?? {})
                .filter(([, v]) => v && v !== true)
                .map(([k, v]) => (
                  <Text key={k} style={s.cardSub}>{k.toUpperCase()}: {String(v)}</Text>
                ))}
              <Text style={s.cardSub}>
                {inv.invoiceNo} · {new Date(inv.createdAt).toLocaleDateString('en-IN')}
              </Text>
              {!!inv.customerName && <Text style={s.cardSub}>Billed to: {inv.customerName}</Text>}
              {/* A business buyer's own details — present only on a tax invoice,
                  which is the document they can reclaim against. */}
              {!!inv.buyer?.businessName && <Text style={s.cardSub}>{inv.buyer.businessName}</Text>}
              {!!inv.buyer?.taxNumber && <Text style={s.cardSub}>Buyer tax no: {inv.buyer.taxNumber}</Text>}
              {!!inv.buyer?.address && <Text style={s.cardSub}>{inv.buyer.address}</Text>}
              {inv.status === 'cancelled' && (
                <Text style={[s.cardSub, { color: C.danger, fontWeight: '700' }]}>CANCELLED</Text>
              )}
            </View>
            {inv.items.map((it, i) => (
              <View key={`${it.name}-${i}`} style={s.card}>
                <View style={{ flex: 1 }}>
                  <Text style={s.cardTitle}>{it.name}{it.brand ? ` (${it.brand})` : ''} × {it.qty}</Text>
                  {!!it.unit && <Text style={s.cardSub}>{it.unit}</Text>}
                </View>
                <Text style={s.price}>{money(it.price * it.qty)}</Text>
              </View>
            ))}
            <View style={s.panel}>
              <Row label="Item subtotal" value={money(inv.subtotal)} />
              {inv.discount > 0 && <Row label="Discount" value={`− ${money(inv.discount)}`} tone={C.green} />}
              {inv.taxBreakdown.map((b) => <Row key={b.label} label={b.label} value={money(b.amount)} />)}
              {inv.roundOff !== 0 && (
                <Row label="Round off" value={`${inv.roundOff > 0 ? '+' : '−'} ${money(Math.abs(inv.roundOff))}`} />
              )}
              <View style={{ height: 1, backgroundColor: C.border, marginVertical: 6 }} />
              <Row label={t('common.total')} value={money(inv.total)} bold />
            </View>

            {/* What is actually still owed. Derived from the payments, so it
                cannot claim money that never arrived. */}
            <View style={[s.panel, inv.due > 0 && { borderColor: C.danger }]}>
              <Row label="Paid" value={money(inv.paid)} tone={C.green} />
              {inv.due > 0 && <Row label="Amount due" value={money(inv.due)} tone={C.danger} bold />}
              {inv.due <= 0 && inv.paid > 0 && (
                <Text style={[s.hint, { color: C.green, marginTop: 4 }]}>✓ Paid in full</Text>
              )}
            </View>
            <TouchableOpacity style={s.primaryBtn} onPress={sharePdf}>
              <Ionicons name="download-outline" size={18} color="#fff" />
              <Text style={s.primaryBtnText}>PDF</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </>
  );
}

// ════════════════════════════════════════════════════════════════
//  shared bits
// ════════════════════════════════════════════════════════════════
function TabBar({ tabs, active, onChange }: {
  tabs: { id: string; label: string; icon: keyof typeof Ionicons.glyphMap }[];
  active: string; onChange: (id: string) => void;
}) {
  return (
    <View style={s.tabBar}>
      {tabs.map((t) => (
        <TouchableOpacity key={t.id} style={s.tab} onPress={() => onChange(t.id)}>
          <Ionicons name={t.icon} size={22} color={active === t.id ? C.green : C.sub} />
          <Text style={[s.tabLabel, active === t.id && { color: C.green, fontWeight: '700' }]}>{t.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function SubHeader({ title, onBack, right }: {
  title: string; onBack?: () => void;
  right?: { icon: keyof typeof Ionicons.glyphMap; badge?: number; onPress: () => void };
}) {
  return (
    <View style={s.subHeader}>
      {onBack ? (
        <TouchableOpacity onPress={onBack} hitSlop={10} style={s.hBtn}>
          <Ionicons name="arrow-back" size={22} color={C.text} />
        </TouchableOpacity>
      ) : <View style={{ width: 38 }} />}
      <Text style={s.subHeaderTitle} numberOfLines={1}>{title}</Text>
      {right ? (
        <TouchableOpacity onPress={right.onPress} hitSlop={10} style={s.hBtn}>
          <Ionicons name={right.icon} size={22} color={C.text} />
          {!!right.badge && <View style={s.cartBadge}><Text style={s.cartBadgeText}>{right.badge}</Text></View>}
        </TouchableOpacity>
      ) : <View style={{ width: 38 }} />}
    </View>
  );
}

function Chip({ label, icon, active, onPress }: { label: string; icon: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[s.chip, active && s.chipActive]} onPress={onPress}>
      <Text style={{ fontSize: 13 }}>{icon}</Text>
      <Text style={[s.chipText, active && { color: '#fff' }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone: 'green' | 'navy' | 'amber' | 'danger' }) {
  const color = tone === 'green' ? C.green : tone === 'navy' ? C.navy : tone === 'amber' ? C.amber : C.danger;
  return (
    <View style={[s.statCard, { flex: 1 }]}>
      <Text style={[s.statValue, { color }]}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

// Directions to the shop via the app's own turn-by-turn (Valhalla) — the same
// openNavigation seam every other location surface uses. No external maps app,
// works on no-GMS devices.
function openDirections(shop: SB.Shop) {
  if (shop.lat == null || shop.lng == null) return;
  navigateTo(shop.lat, shop.lng, shop.name || 'Shop');
}

function InfoRow({ icon, label, value }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string }) {
  return (
    <View style={s.infoRow}>
      <Ionicons name={icon} size={18} color={C.sub} />
      <Text style={s.infoLabel}>{label}</Text>
      <Text style={s.infoValue} numberOfLines={2}>{value}</Text>
    </View>
  );
}

function Field({ label, value, onChange, placeholder, keyboardType }: {
  label: string; value: string; onChange: (t: string) => void; placeholder?: string;
  keyboardType?: 'default' | 'numeric' | 'phone-pad';
}) {
  return (
    <>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput style={s.input} value={value} onChangeText={onChange} placeholder={placeholder}
        placeholderTextColor={C.sub} keyboardType={keyboardType ?? 'default'} />
    </>
  );
}

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={s.toggleRow}>
      <Text style={s.toggleLabel}>{label}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: C.green }} />
    </View>
  );
}

function StatusPill({ status, big }: { status: OrderStatus; big?: boolean }) {
  const done = status === 'completed' || status === 'collected';
  const color = isTerminalFailure(status) ? C.danger : done ? C.green : C.blue;
  return (
    <View style={[s.pill, { backgroundColor: color + '20' }, big && { alignSelf: 'flex-start', marginBottom: 12 }]}>
      <View style={[s.pillDot, { backgroundColor: color }]} />
      <Text style={[s.pillText, { color }, big && { fontSize: 15 }]}>{orderStatusLabel(status)}</Text>
    </View>
  );
}

function AvailabilityTag({ a, altName }: { a: ItemAvailability; altName: string }) {
  if (a === 'pending') return <Text style={[s.availTag, { color: C.sub }]}>⏳ Awaiting shop</Text>;
  if (a === 'available') return <Text style={[s.availTag, { color: C.green }]}>✓ Available</Text>;
  if (a === 'unavailable') return <Text style={[s.availTag, { color: C.danger }]}>✕ Not available</Text>;
  return <Text style={[s.availTag, { color: C.amber }]}>🔁 Alternative: {altName}</Text>;
}

function LedgerRow({ entry }: { entry: SB.LedgerEntry }) {
  const isPay = entry.type === 'payment';
  return (
    <View style={s.card}>
      <View style={{ flex: 1 }}>
        <Text style={s.cardTitle}>{isPay ? 'Payment received' : 'Purchase'}</Text>
        <Text style={s.cardSub}>{new Date(entry.createdAt).toLocaleDateString('en-IN')}{entry.remark ? ` · ${entry.remark}` : ''}</Text>
      </View>
      <Text style={[s.price, { color: isPay ? C.green : C.danger }]}>
        {isPay ? '−' : '+'}{formatINR(entry.amount)}
      </Text>
    </View>
  );
}

function Empty({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) {
  return (
    <View style={s.empty}>
      <Ionicons name={icon} size={40} color={C.border} />
      <Text style={s.emptyText}>{text}</Text>
    </View>
  );
}

// ── styles ─────────────────────────────────────────────────────────
const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: C.green,
    paddingTop: 48, paddingBottom: 14, paddingHorizontal: 14, gap: 6,
  },
  hBtn: { width: 38, height: 38, borderRadius: 19, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { color: '#fff', fontSize: 20, fontWeight: '800' },
  headerSub: { color: '#DCFCE7', fontSize: 12, marginTop: 1 },
  modeRow: { flexDirection: 'row', backgroundColor: C.greenDark, padding: 6, gap: 6 },
  modeBtn: {
    flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6,
    paddingVertical: 9, borderRadius: 10, backgroundColor: '#fff',
  },
  modeBtnActive: { backgroundColor: C.navy },
  modeText: { color: C.green, fontWeight: '700', fontSize: 13 },
  modeTextActive: { color: '#fff' },

  subHeader: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: C.card,
    paddingTop: 12, paddingBottom: 12, paddingHorizontal: 8,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  subHeaderTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: C.text },
  cartBadge: {
    position: 'absolute', top: 2, right: 2, backgroundColor: C.danger,
    borderRadius: 9, minWidth: 18, height: 18, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 4,
  },
  cartBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },

  body: { padding: 14, paddingBottom: 32 },

  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.card,
    borderRadius: 12, paddingHorizontal: 12, borderWidth: 1, borderColor: C.border, marginBottom: 4,
  },
  searchInput: { flex: 1, paddingVertical: 11, color: C.text, fontSize: 14 },
  hint: { color: C.sub, fontSize: 12.5, marginVertical: 8, lineHeight: 18 },
  error: { color: C.danger, textAlign: 'center', marginTop: 16 },

  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: C.card,
    borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7, marginRight: 8,
    borderWidth: 1, borderColor: C.border,
  },
  chipActive: { backgroundColor: C.green, borderColor: C.green },
  chipText: { color: C.text, fontSize: 12.5, fontWeight: '600' },

  card: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.card,
    borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: C.border,
  },
  shopIcon: {
    width: 46, height: 46, borderRadius: 12, backgroundColor: C.greenSoft,
    justifyContent: 'center', alignItems: 'center',
  },
  cardTitle: { color: C.text, fontSize: 15, fontWeight: '700' },
  cardSub: { color: C.sub, fontSize: 12.5, marginTop: 2 },
  price: { color: C.text, fontSize: 13.5, fontWeight: '700', marginTop: 4 },

  badge: { alignSelf: 'flex-start', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, marginTop: 6 },
  badgeDist: { backgroundColor: C.greenSoft, borderWidth: 1, borderColor: '#BBF7D0' },
  locBanner: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#FEF3C7', borderWidth: 1, borderColor: '#FCD34D', borderRadius: 12, padding: 12, marginBottom: 12 },
  locBannerTitle: { fontSize: 14, fontWeight: '700', color: '#92400E' },
  locBannerSub: { fontSize: 12, color: '#92400E', marginTop: 2, lineHeight: 16 },
  badgeOpen: { backgroundColor: C.greenSoft },
  badgeSoon: { backgroundColor: '#FEF3C7' },
  badgeClosed: { backgroundColor: '#FEE2E2' },
  badgeText: { fontSize: 11, fontWeight: '700', color: C.green },

  addBtn: { backgroundColor: C.green, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 9 },
  addBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },

  panel: { backgroundColor: C.card, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: C.border, marginVertical: 8, gap: 8 },
  panelTitle: { color: C.text, fontSize: 14, fontWeight: '700' },
  sectionLabel: { color: C.text, fontSize: 15, fontWeight: '800', marginTop: 14, marginBottom: 8 },

  input: {
    backgroundColor: C.card, borderRadius: 10, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 12, paddingVertical: 11, color: C.text, fontSize: 14, marginBottom: 8,
  },
  fieldLabel: { color: C.sub, fontSize: 12.5, fontWeight: '600', marginBottom: 4 },

  primaryBtn: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8,
    backgroundColor: C.green, borderRadius: 12, paddingVertical: 14, marginTop: 8,
  },
  primaryBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  outlineBtn: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8,
    borderRadius: 12, paddingVertical: 13, marginTop: 8, borderWidth: 1.5, borderColor: C.green,
  },
  outlineBtnText: { color: C.green, fontWeight: '700', fontSize: 14 },
  dangerBtn: { alignItems: 'center', paddingVertical: 13, marginTop: 8 },
  dangerBtnText: { color: C.danger, fontWeight: '700', fontSize: 14 },

  smallGreen: { backgroundColor: C.green, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  smallGreenText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  smallOutline: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: C.border },
  smallOutlineText: { color: C.text, fontWeight: '600', fontSize: 12 },

  stickyCart: {
    flexDirection: 'row', justifyContent: 'space-between', backgroundColor: C.navy,
    borderRadius: 12, paddingVertical: 14, paddingHorizontal: 18, marginTop: 12,
  },
  stickyCartText: { color: '#fff', fontWeight: '800', fontSize: 15 },

  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  qtyBtn: { width: 30, height: 30, borderRadius: 8, backgroundColor: C.greenSoft, justifyContent: 'center', alignItems: 'center' },
  qtyBtnText: { color: C.green, fontSize: 18, fontWeight: '800' },
  qtyText: { minWidth: 22, textAlign: 'center', fontSize: 15, fontWeight: '700', color: C.text },

  totalRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: C.card, borderRadius: 12, padding: 14, marginTop: 8, borderWidth: 1, borderColor: C.border,
  },
  totalLabel: { color: C.sub, fontSize: 14, fontWeight: '600' },
  totalValue: { color: C.text, fontSize: 18, fontWeight: '800' },

  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  statCard: {
    minWidth: '46%', backgroundColor: C.card, borderRadius: 14, padding: 14,
    borderWidth: 1, borderColor: C.border,
  },
  statValue: { fontSize: 20, fontWeight: '800' },
  statLabel: { color: C.sub, fontSize: 12, marginTop: 2 },

  infoRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.card,
    borderRadius: 10, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: C.border,
  },
  infoLabel: { color: C.sub, fontSize: 13, width: 74 },
  infoValue: { flex: 1, color: C.text, fontSize: 13.5, fontWeight: '600' },

  toggleRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: C.card, borderRadius: 10, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: C.border,
  },
  toggleLabel: { color: C.text, fontSize: 14, flex: 1 },

  statusBtn: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  statusBtnActive: { backgroundColor: C.green, borderColor: C.green },
  statusBtnText: { fontSize: 12.5, fontWeight: '700', color: C.text },

  filterBar: { backgroundColor: C.card, borderBottomWidth: 1, borderBottomColor: C.border, maxHeight: 50 },
  filterChip: { paddingHorizontal: 14, paddingVertical: 8, marginVertical: 7, marginRight: 8, borderRadius: 18, backgroundColor: C.bg },
  filterChipActive: { backgroundColor: C.green },
  filterChipText: { color: C.sub, fontWeight: '700', fontSize: 13 },
  filterChipTextActive: { color: '#fff' },

  stepper: { flexDirection: 'row', marginVertical: 10 },
  stepDot: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: C.border, backgroundColor: C.card, justifyContent: 'center', alignItems: 'center' },
  stepDotDone: { backgroundColor: C.green, borderColor: C.green },
  stepLabel: { fontSize: 9.5, color: C.sub, marginTop: 4, textAlign: 'center' },

  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, marginTop: 6 },
  pillDot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { fontSize: 12, fontWeight: '700' },
  availTag: { fontSize: 12.5, fontWeight: '600', marginTop: 4 },

  empty: { alignItems: 'center', paddingVertical: 40, gap: 10 },
  emptyText: { color: C.sub, fontSize: 13.5 },

  tabBar: {
    flexDirection: 'row', backgroundColor: C.card, borderTopWidth: 1, borderTopColor: C.border,
    paddingBottom: 20, paddingTop: 8,
  },
  tab: { flex: 1, alignItems: 'center', gap: 2 },
  tabLabel: { fontSize: 11, color: C.sub },

  // ── Phase 2 ────────────────────────────────────────
  favCard: {
    width: 120, backgroundColor: C.card, borderRadius: 12, padding: 12, marginRight: 10,
    borderWidth: 1, borderColor: C.border, alignItems: 'center', gap: 4,
  },
  favName: { color: C.text, fontSize: 12.5, fontWeight: '700', textAlign: 'center' },
  favRating: { color: C.amber, fontSize: 11 },

  deliveryBadge: { backgroundColor: '#E0F2FE', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  deliveryBadgeText: { color: C.blue, fontSize: 11, fontWeight: '700' },

  offerCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.greenSoft,
    borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: '#BBF7D0',
  },
  offerText: { color: C.green, fontSize: 13.5, fontWeight: '700' },
  couponCode: {
    backgroundColor: C.green, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6,
    borderStyle: 'dashed', borderWidth: 1, borderColor: '#166534',
  },
  couponCodeText: { color: '#fff', fontSize: 12.5, fontWeight: '800', letterSpacing: 1 },

  stars: { color: C.amber, fontSize: 15, letterSpacing: 2 },
  reviewName: { color: C.sub, fontSize: 12, marginTop: 4, fontStyle: 'italic' },

  loyaltyCard: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: C.navy, borderRadius: 16,
    padding: 18, marginTop: 10,
  },
  loyaltyPoints: { color: '#fff', fontSize: 28, fontWeight: '800' },
  loyaltyTier: { color: '#93C5FD', fontSize: 13, fontWeight: '700', marginTop: 2 },
  loyaltySub: { color: '#CBD5E1', fontSize: 12, marginTop: 2 },

  linkCard: {
    flex: 1, backgroundColor: C.card, borderRadius: 14, padding: 16, alignItems: 'center',
    gap: 6, borderWidth: 1, borderColor: C.border,
  },
  linkCardText: { color: C.text, fontSize: 13, fontWeight: '700', textAlign: 'center' },

  // ── Phase 2b ───────────────────────────────────────
  row: { flexDirection: 'row', alignItems: 'center' },
  planTag: { borderRadius: 5, paddingHorizontal: 6, paddingVertical: 1 },
  planFree: { backgroundColor: C.border },
  planPro: { backgroundColor: C.navy },
  planTagText: { fontSize: 9.5, fontWeight: '800', color: C.sub, letterSpacing: .5 },

  planCard: { backgroundColor: C.card, borderRadius: 16, padding: 18, marginBottom: 12, borderWidth: 1, borderColor: C.border },
  planCardPro: { borderColor: C.navy, borderWidth: 1.5 },
  planCardActive: { borderColor: C.green, borderWidth: 2 },
  planName: { fontSize: 18, fontWeight: '800', color: C.green, flex: 1 },
  planPrice: { fontSize: 22, fontWeight: '800', color: C.green },
  planPer: { fontSize: 12, fontWeight: '600', color: C.sub },
  planFeat: { color: C.text, fontSize: 13, marginTop: 7 },
  btn2Tag: { marginTop: 12, backgroundColor: C.greenSoft, borderRadius: 10, paddingVertical: 11, alignItems: 'center' },
  btn2TagText: { color: C.green, fontWeight: '800', fontSize: 13 },

  barTrack: { height: 8, borderRadius: 4, backgroundColor: C.border, marginTop: 5, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4, backgroundColor: C.green },
  rankDot: { width: 26, height: 26, borderRadius: 13, backgroundColor: C.greenSoft, justifyContent: 'center', alignItems: 'center' },
  rankDotText: { color: C.green, fontWeight: '800', fontSize: 12 },

  // ── Phase 2c ───────────────────────────────────────
  micBtn: {
    width: 44, height: 44, borderRadius: 10, borderWidth: 1.5, borderColor: C.green,
    justifyContent: 'center', alignItems: 'center', backgroundColor: C.card,
  },
  micBtnOn: { backgroundColor: C.green, borderColor: C.green },
  findProductBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.greenSoft,
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, marginTop: 8,
    borderWidth: 1, borderColor: '#BBF7D0',
  },
  findProductText: { color: C.green, fontWeight: '700', fontSize: 13.5 },
  modalWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 26 },
  modalCard: { backgroundColor: C.card, borderRadius: 18, padding: 20 },
  modalTitle: { color: C.text, fontSize: 18, fontWeight: '800', textAlign: 'center' },
});
