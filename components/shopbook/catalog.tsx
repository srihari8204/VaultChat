// components/shopbook/catalog.tsx — Shop Book: the customer's shop catalog, typed and spoken product requests.
// Split out of app/shop-book.tsx on 2026-10-04 and edited since (fixes are
// logged per round). Palette and styles come from ./theme.

import { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, FlatList, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Voice, { type SpeechResultsEvent } from '@react-native-voice/voice';
import { formatMoney, cartTotal, clientKey, type CartItem, UNIT_PRESETS, normalizeUnit, isNum, num } from '../../utils/shopbook';
import * as SB from '../../services/shopBookService';
import { LoadingState, ErrorState } from '../finance/ui';
import { speechLocale } from '../../lib/shopbookI18n';
import { C, s } from './theme';
import { Chip, Empty } from './shared';
import { useShopLoad } from './useShopLoad';

// Prices a customer reads must be in the SHOP's currency. These used to be
// formatINR — a hardcoded ₹ — which mislabels every figure for a shop
// configured anywhere else. Same class of bug as the owner order list.
export function Catalog({ shop, cart, setCart, onCart }: {
  shop: SB.Shop; cart: CartItem[]; setCart: (c: CartItem[]) => void; onCart: () => void;
}) {
  const money = (n: number) => formatMoney(n, shop.currency || '₹');
  const [products, setProducts] = useState<SB.Product[]>([]);
  const [q, setQ] = useState('');
  // "Type any product" form
  // The typed-product panel is the FALLBACK path, so it starts collapsed and
  // now sits below the catalog: a wall of unit chips was the first thing a
  // customer saw instead of the shop's products.
  const [typeOpen, setTypeOpen] = useState(false);
  // The free-text unit box only appears behind this, so the common case costs
  // one tap instead of a second full-width input duplicating the chips.
  const [customUnit, setCustomUnit] = useState(false);
  const [tName, setTName] = useState('');
  const [tBrand, setTBrand] = useState('');
  const [tQty, setTQty] = useState('1');
  // What ONE of the thing is. Without this a typed "soap" reached the owner as a
  // bare number and they had to guess pieces vs a box; catalog lines already
  // carry the product's unit, so only the typed line was blind.
  const [tUnit, setTUnit] = useState('');
  const [tNote, setTNote] = useState('');
  const [listening, setListening] = useState(false);

  const fetchProducts = useCallback(() => SB.shopProducts(shop.id), [shop.id]);
  const { loading, err, load: loadProducts } = useShopLoad(fetchProducts, setProducts);

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
      // Listen in the language the app is being used in, not the one it was
      // written in. A recogniser given the wrong language does not fail — it
      // returns confident nonsense, which then goes into the cart as a product.
      setListening(true); await Voice.start(speechLocale());
    } catch { setListening(false); Alert.alert('Voice unavailable', 'Speech input is not available on this device/build.'); }
  };

  // `price` here is what we display; the server re-prices from productId when
  // the line came from the catalog. A free-typed line carries no productId and
  // reaches the owner as a request to quote.
  const add = (name: string, brand: string, qty: number, price: number, note: string,
               unit = '', taxPercent = 0, productId?: string) => {
    // MERGE, don't append. Tapping Add twice used to create two lines of qty 1,
    // which the new stepper would then disagree with — it edits one line while
    // the cart shows two. Only catalog lines merge: a free-typed request has no
    // productId and two "rice" requests may genuinely be different things.
    if (productId) {
      const at = cart.findIndex((c) => c.productId === productId);
      if (at >= 0) {
        setCart(cart.map((c, i) => (i === at ? { ...c, qty: c.qty + qty } : c)));
        return;
      }
    }
    setCart([...cart, { key: clientKey(), productId, name, brand, qty, price, note, unit, taxPercent }]);
  };

  // The cart is the single source of truth for quantity; the row just reads and
  // nudges it. Keeping a second copy in this component is how a stepper and a
  // cart badge end up disagreeing.
  const lineFor = (productId: string) => cart.find((c) => c.productId === productId);
  const bump = (productId: string, d: number) => {
    const line = lineFor(productId);
    if (!line) return;
    const next = line.qty + d;
    // Stepping below 1 removes the line: a cart row of qty 0 is not a thing a
    // customer means, and leaving it stranded makes them hunt for a delete.
    setCart(next <= 0 ? cart.filter((c) => c.key !== line.key)
                      : cart.map((c) => (c.key === line.key ? { ...c, qty: next } : c)));
  };
  // Typed quantities are drafts until the box loses focus. Committing on every
  // keystroke means the empty string you pass through while backspacing is read
  // as a quantity. Same rule as the bill screen's qtyDraft further down.
  const [qtyDraft, setQtyDraft] = useState<Record<string, string>>({});

  const setExact = (productId: string, raw: string) => {
    const line = lineFor(productId);
    if (!line) return;
    // Typed, not stepped: loose weight is 2.5 kg and no +/- can express that.
    //
    // Committed on BLUR, and never on a value that is not a number (2026-09-17).
    // This used to run on every keystroke and treat the result as a quantity, so
    // the empty string you pass through while backspacing to retype became 0 —
    // and 0 deleted the line out from under you mid-edit, stepper and all.
    // "2,5" did the same, silently. Blank means "still typing" and garbage
    // means "not a number"; NEITHER means zero. Only the - stepper and the
    // delete control remove a line.
    //
    // A SILENT return was still wrong (2026-09-17): the draft is cleared by the
    // caller on blur, so "2,5" put the old quantity back on screen with no
    // explanation and the customer ordered 2 when they meant 2.5 — the refusal
    // has to be visible. Blank stays silent, because blank is "still typing"
    // and a keyboard dismiss is not a mistake worth an alert.
    if (!isNum(raw)) {
      if (raw.trim()) {
        Alert.alert('Check the quantity',
          `"${raw.trim()}" is not a quantity. Use digits only — 2.5 for two and a half, 1,200 or 1200 for a thousand two hundred.`);
      }
      return;
    }
    // num(), not Number(): isNum now accepts thousands grouping (2026-09-17),
    // and Number('1,200') is NaN — which would set a quantity of NaN on a line
    // that had just passed the gate.
    const v = num(raw);
    if (v <= 0) return;
    setCart(cart.map((c) => (c.key === line.key ? { ...c, qty: v } : c)));
  };

  const filtered = products.filter(
    (p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()) || p.brand.toLowerCase().includes(q.trim().toLowerCase()),
  );

  // The catalog IS the scroller. A shop with a real catalog mounted every row at
  // once here; search rides in the list header and the type-any-product
  // fallback in the footer. Both are elements rather than component functions —
  // a new function identity each render remounts them and the text inputs would
  // lose the keyboard mid-word.
  const header = (
    <>
      <View style={s.searchRow}>
        <Ionicons name="search" size={18} color={C.sub} />
        <TextInput style={s.searchInput} placeholder="Search products" placeholderTextColor={C.sub}
          accessibilityLabel="Search this shop's products" value={q} onChangeText={setQ} />
      </View>

      <Text style={s.sectionLabel}>Catalog</Text>
      {loading && <LoadingState />}
      {!!err && !loading && <ErrorState title="Couldn’t load the catalog" sub={err} onRetry={loadProducts} />}
      {!loading && !err && filtered.length === 0 && <Empty icon="pricetags-outline" text="No listed products. Use “Type any product” below." />}
    </>
  );

  const renderProduct = ({ item: p }: { item: SB.Product }) => (
        <View style={s.card}>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>{p.name}{p.unit ? ` · ${p.unit}` : ''}</Text>
            <Text style={s.cardSub}>{[p.brand, p.category].filter(Boolean).join(' · ')}</Text>
            <Text style={s.price}>{money(p.price)}{!p.inStock ? '  ·  Out of stock' : ''}</Text>
          </View>
          {(() => {
            const line = lineFor(p.id);
            if (!line) {
              return (
                <TouchableOpacity style={[s.addBtn, !p.inStock && { opacity: 0.4 }]} disabled={!p.inStock}
                  accessibilityRole="button" accessibilityLabel={`Add ${p.name} to the cart`}
                  accessibilityState={{ disabled: !p.inStock }}
                  onPress={() => add(p.name, p.brand, 1, p.price, '', p.unit, p.taxPercent, p.id)}>
                  <Text style={s.addBtnText}>Add</Text>
                </TouchableOpacity>
              );
            }
            return (
              <View style={s.qtyRow}>
                <TouchableOpacity hitSlop={7} style={s.qtyBtn} onPress={() => bump(p.id, -1)}
                  accessibilityRole="button" accessibilityLabel={line.qty <= 1 ? `Remove ${p.name} from the cart` : `One less ${p.name}`}>
                  <Text style={s.qtyBtnText}>−</Text>
                </TouchableOpacity>
                {/* Tap the number to type an exact amount. The unit sits beside it
                    so "2" is never ambiguous between 2 pieces and 2 kg. */}
                <TextInput style={s.qtyInput} keyboardType="numeric" selectTextOnFocus
                  accessibilityLabel={`Quantity of ${p.name}${p.unit ? ` in ${p.unit}` : ''}`}
                  value={qtyDraft[p.id] ?? String(line.qty)}
                  onChangeText={(v) => setQtyDraft({ ...qtyDraft, [p.id]: v })}
                  onBlur={() => {
                    const raw = qtyDraft[p.id];
                    if (raw == null) return;
                    setExact(p.id, raw);
                    const { [p.id]: _done, ...rest } = qtyDraft;
                    setQtyDraft(rest);
                  }} />
                {!!p.unit && <Text style={s.qtyUnit}>{p.unit}</Text>}
                <TouchableOpacity hitSlop={7} style={s.qtyBtn} onPress={() => bump(p.id, 1)}
                  accessibilityRole="button" accessibilityLabel={`One more ${p.name}`}>
                  <Text style={s.qtyBtnText}>+</Text>
                </TouchableOpacity>
              </View>
            );
          })()}
        </View>
  );

  const footer = (
    <>
      {/* The FALLBACK path, so it lives below the catalog and starts closed. */}
      <TouchableOpacity style={s.outlineBtn} onPress={() => setTypeOpen(!typeOpen)}
        accessibilityRole="button" accessibilityLabel="Type any product" accessibilityState={{ expanded: typeOpen }}>
        <Ionicons name={typeOpen ? 'chevron-up' : 'chevron-down'} size={16} color={C.green} />
        <Text style={s.outlineBtnText}>  ✍️ Type any product</Text>
      </TouchableOpacity>
      {typeOpen && (
      <View style={s.panel}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TextInput style={[s.input, { flex: 1, marginBottom: 0 }]} placeholder="Product name (e.g. Maggi)" placeholderTextColor={C.sub}
            accessibilityLabel="Product name" value={tName} onChangeText={setTName} />
          <TouchableOpacity accessibilityRole="button" accessibilityState={{ busy: listening }}
            accessibilityLabel={listening ? "Stop listening" : "Say the product name instead of typing"} style={[s.micBtn, listening && s.micBtnOn]} onPress={mic}>
            <Ionicons name={listening ? 'stop' : 'mic'} size={20} color={listening ? C.onFill : C.green} />
          </TouchableOpacity>
        </View>
        {listening
          ? <Text style={[s.hint, { color: C.green }]}>🎤 Listening… say the product name</Text>
          : <Text style={s.hint}>Tap the mic to speak instead of typing</Text>}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TextInput style={[s.input, { flex: 1 }]} placeholder="Brand (optional)" placeholderTextColor={C.sub}
            accessibilityLabel="Brand, optional" value={tBrand} onChangeText={setTBrand} />
          <TextInput style={[s.input, { width: 80 }]} placeholder="Qty" placeholderTextColor={C.sub}
            accessibilityLabel="Quantity" keyboardType="numeric" value={tQty} onChangeText={setTQty} />
        </View>
{/* ONE row that scrolls. Wrapped, ten chips took four rows and pushed
    the actual form off the screen. */}
<ScrollView horizontal showsHorizontalScrollIndicator={false}
  contentContainerStyle={{ gap: 6, paddingVertical: 2 }} style={{ marginBottom: 8 }}>
  {UNIT_PRESETS.map((u) => (
    <Chip key={u} label={u} icon="" active={tUnit === u}
      onPress={() => { setCustomUnit(false); setTUnit(tUnit === u ? '' : u); }} />
  ))}
  <Chip label="+ custom" icon="" active={customUnit}
    onPress={() => { setCustomUnit(!customUnit); if (!customUnit) setTUnit(''); }} />
</ScrollView>
{customUnit && (
  <TextInput style={s.input} placeholder="Unit (500g packet, 5kg bag...)" placeholderTextColor={C.sub}
    accessibilityLabel="Custom unit" value={tUnit} onChangeText={setTUnit} autoFocus />
)}
        <TextInput style={s.input} placeholder="Note (e.g. small pack)" placeholderTextColor={C.sub}
          accessibilityLabel="Note for the shop" value={tNote} onChangeText={setTNote} />
        <TouchableOpacity style={s.primaryBtn} accessibilityRole="button" onPress={() => {
          if (!tName.trim()) { Alert.alert('Name the product', 'Type or say what you want to order.'); return; }
          // Same gate as the catalog stepper: garbage is refused out loud, not
          // quietly turned into one of the thing. Blank still means one.
          if (tQty.trim() && (!isNum(tQty) || num(tQty) <= 0)) {
            Alert.alert('Check the quantity',
              `"${tQty.trim()}" is not a quantity. Use digits only — 2.5 for two and a half — or leave it empty for one.`);
            return;
          }
          add(tName.trim(), tBrand.trim(), tQty.trim() ? num(tQty) : 1, 0, tNote.trim(),
              normalizeUnit(tUnit));
          setTName(''); setTBrand(''); setTQty('1'); setTUnit(''); setTNote('');
        }}>
          <Ionicons name="add" size={18} color={C.onFill} />
          <Text style={s.primaryBtnText}>Add to Order</Text>
        </TouchableOpacity>
      </View>
      )}

      {cart.length > 0 && (
        <TouchableOpacity style={s.stickyCart} onPress={onCart} accessibilityRole="button"
          accessibilityLabel={`View cart, ${cart.length} item${cart.length === 1 ? '' : 's'}, ${money(cartTotal(cart))}`}>
          <Text style={s.stickyCartText}>View Cart ({cart.length})</Text>
          <Text style={s.stickyCartText}>{money(cartTotal(cart))}</Text>
        </TouchableOpacity>
      )}
    </>
  );

  return (
    <FlatList
      data={filtered}
      keyExtractor={(p) => p.id}
      renderItem={renderProduct}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      contentContainerStyle={s.body}
      keyboardShouldPersistTaps="handled"
    />
  );
}
