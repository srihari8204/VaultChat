// components/shopbook/customerViews.tsx — Shop Book: find shops, product search, shop details, profile and the inbox.
// Split out of app/shop-book.tsx on 2026-10-04 and edited since (fixes are
// logged per round). Palette and styles come from ./theme.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, FlatList, Alert, RefreshControl, Share } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { SHOP_CATEGORIES, categoryIcon, categoryLabel } from '../../constants/shopCategories';
import { formatMoney, formatDistance, shopOpenState, couponLabel, starText, loyaltyTier, type CartItem, isStalePrice, dateLocale, notificationTarget, type NotificationTarget } from '../../utils/shopbook';
import * as SB from '../../services/shopBookService';
import { LoadingState, ErrorState } from '../finance/ui';
import { listShopLists, saveShopList, deleteShopList, type ShopList } from '../../db/shopLists';
import { t, useShopBookLang, setShopBookLang, SB_LANGUAGES } from '../../lib/shopbookI18n';
import { C, s } from './theme';
import { loadErrText, SubHeader, Chip, openDirections, InfoRow, Empty } from './shared';
import { Catalog } from './catalog';
import { CartView } from './checkout';
import { permissionDenied } from '../../lib/permissionDenied';
import { useShopLoad } from './useShopLoad';

/** Unwrap an expo-location result to a usable pair, or null.
 *  Rejects (0,0): that is what a failed fix serialises to, not a place anyone
 *  is, and sorting shops around null island would put every one of them
 *  thousands of kilometres away. */
export async function positionOf(p: Promise<any>): Promise<{ lat: number; lng: number } | null> {
  try {
    const pos = await p;
    const lat = pos?.coords?.latitude;
    const lng = pos?.coords?.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat === 0 && lng === 0) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

export function FindShops({ onOpen, favIds, onToggleFav, favErr, onRetryFavs, onProductSearch }: {
  onOpen: (s: SB.Shop) => void; favIds: Set<string>; onToggleFav: (id: string) => void;
  favErr: boolean; onRetryFavs: () => void;
  onProductSearch: () => void;
}) {
  const [shops, setShops] = useState<SB.Shop[]>([]);
  const [favShops, setFavShops] = useState<SB.Shop[]>([]);
  const [cat, setCat] = useState('all');
  const [q, setQ] = useState('');
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [favShopsErr, setFavShopsErr] = useState(false);
  const loadFavShops = useCallback(async () => {
    try { setFavShops(await SB.favorites()); setFavShopsErr(false); } catch { setFavShopsErr(true); }
  }, []);

  // The first load waits for the location read below, so it is started there.
  const { loading, err, loadWith: load } = useShopLoad(fetchNearby, setShops,
    { auto: false, fallback: 'Could not load shops' });
  // Before that first load the list is not "empty", it is not read yet.
  const [started, setStarted] = useState(false);

  // DO NOT PROMPT ON MOUNT.
  //
  // This used to call requestForegroundPermissionsAsync() the instant the
  // screen opened, so the very first thing a shopkeeper saw was a system
  // location dialog with no explanation of why a ledger wanted their position.
  // A prompt with no context gets refused reflexively, and on Android a refusal
  // can be permanent — losing distance sorting for good, over a dialog the user
  // never asked for.
  //
  // getForegroundPermissionsAsync only READS the current grant and never shows
  // UI, so someone who has already allowed location still gets distances with
  // no change. Everyone else gets the screen they came for, plus the hint
  // below, which is now the thing that asks — at the point they want it.
  useEffect(() => { (async () => {
    let c: { lat: number; lng: number } | null = null;
    try {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status === 'granted') {
        // LAST KNOWN FIRST, and it is not just an optimisation.
        //
        // getCurrentPositionAsync waits for a FRESH satellite fix, which
        // indoors or on a weaker receiver takes tens of seconds or never
        // arrives. Caught on the Redmi while the Honor beside it was fine: the
        // shop list rendered with no distances at all, and in the wrong order,
        // because the screen had loaded before any fix landed.
        //
        // The cached fix is good enough to sort shops by — metres to hundreds
        // of metres stale, against distances measured in kilometres — and it
        // returns instantly.
        c = await positionOf(Location.getLastKnownPositionAsync());
        if (!c) c = await positionOf(Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        }));
        if (c) setCoords(c);
      }
    } catch {}
    setStarted(true);
    load('all', c);
    loadFavShops();
  })(); }, [load, loadFavShops]);

  /** Ask for location because the user asked for it — from the hint below. */
  const enableLocation = useCallback(async () => {
    try {
      const { status, canAskAgain } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        // The user asked for this, so a refusal the OS won't re-prompt for gets
        // a way to Settings; the screen still works without distances.
        if (!canAskAgain) permissionDenied('Location is off', 'Allow location in Settings to see how far each shop is.', canAskAgain);
        return;
      }
      const c = await positionOf(Location.getLastKnownPositionAsync())
        ?? await positionOf(Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
      if (!c) return;
      setCoords(c);
      load(cat, c);
    } catch { /* nothing to do: distances stay off, shops still list */ }
  }, [cat, load]);

  const filtered = useMemo(
    () => shops.filter((sh) => !q.trim() || sh.name.toLowerCase().includes(q.trim().toLowerCase())),
    [shops, q],
  );

  // The shop list IS this screen's scroller now. A FlatList nested inside a
  // vertical ScrollView virtualizes nothing, so everything that used to sit
  // above the rows travels along as the list header instead.
  // Held as an element and not a component function: a fresh function identity
  // on every render remounts the header, and the search box would drop the
  // keyboard on each keystroke.
  const header = (
    <>
      <View style={s.searchRow}>
        <Ionicons name="search" size={18} color={C.sub} />
        <TextInput style={s.searchInput} placeholder="Search shops nearby" placeholderTextColor={C.sub}
          accessibilityLabel="Search shops nearby" value={q} onChangeText={setQ} />
      </View>
      <TouchableOpacity style={s.findProductBtn} onPress={onProductSearch} accessibilityRole="button">
        <Ionicons name="pricetag" size={16} color={C.green} />
        <Text style={s.findProductText}>Find a product across shops</Text>
        <Ionicons name="chevron-forward" size={16} color={C.green} style={{ marginLeft: 'auto' }} />
      </TouchableOpacity>
      {!coords && started && !loading && (
        <TouchableOpacity onPress={enableLocation} activeOpacity={0.7} accessibilityRole="button"
          accessibilityLabel="Location off, showing recent shops. Enable location for distance.">
          <Text style={s.hint}>📍 Location off — showing recent shops. Tap to enable for distance.</Text>
        </TouchableOpacity>
      )}

      {/* A failed favourites read is said out loud: the hearts below are
          toggles, and one that wrongly reads empty would remove the shop. */}
      {(favErr || favShopsErr) && (
        <TouchableOpacity accessibilityRole="button" onPress={() => { onRetryFavs(); loadFavShops(); }}>
          <Text style={[s.hint, { color: C.danger }]}>Couldn’t load your favourites. Tap to try again.</Text>
        </TouchableOpacity>
      )}

      {/* favorites strip */}
      {favShops.length > 0 && !q.trim() && (
        <>
          <Text style={s.sectionLabel}>⭐ Favorites</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 4 }}>
            {favShops.map((sh) => (
              <TouchableOpacity key={sh.id} style={s.favCard} onPress={() => onOpen(sh)}
                accessibilityRole="button" accessibilityLabel={`Open favourite shop ${sh.name}`}>
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

      {(loading || !started) && <LoadingState />}
      {!!err && !loading && <ErrorState title="Couldn’t load shops" sub={err} onRetry={() => load(cat, coords)} />}
      {started && !loading && !err && filtered.length === 0 && (
        <Empty icon="storefront-outline" text="No shops found nearby yet." />
      )}

    </>
  );

  const renderShop = useCallback(({ item: sh }: { item: SB.Shop }) => (
    <ShopCard shop={sh} onOpen={() => onOpen(sh)}
      isFav={favIds.has(sh.id)} onToggleFav={() => onToggleFav(sh.id)} />
  ), [onOpen, favIds, onToggleFav]);

  return (
    <FlatList
      data={filtered}
      keyExtractor={(sh) => sh.id}
      renderItem={renderShop}
      ListHeaderComponent={header}
      contentContainerStyle={s.body}
      refreshControl={<RefreshControl refreshing={started && loading} onRefresh={() => load(cat, coords)} tintColor={C.green} />}
    />
  );
}

const fetchNearby = (category: string, c?: { lat: number; lng: number } | null) =>
  SB.nearbyShops(c?.lat, c?.lng, category);

export function ShopCard({ shop, onOpen, isFav, onToggleFav }: {
  shop: SB.Shop; onOpen: () => void; isFav: boolean; onToggleFav: () => void;
}) {
  const st = shopOpenState(shop);
  return (
    <TouchableOpacity style={s.card} onPress={onOpen} activeOpacity={0.8} accessibilityRole="button"
      accessibilityLabel={[shop.name, categoryLabel(shop.category),
        shop.distanceKm != null ? formatDistance(shop.distanceKm) : '', st.label].filter(Boolean).join(', ')}
      // The heart inside is its own touchable, which a screen reader cannot
      // reach inside this one on iOS — so it is offered as an action too.
      accessibilityActions={[{ name: 'favourite', label: isFav ? 'Remove from favourites' : 'Add to favourites' }]}
      onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'favourite') onToggleFav(); }}>
      <View style={s.shopIcon}><Text style={{ fontSize: 22 }}>{categoryIcon(shop.category)}</Text></View>
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={s.cardTitle}>{shop.name}</Text>
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
      <TouchableOpacity accessibilityRole="button" accessibilityState={{ selected: isFav }}
        accessibilityLabel={isFav ? `Remove ${shop.name} from favourites` : `Add ${shop.name} to favourites`} onPress={onToggleFav} hitSlop={10} style={{ padding: 4 }}>
        <Ionicons name={isFav ? 'heart' : 'heart-outline'} size={22} color={isFav ? C.danger : C.sub} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

export function ProductSearch({ onBack, onOpenShop }: { onBack: () => void; onOpenShop: (shopId: string) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SB.ProductHit[]>([]);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [searched, setSearched] = useState(false);
  const [tooShort, setTooShort] = useState(false);

  useEffect(() => { (async () => {
    try {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status === 'granted') {
        // Same rules as FindShops: last known first, and a (0,0) "fix" is
        // a failed one, not a place to rank shops around.
        const c = await positionOf(Location.getLastKnownPositionAsync())
          ?? await positionOf(Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
        if (c) setCoords(c);
      }
    } catch {}
  })(); }, []);

  const [sort, setSort] = useState<'price' | 'nearest' | 'open'>('price');
  const { loading, err, loadWith } = useShopLoad(SB.searchProducts, setResults, { auto: false });

  const run = async () => {
    // Said, not silently ignored: a one-letter search did nothing at all.
    if (q.trim().length < 2) { setTooShort(true); return; }
    setTooShort(false); setSearched(true); setResults([]);
    await loadWith(q.trim(), coords?.lat, coords?.lng, sort === 'nearest' ? 'nearest' : 'price');
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

  // Everything above the results becomes the list header — the results ARE the
  // scroller now, and a FlatList inside a ScrollView virtualizes nothing.
  // Element, not component function: remounting the header on every render
  // would take the keyboard away from the search box mid-word.
  const header = (
    <>
        <View style={s.searchRow}>
          <Ionicons name="search" size={18} color={C.sub} />
          <TextInput style={s.searchInput} placeholder="e.g. Maggi, Atta, Paracetamol"
            accessibilityLabel="Product to find in nearby shops"
            placeholderTextColor={C.sub} value={q} onChangeText={setQ}
            onSubmitEditing={run} returnKeyType="search" autoFocus />
        </View>
        {tooShort && (
          <Text style={[s.hint, { color: C.danger }]} accessibilityLiveRegion="polite">Type at least 2 letters to search.</Text>
        )}
        <TouchableOpacity style={s.primaryBtn} onPress={run} accessibilityRole="button"><Text style={s.primaryBtnText}>Search nearby shops</Text></TouchableOpacity>

        {searched && (
          <View style={{ flexDirection: 'row', gap: 6, marginTop: 10 }} accessibilityRole="radiogroup" accessibilityLabel="Sort results">
            {([['price', 'Lowest price'], ['nearest', 'Nearest'], ['open', 'Open now']] as const).map(([id, lbl]) => (
              <TouchableOpacity key={id} style={[s.filterChip, sort === id && s.filterChipActive]} onPress={() => setSort(id)}
                accessibilityRole="radio" accessibilityState={{ checked: sort === id }}>
                <Text style={[s.filterChipText, sort === id && s.filterChipTextActive]}>{lbl}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {loading && <LoadingState />}
        {!!err && !loading && <ErrorState title="Search failed" sub={err} onRetry={run} />}
        {searched && !loading && !err && results.length === 0 && (
          <Empty icon="search-outline" text="No shop nearby lists that yet." />
        )}
    </>
  );

  const renderHit = useCallback(({ item: h }: { item: SB.ProductHit }) => (
          <TouchableOpacity style={s.card} onPress={() => onOpenShop(h.shopId)} accessibilityRole="button">
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{h.productName}{h.unit ? ` · ${h.unit}` : ''}{h.productBrand ? ` (${h.productBrand})` : ''}</Text>
              <Text style={s.cardSub}>
                {h.shopName}{h.distanceKm != null ? ` · ${formatDistance(h.distanceKm)}` : ''}
                {h.ratingCount > 0 ? ` · ⭐ ${h.rating}` : ''}
              </Text>
              <Text style={s.cardSub}>
                {h.inStock ? '🟢 In stock' : '🔴 Out of stock'}
                {h.updatedAt ? ` · updated ${new Date(h.updatedAt).toLocaleDateString(dateLocale())}` : ''}
                {isStalePrice(h.updatedAt) ? ' · ⚠️ price may be out of date' : ''}
              </Text>
              <Text style={s.price}>{formatMoney(h.price, h.currency || '₹')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={C.sub} />
          </TouchableOpacity>
  ), [onOpenShop]);

  return (
    <>
      <SubHeader title={t('shops.compare')} onBack={onBack} />
      <FlatList
        data={shown}
        // A ProductHit carries no id of its own and one shop can appear twice,
        // so the key names the row's product. The index would have done until
        // "Open now" started re-sorting the same results in place.
        keyExtractor={(h) => `${h.shopId}-${h.productName}-${h.productBrand}-${h.unit}`}
        renderItem={renderHit}
        ListHeaderComponent={header}
        contentContainerStyle={s.body}
        keyboardShouldPersistTaps="handled"
      />
    </>
  );
}

// Shop details → catalog → cart, all in one drill-down.
export function ShopFlow({ shop, cart, setCart, onBack, onPlaced, onLedger, isFav, onToggleFav }: {
  shop: SB.Shop; cart: CartItem[]; setCart: (c: CartItem[]) => void;
  onBack: () => void; onPlaced: (orderId: string) => void; onLedger: () => void;
  isFav: boolean; onToggleFav: () => void;
}) {
  const [view, setView] = useState<'details' | 'catalog' | 'cart'>('details');
  const [coupons, setCoupons] = useState<SB.Coupon[]>([]);
  const [ratings, setRatings] = useState<SB.Rating[]>([]);
  // Offers and reviews are extras on this screen, but "no offers" is a claim:
  // a failed read says so instead of quietly showing none.
  const [extrasErr, setExtrasErr] = useState(false);
  const st = shopOpenState(shop);

  const loadExtras = useCallback(async () => {
    const [cp, rt] = await Promise.allSettled([SB.shopCoupons(shop.id), SB.shopRatings(shop.id)]);
    if (cp.status === 'fulfilled') setCoupons(cp.value);
    if (rt.status === 'fulfilled') setRatings(rt.value);
    setExtrasErr(cp.status === 'rejected' || rt.status === 'rejected');
  }, [shop.id]);
  useEffect(() => { loadExtras(); }, [loadExtras]);

  return (
    <>
      <SubHeader title={shop.name}
        onBack={() => (view === 'details' ? onBack() : setView('details'))}
        right={cart.length > 0 ? { icon: 'cart', label: `Cart, ${cart.length} item${cart.length === 1 ? '' : 's'}`, badge: cart.length, onPress: () => setView('cart') } : undefined}
      />
      {view === 'details' && (
        <ScrollView contentContainerStyle={s.body}>
          <View style={s.card}>
            <View style={s.shopIcon}><Text style={{ fontSize: 26 }}>{categoryIcon(shop.category)}</Text></View>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={s.cardTitle}>{shop.name}</Text>
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
            <TouchableOpacity accessibilityRole="button" accessibilityState={{ selected: isFav }}
              accessibilityLabel={isFav ? `Remove ${shop.name} from favourites` : `Add ${shop.name} to favourites`} onPress={onToggleFav} hitSlop={10} style={{ padding: 4 }}>
              <Ionicons name={isFav ? 'heart' : 'heart-outline'} size={24} color={isFav ? C.danger : C.sub} />
            </TouchableOpacity>
          </View>

          {extrasErr && (
            <TouchableOpacity accessibilityRole="button" onPress={loadExtras}>
              <Text style={[s.hint, { color: C.danger }]}>Couldn’t load this shop’s offers and reviews. Tap to try again.</Text>
            </TouchableOpacity>
          )}

          {/* Offers */}
          {coupons.length > 0 && (
            <>
              <Text style={s.sectionLabel}>🏷️ Offers</Text>
              {coupons.map((c2) => (
                <View key={c2.code} style={s.offerCard}>
                  <View style={s.couponCode}><Text style={s.couponCodeText}>{c2.code}</Text></View>
                  <Text style={s.offerText}>{couponLabel(c2, shop.currency || '₹')}</Text>
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

          <TouchableOpacity style={s.primaryBtn} onPress={() => setView('catalog')} accessibilityRole="button">
            <Ionicons name="list" size={18} color={C.onFill} />
            <Text style={s.primaryBtnText}>View Catalog</Text>
          </TouchableOpacity>
          {shop.lat != null && shop.lng != null && (
            <TouchableOpacity style={s.outlineBtn} onPress={() => openDirections(shop)} accessibilityRole="button">
              <Ionicons name="navigate-outline" size={18} color={C.green} />
              <Text style={s.outlineBtnText}>
                Directions{shop.distanceKm != null ? ` · ${formatDistance(shop.distanceKm)}` : ''}
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={s.outlineBtn} onPress={onLedger} accessibilityRole="button">
            <Ionicons name="book-outline" size={18} color={C.green} />
            <Text style={s.outlineBtnText}>My Ledger with this shop</Text>
          </TouchableOpacity>

          {/* Reviews */}
          {ratings.length > 0 && (
            <>
              <Text style={s.sectionLabel}>Reviews</Text>
              {ratings.slice(0, 5).map((rt) => (
                <View key={`${rt.createdAt}-${rt.customerName}`} style={s.card}>
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

export function CustomerProfile({ me }: { me: { id: string; name: string } | null }) {
  const [loyalty, setLoyalty] = useState<SB.Loyalty | null>(null);
  const [lists, setLists] = useState<ShopList[]>([]);
  const [newName, setNewName] = useState('');
  const [newItems, setNewItems] = useState('');
  const [adding, setAdding] = useState(false);
  const [ledgers, setLedgers] = useState<SB.LedgerSummary[]>([]);
  const lang = useShopBookLang();
  // A failed read must not look like "0 pts" or "no saved lists".
  const [accountErr, setAccountErr] = useState(false);
  const [accountLoading, setAccountLoading] = useState(true);
  const [listsErr, setListsErr] = useState('');
  const [listBusy, setListBusy] = useState(false);

  const loadLists = useCallback(async () => {
    if (!me) return;
    try { setLists(await listShopLists(me.id)); setListsErr(''); }
    catch (e: any) { setListsErr(loadErrText(e)); }
  }, [me]);

  const loadAccount = useCallback(async () => {
    setAccountLoading(true);
    const [ly, lg] = await Promise.allSettled([SB.loyalty(), SB.myLedgers()]);
    setAccountLoading(false);
    if (ly.status === 'fulfilled') setLoyalty(ly.value);
    if (lg.status === 'fulfilled') setLedgers(lg.value.ledgers);
    setAccountErr(ly.status === 'rejected' || lg.status === 'rejected');
  }, []);

  useEffect(() => { loadAccount(); loadLists(); }, [loadAccount, loadLists]);

  const addList = async () => {
    if (!me || listBusy) return;
    if (!newName.trim()) { Alert.alert('Name the list', 'Give the list a name, e.g. Monthly groceries.'); return; }
    setListBusy(true);
    try {
      await saveShopList({ user_id: me.id, name: newName.trim(), items: newItems.trim() });
      setNewName(''); setNewItems(''); setAdding(false); loadLists();
    } catch (e: any) { Alert.alert('Couldn’t save the list', e?.message ?? 'Try again'); }
    finally { setListBusy(false); }
  };

  const removeList = async (id: string) => {
    try { await deleteShopList(id); loadLists(); }
    catch (e: any) { Alert.alert('Couldn’t delete the list', e?.message ?? 'Try again'); }
  };

  const shareList = async (l: ShopList) => {
    await Share.share({ message: `🛒 ${l.name}\n${l.items}` }).catch(() => {});
  };

  return (
    <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      <View style={s.card}>
        <View style={s.shopIcon}><Ionicons name="person" size={22} color={C.green} /></View>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={s.cardTitle}>{me?.name ?? 'You'}</Text>
          <Text style={s.cardSub}>Customer · Always free</Text>
        </View>
      </View>

      {accountLoading && !loyalty && <LoadingState />}
      {accountErr && !accountLoading && (
        <ErrorState title="Couldn’t load your points and balances" sub="Check your connection and try again." onRetry={loadAccount} />
      )}

      {/* Loyalty. totalSpent is summed across every shop, and shops can bill in
          different currencies, so it is shown as a figure with no symbol rather
          than labelled rupees. */}
      {loyalty && (
        <View style={s.loyaltyCard}>
          <View style={{ flex: 1 }}>
            <Text style={s.loyaltyPoints}>{loyalty.points} pts</Text>
            <Text style={s.loyaltyTier}>{loyaltyTier(loyalty.points)} member</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={s.loyaltySub}>{loyalty.completedOrders} orders</Text>
            <Text style={s.loyaltySub}>Spent {formatMoney(loyalty.totalSpent, '')}</Text>
          </View>
        </View>
      )}
      <Text style={s.hint}>Earn 1 point for every 100 spent on completed orders, in each shop’s own currency.</Text>

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
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="radiogroup">
        {SB_LANGUAGES.map((l) => (
          <TouchableOpacity key={l.id} style={[s.chip, lang === l.id && s.chipActive]}
            accessibilityRole="radio" accessibilityState={{ checked: lang === l.id }}
            onPress={() => setShopBookLang(l.id)}>
            <Text style={[s.chipText, lang === l.id && { color: C.onFill }]}>{l.native}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Shopping lists */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
        <Text style={s.sectionLabel}>🛒 Shopping Lists</Text>
        <TouchableOpacity accessibilityRole="button" accessibilityState={{ expanded: adding }}
          accessibilityLabel={adding ? "Close the new list form" : "New shopping list"} onPress={() => setAdding((v) => !v)} hitSlop={9}>
          <Ionicons name={adding ? 'close' : 'add-circle'} size={26} color={C.green} />
        </TouchableOpacity>
      </View>
      {adding && (
        <View style={s.panel}>
          <TextInput style={s.input} placeholder="List name (e.g. Monthly groceries)" placeholderTextColor={C.sub}
            accessibilityLabel="List name" value={newName} onChangeText={setNewName} />
          <TextInput style={[s.input, { height: 90, textAlignVertical: 'top' }]} multiline
            accessibilityLabel="Items, one per line"
            placeholder={'Items, one per line:\nAtta 5kg\nSugar 1kg\nOil 1L'} placeholderTextColor={C.sub}
            value={newItems} onChangeText={setNewItems} />
          <TouchableOpacity style={[s.primaryBtn, listBusy && { opacity: 0.6 }]} disabled={listBusy} onPress={addList}
            accessibilityRole="button" accessibilityState={{ disabled: listBusy, busy: listBusy }}>
            <Text style={s.primaryBtnText}>Save List</Text>
          </TouchableOpacity>
        </View>
      )}
      {!!listsErr && <ErrorState title="Couldn’t load your lists" sub={listsErr} onRetry={loadLists} />}
      {lists.length === 0 && !adding && !listsErr && <Empty icon="list-outline" text="No saved lists yet." />}
      {lists.map((l) => (
        <View key={l.id} style={s.card}>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={s.cardTitle}>{l.name}</Text>
            <Text style={s.cardSub} numberOfLines={2}>{l.items.split('\n').filter(Boolean).join(' · ') || 'Empty'}</Text>
          </View>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Share the list ${l.name}`} onPress={() => shareList(l)} hitSlop={8} style={{ padding: 4 }}>
            <Ionicons name="share-social-outline" size={20} color={C.green} />
          </TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Delete the list ${l.name}`} onPress={() => Alert.alert('Delete list?', `Delete "${l.name}" and everything on it? This cannot be undone.`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => removeList(l.id) }])} hitSlop={8} style={{ padding: 4 }}>
            <Ionicons name="trash-outline" size={20} color={C.danger} />
          </TouchableOpacity>
        </View>
      ))}
    </ScrollView>
  );
}

export function NotificationCenter({ mode, onBack, onRead, onReadOne, onOpen }: {
  mode: 'customer' | 'owner';
  onBack: () => void; onRead: () => void; onReadOne: () => void;
  onOpen: (target: NotificationTarget) => void;
}) {
  const [items, setItems] = useState<SB.Notification[]>([]);
  const { loading, err, load } = useShopLoad(fetchNotifications, setItems);

  const markAll = async () => {
    try { await SB.markNotificationsRead(); onRead(); load(); }
    catch (e: any) { Alert.alert('Could not mark as read', e?.message ?? 'Try again'); }
  };

  // Opening a row reads it. Marking is best-effort: the badge corrects itself
  // on the next inbox load, and a failed mark must not block the navigation.
  const open = (n: SB.Notification, target: NotificationTarget) => {
    if (!n.read) {
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      onReadOne();
      SB.markNotificationsRead([n.id]).catch(() => {});
    }
    onOpen(target);
  };

  const renderItem = ({ item: n }: { item: SB.Notification }) => {
    const target = notificationTarget(n, mode);
    const label = [n.read ? '' : 'Unread', n.title, n.body].filter(Boolean).join('. ');
    const body = (
      <>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={s.cardTitle}>{n.title}</Text>
          {!!n.body && <Text style={s.cardSub}>{n.body}</Text>}
          <Text style={[s.cardSub, { fontSize: 11 }]}>{new Date(n.createdAt).toLocaleString(dateLocale())}</Text>
        </View>
        {!n.read && <View style={[s.pillDot, { backgroundColor: C.green }]} />}
        {target && <Ionicons name="chevron-forward" size={18} color={C.sub} />}
      </>
    );
    // Only a row with somewhere to go is a button; the rest stay plain text
    // rather than touchables that do nothing.
    return target ? (
      <TouchableOpacity style={[s.card, !n.read && { borderColor: C.green }]} onPress={() => open(n, target)}
        accessibilityRole="button" accessibilityLabel={label}
        accessibilityHint={target.kind === 'returns' ? 'Opens your returns' : 'Opens the order'}>
        {body}
      </TouchableOpacity>
    ) : (
      <View style={[s.card, !n.read && { borderColor: C.green }]} accessible accessibilityLabel={label}>
        {body}
      </View>
    );
  };

  return (
    <>
      <SubHeader title={t('notif.title')} onBack={onBack}
        right={{ icon: 'checkmark-done-outline', label: t('notif.markAllRead'), onPress: markAll }} />
      {/* Up to 100 rows come back, so the inbox is a virtualized list. */}
      <FlatList
        data={items}
        keyExtractor={(n) => n.id}
        renderItem={renderItem}
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}
        ListHeaderComponent={(
          <>
            {loading && items.length === 0 && <LoadingState />}
            {!!err && !loading && <ErrorState title="Couldn’t load notifications" sub={err} onRetry={load} />}
            {!loading && !err && items.length === 0 && <Empty icon="notifications-off-outline" text={t('notif.empty')} />}
          </>
        )}
        ListFooterComponent={items.length > 0 ? (
          <TouchableOpacity style={s.outlineBtn} onPress={markAll} accessibilityRole="button">
            <Ionicons name="checkmark-done" size={18} color={C.green} />
            <Text style={s.outlineBtnText}>{t('notif.markAllRead')}</Text>
          </TouchableOpacity>
        ) : null}
      />
    </>
  );
}

const fetchNotifications = () => SB.notifications().then((r) => r.notifications);
