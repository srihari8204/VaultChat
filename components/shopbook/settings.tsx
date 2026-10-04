// components/shopbook/settings.tsx — Shop Book, moved out of app/shop-book.tsx
// unchanged. Palette and styles come from ./theme; see app/shop-book.tsx.

import { useCallback, useEffect, useState } from 'react';
import { KeyboardSafe } from '../ui';
import { View, Text, TouchableOpacity, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { SHOP_CATEGORIES } from '../../constants/shopCategories';
import { isNum, num, minsOfDay } from '../../utils/shopbook';
import * as SB from '../../services/shopBookService';
import { ErrorState } from '../finance/ui';
import { t } from '../../lib/shopbookI18n';
import { permissionDenied } from '../../lib/permissionDenied';
import { C, s } from './theme';
import { loadErrText, ReasonModal, SubHeader, Chip, Field, ToggleRow } from './shared';

export function ShopSettings({ shop, me, onSaved, onCancel }: {
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
  // ── moving a verified shop ──────────────────────────────────────
  //
  // A verified badge was granted against an address customers now walk to, so
  // the pin is fixed: past ~300m the save is refused with `location_locked` and
  // the move has to be reviewed. The endpoints for that have been live since
  // P1-D, and nothing in the app could create a request — so the refusal was a
  // dead end and an owner who genuinely moved shop had no way forward at all.
  const [moveAsk, setMoveAsk] = useState(false);
  const [locReq, setLocReq] = useState<SB.LocationRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  // Country Tax Engine: selecting a country loads its currency + optional
  // tax fields (spec: country-tax-engine). All tax fields stay optional.
  const [countryList, setCountryList] = useState<SB.CountryConfig[]>([]);
  const [country, setCountry] = useState(shop?.country ?? 'IN');
  const [taxConfig, setTaxConfig] = useState<Record<string, string | boolean>>(shop?.taxConfig ?? {});
  // Without the list there is no way to pick a country or see its tax fields,
  // so a failed read is shown with a retry rather than as an empty row.
  const [countryErr, setCountryErr] = useState('');
  const loadCountries = useCallback(async () => {
    setCountryErr('');
    try { setCountryList(await SB.countries()); }
    catch (e: any) { setCountryErr(loadErrText(e)); }
  }, []);
  useEffect(() => { loadCountries(); }, [loadCountries]);
  const countryCfg = countryList.find((c2) => c2.code === country);

  // Capture the shop's GPS location. `silent` skips the success alert (used for
  // the frictionless auto-capture when a new shop form first opens). Returns the
  // captured coords (or null) so the caller can use them without waiting on state.
  //
  // NOT named `useLocation`. It is an ordinary async function, but the `use`
  // prefix is how both eslint and the React Compiler (app.json: reactCompiler
  // true) identify a hook — and this is called conditionally inside an effect,
  // inside `save()`, and inside an onPress. Under the compiler that is a
  // component-wide bail-out at best, on a 3,800-line screen.
  const captureLocation = async (silent = false): Promise<{ lat: number; lng: number } | null> => {
    setLocating(true);
    try {
      const { status: perm, canAskAgain } = await Location.requestForegroundPermissionsAsync();
      if (perm !== 'granted') {
        if (!silent) {
          permissionDenied(
            'Location needed',
            'A shop location is required so nearby customers can find you and see how far away you are.',
            canAskAgain,
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

  // A decision the owner has not seen yet is the first thing they should see.
  useEffect(() => {
    if (!shop) return;
    let alive = true;
    SB.myLocationRequest().then((r) => { if (alive) setLocReq(r); }).catch(() => {});
    return () => { alive = false; };
  }, [shop]);

  const submitMove = async (reason: string) => {
    if (!coords) return;
    setBusy(true);
    try {
      await SB.requestLocationChange(coords.lat, coords.lng, address.trim(), reason);
      setLocReq(await SB.myLocationRequest());
      Alert.alert('Sent for review',
        'Your new location was sent for review. Customers keep seeing the current one until it is approved.');
    } catch (e: any) { Alert.alert('Could not send', e?.message ?? 'Try again'); }
    finally { setBusy(false); }
  };

  // Auto-capture location the first time a new shop is being created, so most
  // owners never have to think about it — location is required to save.
  //
  // ONLY when location is already granted. This used to REQUEST permission the
  // moment the form opened: a system dialog before the owner had read a word,
  // which gets refused reflexively and on Android can stick (same rule as
  // FindShops). getForegroundPermissionsAsync only reads the grant. Everyone
  // else is asked by "Use current location", or by Save, which needs it.
  useEffect(() => {
    if (shop || coords) return;
    Location.getForegroundPermissionsAsync()
      .then(({ status: perm }) => { if (perm === 'granted') captureLocation(true); })
      .catch(() => { /* the button below still asks */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (!name.trim()) { Alert.alert('Shop name required'); return; }
    // Times drive "Open now" for every customer, and the server stores what it
    // is given: "9am" or "21.00" would make the shop read Closed all day.
    if (minsOfDay(openTime) == null || minsOfDay(closeTime) == null) {
      Alert.alert('Check the opening hours', 'Use 24-hour HH:MM times, like 09:00 and 21:00.');
      return;
    }
    if (!!lunchStart.trim() !== !!lunchEnd.trim()
        || (lunchStart.trim() && (minsOfDay(lunchStart) == null || minsOfDay(lunchEnd) == null))) {
      Alert.alert('Check the lunch break', 'Give both times as HH:MM, like 13:30 and 16:30 — or leave both empty.');
      return;
    }
    // num() turns "20 min" into 0: a shop that says orders are ready instantly.
    if (!isNum(prep) || num(prep) < 0 || num(prep) > 24 * 60) {
      Alert.alert('Check the prep time', 'Enter the usual minutes to get an order ready, e.g. 20.');
      return;
    }
    // Location is mandatory — it's what powers nearby discovery + distance.
    let loc = coords;
    if (!loc) {
      loc = await captureLocation();
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
    } catch (e: any) {
      // Not an error the owner can fix by retrying — it is a request they have
      // to make. Offer that instead of the refusal.
      if (SB.locationLocked(e)) { setMoveAsk(true); return; }
      Alert.alert('Error', e?.message ?? 'Try again');
    }
    finally { setBusy(false); }
  };

  return (
    <>
      <SubHeader title={shop ? 'Shop Settings' : 'Create Your Shop'} onBack={onCancel} />
      <ReasonModal visible={moveAsk} title="Why is the shop moving?"
        placeholder="e.g. moved to the next street, corrected a wrong pin"
        onSubmit={submitMove} onClose={() => setMoveAsk(false)} />
      <KeyboardSafe style={{ flex: 1 }} >
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
              <TouchableOpacity key={st} style={[s.statusBtn, status === st && s.statusBtnActive]} onPress={() => setStatus(st)}
                accessibilityRole="radio" accessibilityState={{ checked: status === st }}
                accessibilityLabel={t(`owner.status.${st}`)}>
                <Text style={[s.statusBtnText, status === st && { color: '#fff' }]}>{lbl}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Country + tax engine */}
          <Text style={s.fieldLabel}>{t('owner.country')}</Text>
          {!!countryErr && <ErrorState title="Couldn’t load the country list" sub={countryErr} onRetry={loadCountries} />}
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
          <TouchableOpacity style={[s.outlineBtn, locating && { opacity: 0.6 }]} disabled={locating} onPress={() => captureLocation()}
            accessibilityRole="button" accessibilityState={{ disabled: locating, busy: locating }}>
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
          {shop?.verified && (
            <Text style={s.hint}>
              This shop is verified, so its pin is fixed. Moving it more than a few
              hundred metres is reviewed before customers see the new place.
            </Text>
          )}
          {locReq && (
            <View style={[s.panel, { borderColor: locReq.status === 'rejected' ? C.danger : C.amber }]}>
              <Text style={{ color: locReq.status === 'rejected' ? C.danger : C.amber, fontWeight: '700' }}>
                {locReq.status === 'pending'
                  ? `Location change under review — ${locReq.distanceKm.toFixed(1)} km away`
                  : locReq.status === 'approved' ? 'Location change approved'
                  : 'Location change rejected'}
              </Text>
              {!!locReq.reason && <Text style={s.hint}>Your reason: {locReq.reason}</Text>}
              {!!locReq.reviewNote && <Text style={s.hint}>Reviewer: {locReq.reviewNote}</Text>}
            </View>
          )}
          <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={save}
            accessibilityRole="button" accessibilityLabel={shop ? 'Save settings' : 'Create shop'} accessibilityState={{ disabled: busy, busy }}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryBtnText}>{shop ? 'Save Settings' : 'Create Shop'}</Text>}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardSafe>
    </>
  );
}
