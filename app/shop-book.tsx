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

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet,
  Alert, ActivityIndicator, RefreshControl, Switch, Platform, KeyboardAvoidingView, Share, Modal,
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
  canCustomerCancel, canOwnerCancel, canCustomerConfirmCollection, REJECT_REASONS,
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

  const add = (name: string, brand: string, qty: number, price: number, note: string, unit = '', taxPercent = 0) => {
    setCart([...cart, { key: clientKey(), name, brand, qty, price, note, unit, taxPercent }]);
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
            <Text style={s.price}>{formatMoney(p.price, shop.currency)}{!p.inStock ? '  ·  Out of stock' : ''}</Text>
          </View>
          <TouchableOpacity style={[s.addBtn, !p.inStock && { opacity: 0.4 }]} disabled={!p.inStock}
            onPress={() => add(p.name, p.brand, 1, p.price, '', p.unit, p.taxPercent)}>
            <Text style={s.addBtnText}>Add</Text>
          </TouchableOpacity>
        </View>
      ))}

      {cart.length > 0 && (
        <TouchableOpacity style={s.stickyCart} onPress={onCart}>
          <Text style={s.stickyCartText}>View Cart ({cart.length})</Text>
          <Text style={s.stickyCartText}>{formatMoney(cartTotal(cart), shop.currency)}</Text>
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
    if (subtotal < found.minOrder) { setCouponMsg(`Min order ${formatMoney(found.minOrder, shop.currency)}`); setApplied(null); return; }
    setApplied(found); setCouponMsg(`Applied · ${couponLabel(found)}`);
  };

  const place = async () => {
    if (cart.length === 0) return;
    setPlacing(true);
    try {
      const res = await SB.placeOrder(
        shop.id,
        cart.map((it) => ({
          name: it.name, brand: it.brand, qty: it.qty, price: it.price, note: it.note,
          unit: it.unit, taxPercent: it.taxPercent,
        })),
        note.trim(),
        { couponCode: applied?.code },
      );
      onPlaced(res.id);
    } catch (e: any) {
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
            <Text style={s.price}>{it.price > 0 ? formatMoney(it.price, shop.currency) : 'Price on confirm'}</Text>
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
            <Row label="Subtotal" value={formatMoney(subtotal, shop.currency)} />
            {discount > 0 && <Row label={`Discount (${applied?.code})`} value={`− ${formatMoney(discount, shop.currency)}`} tone={C.green} />}
            <View style={{ height: 1, backgroundColor: C.border, marginVertical: 6 }} />
            <Row label={t('common.total')} value={formatMoney(total, shop.currency)} bold />
          </View>

          <TouchableOpacity style={[s.primaryBtn, placing && { opacity: 0.6 }]} disabled={placing} onPress={place}>
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

function OrderTrack({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const [loading, setLoading] = useState(true);
  const [order, setOrder] = useState<SB.OrderDetail | null>(null);
  const [stars, setStars] = useState(0);
  const [review, setReview] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancelAsk, setCancelAsk] = useState(false);
  const [invoice, setInvoice] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setOrder(await SB.orderDetails(orderId)); } catch {} finally { setLoading(false); }
  }, [orderId]);
  useEffect(() => { load(); }, [load]);

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

  // Customer confirms collection at the counter — settles the khata and
  // issues the receipt without waiting for the owner to tap anything.
  const confirmCollected = () => {
    Alert.alert(t('orders.confirmCollected'), t('orders.confirmCollectedMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('orders.confirmCollectedYes'),
        onPress: async () => {
          setBusy(true);
          try { await SB.confirmCollected(orderId); load(); }
          catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
          finally { setBusy(false); }
        },
      },
    ]);
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
      message: `🛍️ Shop Book order ${order.id.slice(0, 8).toUpperCase()}\n${lines.join('\n')}\nTotal: ${money(order.total)}`,
    }).catch(() => {});
  };

  const bill = async () => {
    if (!order) return;
    const rows = order.items.map((it) =>
      `<tr><td style="padding:6px 0">${it.name}${it.brand ? ` (${it.brand})` : ''}</td>
       <td style="text-align:center">${it.qty}</td>
       <td style="text-align:right">${it.price > 0 ? money(it.price * it.qty) : '—'}</td></tr>`).join('');
    const html = `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="font-family:-apple-system,Roboto,sans-serif;color:#111;padding:28px">
        <h2 style="color:#0B7A3B;margin:0">🛍️ Shop Book — Receipt</h2>
        <p style="color:#666;margin:6px 0 18px">Order ${order.id.slice(0, 8).toUpperCase()} · ${new Date(order.createdAt).toLocaleString('en-IN')}</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <thead><tr style="border-bottom:1px solid #ddd"><th align="left">Item</th><th>Qty</th><th align="right">Amount</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <hr style="margin:16px 0;border:none;border-top:1px solid #eee"/>
        ${order.discount > 0 ? `<p style="text-align:right;color:#0B7A3B;margin:4px 0">Discount (${order.couponCode}): − ${money(order.discount)}</p>` : ''}
        <h3 style="text-align:right;margin:8px 0">Total: ${money(order.total)}</h3>
        <p style="color:#888;font-size:13px">Status: ${orderStatusLabel(order.status)}</p>
      </body></html>`;
    try {
      const { uri } = await Print.printToFileAsync({ html });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Order receipt' });
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Could not create the bill'); }
  };

  if (invoice) {
    return (
      <InvoiceView orderId={orderId} shopId={order?.shopId}
        deliveryAddress={order?.address} onBack={() => setInvoice(false)} />
    );
  }

  const money = (n: number) => formatMoney(n, order?.currency || '₹');
  const failed = order && (order.status === 'cancelled' || order.status === 'rejected');
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

            {/* customer confirms collection once the shop marks it Ready */}
            {canCustomerConfirmCollection(order.status) && (
              <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={confirmCollected}>
                <Ionicons name="bag-check" size={18} color="#fff" />
                <Text style={s.primaryBtnText}>{t('orders.confirmCollected')}</Text>
              </TouchableOpacity>
            )}
            {order.collectedBy === 'customer' && (
              <Text style={s.hint}>✅ {t('orders.collectedByYou')}</Text>
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
              <StatCard label="Total Pending" value={formatMoney(ledger.pending, shop.currency)} tone="danger" />
              <StatCard label="Total Paid" value={formatMoney(ledger.totalPaid, shop.currency)} tone="green" />
            </View>
            <Text style={s.sectionLabel}>Transactions</Text>
            {ledger.entries.length === 0 && <Empty icon="book-outline" text="No transactions yet." />}
            {ledger.entries.map((e) => (
              <LedgerRow key={e.id} entry={e} currency={shop.currency} />
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
  const [sub, setSub] = useState<'coupons' | 'suppliers' | 'plans' | 'reports' | null>(null);

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
  if (sub === 'plans') return <OwnerPlans plan={shop.plan} onBack={() => setSub(null)} onChanged={() => { setSub(null); load(); }} />;
  if (sub === 'reports') return <OwnerReports plan={shop.plan} currency={shop.currency} onBack={() => setSub(null)} onUpgrade={() => setSub('plans')} />;

  return (
    <>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {tab === 'dashboard' && (
          <OwnerDashboard shop={shop} onSettings={() => setSettings(true)}
            onCoupons={() => setSub('coupons')} onSuppliers={() => setSub('suppliers')}
            onPlans={() => setSub('plans')} onReports={() => setSub('reports')} />
        )}
        {tab === 'orders' && <OwnerOrders currency={shop.currency} />}
        {tab === 'products' && <OwnerProducts shop={shop} />}
        {tab === 'khata' && <OwnerKhata currency={shop.currency} />}
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

function OwnerDashboard({ shop, onSettings, onCoupons, onSuppliers, onPlans, onReports }: {
  shop: SB.Shop; onSettings: () => void; onCoupons: () => void; onSuppliers: () => void;
  onPlans: () => void; onReports: () => void;
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
          <Text style={{ color: C.amber, fontWeight: '700' }}>⚠️ {d?.lowStock} product(s) out of stock</Text>
        </View>
      )}

      {/* Phase 2 quick links */}
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
        <TouchableOpacity style={s.linkCard} onPress={onCoupons}>
          <Text style={{ fontSize: 24 }}>🏷️</Text>
          <Text style={s.linkCardText}>Offers & Coupons</Text>
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

function OwnerOrders({ currency }: { currency?: string }) {
  const [filter, setFilter] = useState('pending');
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<SB.OrderSummary[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async (f: string) => {
    setLoading(true);
    try { setOrders(await SB.ownerOrders(f)); } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(filter); }, [filter, load]);

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
              <Text style={s.cardSub}>{o.id.slice(0, 8).toUpperCase()} · {formatMoney(o.total, currency)}</Text>
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
    catch (e: any) { Alert.alert('Error', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  const money = (n: number) => formatMoney(n, order?.currency || '₹');
  const next = order ? nextOrderStatus(order.status) : null;
  const reviewed = order ? order.items.every((it) => it.availability !== 'pending' && it.availability !== 'alternative') : false;
  const terminal = order && ['completed', 'cancelled', 'rejected'].includes(order.status);

  return (
    <>
      <SubHeader title={t('owner.newOrder')} onBack={onBack} />
      <ReasonModal visible={rejectAsk} title={t('owner.rejectReason')} codes={REJECT_REASONS}
        onSubmit={(text, code) => setStatus('rejected', code === 'other' ? 'other' : code ?? 'other')}
        onClose={() => setRejectAsk(false)} />
      <ReasonModal visible={cancelAsk} title={t('orders.cancelReason')}
        onSubmit={(reason) => setStatus('cancelled', reason)} onClose={() => setCancelAsk(false)} />
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
            {(order.status === 'cancelled' || order.status === 'rejected') && (
              <View style={[s.panel, { borderColor: C.danger }]}>
                <Text style={{ color: C.danger, fontWeight: '700' }}>
                  {order.status === 'rejected'
                    ? (REJECT_REASONS.find((r) => r.code === order.rejectReason)?.label ?? order.rejectReason)
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
                {order.status !== 'pending' && next && (
                  <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={() => setStatus(next)}>
                    <Ionicons name="arrow-forward-circle" size={18} color="#fff" />
                    <Text style={s.primaryBtnText}>
                      {next === 'collected' ? t('owner.markCollected') : `Mark as ${orderStatusLabel(next)}`}
                    </Text>
                  </TouchableOpacity>
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
  const [edit, setEdit] = useState<SB.Product | 'new' | 'bulk' | null>(null);
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

  if (edit === 'bulk') return <BulkAdd currency={shop.currency} onDone={() => { setEdit(null); load(); }} />;
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
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) { Alert.alert('Name required'); return; }
    setBusy(true);
    try {
      await SB.saveProduct({
        id: product?.id, name: name.trim(), brand: brand.trim(), category: category.trim(),
        unit: unit.trim(), price: num(price), taxPercent: num(taxPercent), inStock, enabled,
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
        <ToggleRow label="In stock" value={inStock} onChange={setInStock} />
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

function BulkAdd({ currency, onDone }: { currency?: string; onDone: () => void }) {
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
                  <Text style={s.price}>{formatMoney(p.price, currency)}</Text>
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

function OwnerKhata({ currency }: { currency?: string }) {
  const [loading, setLoading] = useState(true);
  const [customers, setCustomers] = useState<SB.CustomerPending[]>([]);
  const [sel, setSel] = useState<SB.CustomerPending | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setCustomers(await SB.ownerLedgerSummary()); } catch {} finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (sel) return <KhataDetail customer={sel} currency={currency} onBack={() => { setSel(null); load(); }} />;

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
              {c.pending > 0 ? `Pending ${formatMoney(c.pending, currency)}` : 'Settled'}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={C.sub} />
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

function KhataDetail({ customer, currency, onBack }: {
  customer: SB.CustomerPending; currency?: string; onBack: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [ledger, setLedger] = useState<SB.Ledger | null>(null);
  const [amount, setAmount] = useState('');
  const [remark, setRemark] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setLedger(await SB.ownerCustomerLedger(customer.customerId)); } catch {} finally { setLoading(false); }
  }, [customer.customerId]);
  useEffect(() => { load(); }, [load]);

  const add = async (type: 'purchase' | 'payment') => {
    const amt = num(amount);
    if (amt <= 0) { Alert.alert('Enter an amount'); return; }
    setBusy(true);
    try {
      await SB.addLedgerEntry(customer.customerId, type, amt, remark.trim());
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
            <StatCard label="Pending" value={formatMoney(ledger.pending, currency)} tone="danger" />
            <StatCard label="Paid" value={formatMoney(ledger.totalPaid, currency)} tone="green" />
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
          <TextInput style={s.input} placeholder={`Amount (${currency || '₹'})`} placeholderTextColor={C.sub}
            keyboardType="numeric" value={amount} onChangeText={setAmount} />
          <TextInput style={s.input} placeholder="Remark (optional)" placeholderTextColor={C.sub}
            value={remark} onChangeText={setRemark} />
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
        {ledger?.entries.map((e) => <LedgerRow key={e.id} entry={e} currency={currency} />)}
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
// Customer-facing retail receipt (spec: invoicing / consumer retail receipt
// format). Consumer style, not a tax document: retail prices, tax already
// inside the total shown as one "Inclusive of all taxes" line, and NO
// business tax identifiers. The stored invoice keeps its full tax snapshot
// for the owner's records and tax report — only this presentation differs.
function InvoiceView({ orderId, shopId, deliveryAddress, onBack }: {
  orderId: string; shopId?: string; deliveryAddress?: string; onBack: () => void;
}) {
  const [inv, setInv] = useState<SB.Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [due, setDue] = useState<number | null>(null);

  useEffect(() => { (async () => {
    try { setInv(await SB.orderInvoice(orderId)); }
    catch (e: any) { Alert.alert(t('receipt.title'), e?.message ?? 'Not available yet'); }
    finally { setLoading(false); }
  })(); }, [orderId]);

  // Payment status comes from the shared khata, so the receipt never claims
  // "paid" for an amount still outstanding at the shop.
  useEffect(() => { (async () => {
    if (!shopId) return;
    try { setDue((await SB.customerLedger(shopId)).pending); } catch {}
  })(); }, [shopId]);

  const money = (n: number) => formatMoney(n, inv?.currency ?? '₹');
  const paidLine = due == null ? '' : due > 0 ? `${t('receipt.amountDue')}: ${money(due)}` : t('receipt.paidInFull');

  const sharePdf = async () => {
    if (!inv) return;
    const esc = (v: string) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] ?? c));
    const rows = inv.items.map((it) =>
      `<tr><td style="padding:7px 0">${esc(it.name)}${it.brand ? ` <span style="color:#777">(${esc(it.brand)})</span>` : ''}${it.unit ? ` <span style="color:#777">· ${esc(it.unit)}</span>` : ''}</td>
       <td style="text-align:center;color:#555">${it.qty}</td>
       <td style="text-align:right">${money(it.price * it.qty)}</td></tr>`).join('');
    const html = `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="font-family:-apple-system,Roboto,sans-serif;color:#111;padding:26px;max-width:460px;margin:0 auto">
        <div style="text-align:center;border-bottom:2px dashed #ddd;padding-bottom:14px">
          <h2 style="color:#0B7A3B;margin:0 0 4px">${esc(inv.business.name)}</h2>
          ${inv.business.address ? `<p style="color:#666;margin:2px 0;font-size:13px">${esc(inv.business.address)}</p>` : ''}
          ${inv.business.phone ? `<p style="color:#666;margin:2px 0;font-size:13px">${esc(inv.business.phone)}</p>` : ''}
        </div>
        <table style="width:100%;font-size:13px;color:#555;margin:12px 0">
          <tr><td>${t('receipt.orderId')}</td><td style="text-align:right"><b style="color:#111">${esc(inv.invoiceNo)}</b></td></tr>
          <tr><td>${t('receipt.date')}</td><td style="text-align:right">${new Date(inv.createdAt).toLocaleString('en-IN')}</td></tr>
          <tr><td>${t('receipt.billedTo')}</td><td style="text-align:right">${esc(inv.customerName || 'Customer')}</td></tr>
          ${deliveryAddress ? `<tr><td>${t('receipt.address')}</td><td style="text-align:right">${esc(deliveryAddress)}</td></tr>` : ''}
        </table>
        <table style="width:100%;border-collapse:collapse;font-size:14px;border-top:1px solid #eee">
          <thead><tr style="border-bottom:1px solid #eee;color:#777;font-size:12px">
            <th align="left" style="padding:6px 0">${t('receipt.item')}</th><th>${t('common.qty')}</th><th align="right">${t('receipt.amount')}</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div style="border-top:2px dashed #ddd;margin-top:14px;padding-top:12px">
          ${inv.discount > 0 ? `<p style="text-align:right;margin:3px 0;color:#0B7A3B">${t('receipt.savings')}: ${money(inv.discount)}</p>` : ''}
          <h3 style="text-align:right;margin:6px 0">${t('receipt.total')}: ${money(inv.total)}</h3>
          ${inv.taxTotal > 0 ? `<p style="text-align:right;margin:2px 0;color:#777;font-size:12px">${t('receipt.inclusiveTax')} (${money(inv.taxTotal)})</p>` : ''}
          ${paidLine ? `<p style="text-align:right;margin:6px 0;color:${due && due > 0 ? '#DC2626' : '#0B7A3B'};font-size:13px"><b>${paidLine}</b></p>` : ''}
        </div>
        <p style="color:#888;font-size:12px;text-align:center;margin-top:22px">${t('receipt.thanks')}</p>
      </body></html>`;
    try {
      const { uri } = await Print.printToFileAsync({ html });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: inv.invoiceNo });
    } catch (e: any) { Alert.alert('Error', e?.message ?? 'Could not create the receipt PDF'); }
  };

  return (
    <>
      <SubHeader title={t('receipt.title')} onBack={onBack}
        right={inv ? { icon: 'share-social-outline', onPress: sharePdf } : undefined} />
      <ScrollView contentContainerStyle={s.body}>
        {loading && <ActivityIndicator color={C.green} style={{ marginTop: 24 }} />}
        {inv && (
          <>
            {/* shop header — no business tax identifiers on a customer receipt */}
            <View style={[s.panel, { alignItems: 'center' }]}>
              <Text style={[s.panelTitle, { fontSize: 17 }]}>{inv.business.name}</Text>
              {!!inv.business.address && <Text style={[s.cardSub, { textAlign: 'center' }]}>{inv.business.address}</Text>}
              {!!inv.business.phone && <Text style={s.cardSub}>{inv.business.phone}</Text>}
            </View>

            <View style={s.panel}>
              <Row label={t('receipt.orderId')} value={inv.invoiceNo} bold />
              <Row label={t('receipt.date')} value={new Date(inv.createdAt).toLocaleString('en-IN')} />
              <Row label={t('receipt.billedTo')} value={inv.customerName || 'Customer'} />
              {!!deliveryAddress && <Row label={t('receipt.address')} value={deliveryAddress} />}
            </View>

            <Text style={s.sectionLabel}>{t('receipt.items')}</Text>
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
              {inv.discount > 0 && <Row label={t('receipt.savings')} value={money(inv.discount)} tone={C.green} />}
              <Row label={t('receipt.total')} value={money(inv.total)} bold />
              {inv.taxTotal > 0 && (
                <Text style={[s.hint, { textAlign: 'right', marginTop: 2 }]}>
                  {t('receipt.inclusiveTax')} ({money(inv.taxTotal)})
                </Text>
              )}
              {!!paidLine && (
                <Text style={[s.hint, { textAlign: 'right', fontWeight: '700', color: due && due > 0 ? C.danger : C.green }]}>
                  {paidLine}
                </Text>
              )}
            </View>

            <Text style={[s.hint, { textAlign: 'center' }]}>{t('receipt.thanks')}</Text>
            <TouchableOpacity style={s.primaryBtn} onPress={sharePdf}>
              <Ionicons name="share-social-outline" size={18} color="#fff" />
              <Text style={s.primaryBtnText}>{t('receipt.share')}</Text>
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
  const failed = status === 'cancelled' || status === 'rejected';
  const color = failed ? C.danger : done ? C.green : C.blue;
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

function LedgerRow({ entry, currency }: { entry: SB.LedgerEntry; currency?: string }) {
  const isPay = entry.type === 'payment';
  return (
    <View style={s.card}>
      <View style={{ flex: 1 }}>
        <Text style={s.cardTitle}>{isPay ? 'Payment received' : 'Purchase'}</Text>
        <Text style={s.cardSub}>{new Date(entry.createdAt).toLocaleDateString('en-IN')}{entry.remark ? ` · ${entry.remark}` : ''}</Text>
      </View>
      <Text style={[s.price, { color: isPay ? C.green : C.danger }]}>
        {isPay ? '−' : '+'}{formatMoney(entry.amount, currency)}
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
