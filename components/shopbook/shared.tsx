// components/shopbook/shared.tsx — Shop Book: small components and helpers every Shop Book screen uses.
// Split out of app/shop-book.tsx on 2026-10-04 and edited since (fixes are
// logged per round). Palette and styles come from ./theme.

import React, { useEffect, useState } from 'react';
import { KeyboardSafe } from '../ui';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Alert, Switch, Modal } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router as navRouter } from 'expo-router';
import { navigateTo } from '../../lib/nav/openNavigation';
import { formatMoney, orderStatusLabel, REJECT_REASONS, isTerminalFailure, type OrderStatus, type ItemAvailability, dateLocale } from '../../utils/shopbook';
import * as SB from '../../services/shopBookService';
import { StatTile, EmptyState } from '../finance/ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '../../lib/shopbookI18n';
import { C, s } from './theme';

/**
 * Show a generated Shop Book document INSIDE crazzychat.
 *
 * Every bill, receipt and invoice here went straight from Print.printToFileAsync
 * to Sharing.shareAsync — the OS share sheet was the only thing that ever
 * displayed them. A shopkeeper could not read the bill they had just issued
 * without exporting it to another app first, and on a device with no share
 * target (`isAvailableAsync()` false) the document silently went nowhere at all.
 *
 * app/file-viewer.tsx renders PDF pages in-app (components/PdfView → pdf.js) and
 * still offers Share and Open-with from its own header, so routing here adds the
 * preview WITHOUT removing the export. Nothing about the document changes: the
 * file is the one printToFileAsync produced, already numbered and stored
 * server-side, and this only decides what is shown next.
 */
export function previewDoc(uri: string, filename: string, mimeType = 'application/pdf'): void {
  navRouter.push({ pathname: '/file-viewer', params: { uri, filename, mimeType } });
}

/** What to say when a load fails. Shown in ErrorState with a retry, so a
 *  failure never reads as "nothing here". */
export const loadErrText = (e: any): string => e?.message || 'Check your connection and try again.';

export function Row({ label, value, tone, bold }: { label: string; value: string; tone?: string; bold?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
      <Text style={[{ color: C.sub, fontSize: 14 }, bold && { color: C.text, fontWeight: '800', fontSize: 16 }]}>{label}</Text>
      <Text style={[{ color: tone ?? C.text, fontSize: 14, fontWeight: '600' }, bold && { fontWeight: '800', fontSize: 16 }]}>{value}</Text>
    </View>
  );
}

// A Shop Book realtime event. Payload carries identifiers only — never the new
// state — so a listener's only correct reaction is to re-fetch.
export interface ShopBookEvent {
  event: string;
  title: string;
  body: string;
  data: { orderId?: string; shopId?: string; status?: string; [k: string]: any };
}

// Subscribes to the socket for the life of the caller. Registration is async
// (the socket may still be connecting), so the returned unsubscribe is safe to
// call before it has finished attaching.
export function onShopBookEvent(handler: (ev: ShopBookEvent) => void): () => void {
  let detach: (() => void) | null = null;
  let cancelled = false;
  import('../../lib/socket')
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

// Cross-platform "why?" prompt (Alert.prompt is iOS-only): free-text reason,
// optionally preceded by the fixed rejection reason codes.
export function ReasonModal({ visible, title, codes, placeholder, maxLength, onSubmit, onClose }: {
  visible: boolean; title: string; codes?: typeof REJECT_REASONS;
  placeholder?: string; maxLength?: number;
  onSubmit: (reason: string, code?: string) => void; onClose: () => void;
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
      {/* KeyboardSafe + scroller (2026-09-18): ReasonModal is the reject /
          cancel / not-collected prompt, so it is reached three times from the
          order screen. A <Modal> never receives the activity's adjustResize,
          so the autoFocus'd reason field had no avoidance at all. */}
      <KeyboardSafe keyboardOnly style={s.modalWrap}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={s.modalScroll} keyboardShouldPersistTaps="handled">
        <View style={s.modalCard}>
          <Text numberOfLines={1} style={s.modalTitle} accessibilityRole="header">{title}</Text>
          {codes && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 10 }}
              accessibilityRole="radiogroup" accessibilityLabel="Reason">
              {codes.map((rc) => (
                <TouchableOpacity key={rc.code} style={[s.chip, code === rc.code && s.chipActive]}
                  accessibilityRole="radio" accessibilityState={{ checked: code === rc.code }}
                  onPress={() => setCode(rc.code)}>
                  <Text style={[s.chipText, code === rc.code && { color: C.onFill }]}>{rc.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          {needText && (
            <TextInput style={s.input} placeholder={placeholder ?? 'Reason'} placeholderTextColor={C.sub}
              accessibilityLabel={title} value={text} onChangeText={setText} autoFocus maxLength={maxLength} />
          )}
          <TouchableOpacity style={s.primaryBtn} onPress={submit} accessibilityRole="button">
            <Text style={s.primaryBtnText}>{t('common.save')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.dangerBtn} onPress={onClose} accessibilityRole="button">
            <Text style={s.dangerBtnText}>{t('common.cancel')}</Text>
          </TouchableOpacity>
        </View>
        </ScrollView>
      </KeyboardSafe>
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════
//  shared bits
// ════════════════════════════════════════════════════════════════
export function TabBar({ tabs, active, onChange }: {
  tabs: { id: string; label: string; icon: keyof typeof Ionicons.glyphMap }[];
  active: string; onChange: (id: string) => void;
}) {
  // The device's own bottom inset (gesture bar / home indicator), not a fixed
  // 20dp that was too much on a button-nav phone and too little on a notch.
  const insets = useSafeAreaInsets();
  return (
    <View style={[s.tabBar, { paddingBottom: Math.max(insets.bottom, 8) }]} accessibilityRole="tablist">
      {tabs.map((t) => (
        <TouchableOpacity key={t.id} style={s.tab} onPress={() => onChange(t.id)}
          accessibilityRole="tab" accessibilityLabel={t.label} accessibilityState={{ selected: active === t.id }}>
          <Ionicons name={t.icon} size={22} color={active === t.id ? C.green : C.sub} />
          <Text style={[s.tabLabel, active === t.id && { color: C.green, fontWeight: '700' }]}>{t.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

export function SubHeader({ title, onBack, right }: {
  title: string; onBack?: () => void;
  right?: { icon: keyof typeof Ionicons.glyphMap; label: string; badge?: number; onPress: () => void };
}) {
  return (
    <View style={s.subHeader}>
      {onBack ? (
        <TouchableOpacity onPress={onBack} accessibilityRole="button" accessibilityLabel="Go back" hitSlop={10} style={s.hBtn}>
          <Ionicons name="arrow-back" size={22} color={C.text} />
        </TouchableOpacity>
      ) : <View style={{ width: 38 }} />}
      <Text style={s.subHeaderTitle} numberOfLines={1} accessibilityRole="header">{title}</Text>
      {right ? (
        <TouchableOpacity onPress={right.onPress} hitSlop={10} style={s.hBtn}
          accessibilityRole="button" accessibilityLabel={right.label}>
          <Ionicons name={right.icon} size={22} color={C.text} />
          {!!right.badge && <View style={s.cartBadge}><Text style={s.cartBadgeText}>{right.badge}</Text></View>}
        </TouchableOpacity>
      ) : <View style={{ width: 38 }} />}
    </View>
  );
}

/** An Ionicons glyph name, as opposed to an emoji or a blank icon. */
const isGlyph = (icon: string): icon is keyof typeof Ionicons.glyphMap => icon in Ionicons.glyphMap;

export function Chip({ label, icon, active, onPress }: { label: string; icon: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[s.chip, active && s.chipActive]} onPress={onPress}
      // The icon is an emoji or a glyph name, never a label worth reading out.
      accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: active }}>
      {isGlyph(icon)
        ? <Ionicons name={icon} size={14} color={active ? C.onFill : C.sub} />
        : <Text style={{ fontSize: 13 }}>{icon}</Text>}
      <Text style={[s.chipText, active && { color: C.onFill }]}>{label}</Text>
    </TouchableOpacity>
  );
}

/**
 * Kept as a name because four other screens call it, but it is now the shared
 * glass StatTile underneath — so the dashboard's TileGrid and the ledger's
 * stat row cannot drift into two different tile designs.
 *
 * The tone names are the Shop Book vocabulary mapped onto the shared semantic
 * one; 'navy' has no semantic twin and reads as informational.
 */
export function StatCard({ label, value, tone }: { label: string; value: string; tone: 'green' | 'navy' | 'amber' | 'danger' }) {
  const t = tone === 'green' ? 'good' : tone === 'navy' ? 'info' : tone === 'amber' ? 'warn' : 'bad';
  return <StatTile label={label} value={value} tone={t} style={{ flex: 1 }} />;
}

// Directions to the shop via the app's own turn-by-turn (Valhalla) — the same
// openNavigation seam every other location surface uses. No external maps app,
// works on no-GMS devices.
export function openDirections(shop: SB.Shop) {
  if (shop.lat == null || shop.lng == null) return;
  navigateTo(shop.lat, shop.lng, shop.name || 'Shop');
}

export function InfoRow({ icon, label, value }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string }) {
  return (
    <View style={s.infoRow}>
      <Ionicons name={icon} size={18} color={C.sub} />
      <Text style={s.infoLabel}>{label}</Text>
      <Text style={s.infoValue} numberOfLines={2}>{value}</Text>
    </View>
  );
}

export function Field({ label, value, onChange, placeholder, keyboardType }: {
  label: string; value: string; onChange: (t: string) => void; placeholder?: string;
  keyboardType?: 'default' | 'numeric' | 'phone-pad';
}) {
  return (
    <>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput style={s.input} value={value} onChangeText={onChange} placeholder={placeholder}
        accessibilityLabel={label}
        placeholderTextColor={C.sub} keyboardType={keyboardType ?? 'default'} />
    </>
  );
}

export function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={s.toggleRow}>
      <Text style={s.toggleLabel}>{label}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: C.green }}
        accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{ checked: value }} />
    </View>
  );
}

export function StatusPill({ status, big }: { status: OrderStatus; big?: boolean }) {
  const done = status === 'completed' || status === 'collected';
  const fail = isTerminalFailure(status);
  const color = fail ? C.danger : done ? C.green : C.blue;
  // Was `color + '20'` — a 12.5% alpha wash of the foreground. On an opaque
  // white card that was merely weak; on a translucent glass pane the ground
  // shows through it and the pill all but disappears. The soft tokens are
  // solid fills chosen to clear AA against their own foreground.
  const bg = fail ? C.dangerSoft : done ? C.greenSoft : C.infoSoft;
  return (
    <View
      style={[s.pill, { backgroundColor: bg }, big && { alignSelf: 'flex-start', marginBottom: 12 }]}
      accessible accessibilityLabel={`Status: ${orderStatusLabel(status)}`}
    >
      {/* The dot is not decorative: it is the second, non-colour cue that this
          is a status and not a label. */}
      <View style={[s.pillDot, { backgroundColor: color }]} />
      <Text style={[s.pillText, { color }, big && { fontSize: 15 }]}>{orderStatusLabel(status)}</Text>
    </View>
  );
}

export function AvailabilityTag({ a, altName }: { a: ItemAvailability; altName: string }) {
  if (a === 'pending') return <Text style={[s.availTag, { color: C.sub }]}>⏳ Awaiting shop</Text>;
  if (a === 'available') return <Text style={[s.availTag, { color: C.green }]}>✓ Available</Text>;
  if (a === 'unavailable') return <Text style={[s.availTag, { color: C.danger }]}>✕ Not available</Text>;
  return <Text style={[s.availTag, { color: C.amber }]}>🔁 Alternative: {altName}</Text>;
}

// onShare is owner-only: a customer may read their ledger but cannot issue the
// shop's numbered documents, so the customer view simply omits the prop.
/**
 * The transaction row. Khata customers and ledger entries were each hand-rolling
 * this same shape — icon bubble, title, sub, right-aligned money — with the
 * amount drifting between styles. One row, one money alignment.
 *
 * `children` carries whatever the caller needs under the sub line: ledger item
 * lines, a staleness warning. That is the only variation the two callers had.
 */
export function TxnRow({
  icon, iconTone = 'brand', title, sub, amount, amountTone = 'plain', amountNote,
  right, action, onPress, children,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  iconTone?: 'brand' | 'good' | 'bad' | 'warn';
  title: string;
  sub?: string;
  amount?: string;
  amountTone?: 'plain' | 'good' | 'bad';
  /** What the figure MEANS, printed under it. Without this the colour is the
   *  only thing saying "pending" rather than "paid", and colour alone is not
   *  an accessible carrier of meaning. */
  amountNote?: string;
  right?: React.ReactNode;
  /** A button drawn in `right`. The row is grouped into one screen-reader
   *  element, which hides buttons inside it, so the button is also offered
   *  as an accessibility action on the row. */
  action?: { label: string; onPress: () => void };
  onPress?: () => void;
  children?: React.ReactNode;
}) {
  const fg = iconTone === 'good' ? C.good : iconTone === 'bad' ? C.danger
    : iconTone === 'warn' ? C.amber : C.green;
  const bg = iconTone === 'good' ? C.goodSoft : iconTone === 'bad' ? C.dangerSoft
    : iconTone === 'warn' ? C.warnSoft : C.greenSoft;
  const amtColor = amountTone === 'good' ? C.good : amountTone === 'bad' ? C.danger : C.text;
  const Wrap: React.ElementType = onPress ? TouchableOpacity : View;
  return (
    <Wrap
      style={[s.card, { alignItems: 'flex-start' }]}
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessible
      // The amount is part of the row's meaning, so it belongs in the label —
      // a screen reader that reads the name and not the balance is useless on
      // a khata.
      accessibilityLabel={[title, sub, amountNote, amount].filter(Boolean).join(', ')}
      accessibilityActions={action ? [{ name: 'rowAction', label: action.label }] : undefined}
      onAccessibilityAction={action ? (e: { nativeEvent: { actionName: string } }) => {
        if (e.nativeEvent.actionName === 'rowAction') action.onPress();
      } : undefined}
    >
      <View style={[s.shopIcon, { backgroundColor: bg }]}>
        <Ionicons name={icon} size={20} color={fg} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.cardTitle} numberOfLines={1}>{title}</Text>
        {sub ? <Text style={s.cardSub}>{sub}</Text> : null}
        {children}
      </View>
      <View style={{ alignItems: 'flex-end', gap: 6 }}>
        {amount ? (
          <Text style={[s.price, { color: amtColor, marginTop: 0 }]} numberOfLines={1}>{amount}</Text>
        ) : null}
        {amountNote ? <Text style={s.amountNote}>{amountNote}</Text> : null}
        {right}
      </View>
    </Wrap>
  );
}

// LedgerEntry carries no currency of its own, so the shop's travels in from
// the parent. Defaulting to ₹ keeps every existing caller correct.
export function LedgerRow({ entry, currency, onShare }: { entry: SB.LedgerEntry; currency?: string; onShare?: () => void }) {
  const money = (n: number) => formatMoney(n, currency || '₹');
  const isPay = entry.type === 'payment';
  const at = new Date(entry.createdAt);
  // Date AND time. "₹500 on 14 Aug" is not something either side can reconcile
  // against a day with several entries — which is the normal case on a khata.
  const stamp = `${at.toLocaleDateString(dateLocale())} · ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const items = entry.items ?? [];
  return (
    <TxnRow
      icon={isPay ? 'arrow-down-circle-outline' : 'bag-handle-outline'}
      iconTone={isPay ? 'good' : 'warn'}
      title={isPay ? 'Payment received' : 'Purchase'}
      sub={`${stamp}${entry.remark ? ` · ${entry.remark}` : ''}`}
      // A payment reduces what is owed and a purchase increases it; the sign
      // and the colour say the same thing twice on purpose, because colour
      // alone is not an accessible carrier of meaning.
      amount={`${isPay ? '−' : '+'}${money(entry.amount)}`}
      amountTone={isPay ? 'good' : 'bad'}
      action={onShare ? { label: isPay ? 'Share receipt' : 'Share bill', onPress: onShare } : undefined}
      right={onShare ? (
        <TouchableOpacity onPress={onShare} hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={isPay ? 'Share receipt' : 'Share bill'}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Ionicons name="share-outline" size={14} color={C.green} />
          <Text style={{ color: C.green, fontSize: 12, fontWeight: '700' }}>
            {isPay ? 'Receipt' : 'Bill'}
          </Text>
        </TouchableOpacity>
      ) : undefined}
    >
      {/* Read-only lines of one saved entry; position is their identity. */}
      {items.map((it, i) => (
        <Text key={`${i}-${it.name}`} style={s.ledgerItemLine} numberOfLines={1}>
          {it.name}{it.unit ? ` (${it.unit})` : ''} · {it.qty} × {money(it.price)}
        </Text>
      ))}
    </TxnRow>
  );
}

export function Empty({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) {
  return <EmptyState icon={icon} title={text} />;
}

/**
 * The one advisory strip. Replaces four hand-rolled
 * `[s.panel, { borderColor: C.amber }]` blocks that each re-stated the same
 * layout slightly differently.
 */
export function Banner({ tone, text, sub, icon, onPress }: {
  tone: 'warn' | 'bad' | 'info';
  text: string; sub?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
}) {
  const fg = tone === 'warn' ? C.amber : tone === 'bad' ? C.danger : C.blue;
  const bg = tone === 'warn' ? C.warnSoft : tone === 'bad' ? C.dangerSoft : C.infoSoft;
  const Wrap: React.ElementType = onPress ? TouchableOpacity : View;
  return (
    <Wrap
      style={[s.banner, { backgroundColor: bg, borderColor: fg }]}
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessible
      accessibilityLabel={sub ? `${text}. ${sub}` : text}
    >
      {icon ? <Ionicons name={icon} size={20} color={fg} /> : null}
      <View style={{ flex: 1 }}>
        <Text style={[s.bannerText, { color: fg }]}>{text}</Text>
        {sub ? <Text style={s.bannerSub}>{sub}</Text> : null}
      </View>
      {onPress ? <Ionicons name="chevron-forward" size={18} color={fg} /> : null}
    </Wrap>
  );
}
