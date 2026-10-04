// components/finance/ui.tsx — shared UI primitives for the Vault Finance hub.
//
// One set of themed building blocks so every finance screen looks the same and
// screen files stay small. All colors come from constants/financeTheme, all
// layout rules from lib/finance/grid.
//
// Implements the components in the Figma library "crazzychat — Vault Finance"
// (N5Y6KcMUPA3LgtWjfHPctz, page "Components"). Component names map 1:1:
// Glass Card → Card, Stat Tile → StatTile, Status Pill → Pill,
// Finance Button → Btn, Segmented Control → Segment, Quick Action →
// QuickAction, Balance Hero → HeroCard, Empty State → EmptyState.
//
// ── Why there is no BlurView here ────────────────────────────────────
// expo-blur is installed, and it is the wrong tool for this surface. A live
// backdrop blur behind a scrolling ledger list is the most expensive thing you
// can ask a mid-range Android GPU to do, and against a ground this light it is
// nearly invisible anyway. The frost comes from a translucent fill, a lit rim
// and a soft shadow — all of which are free.

import React, { useState } from 'react';
import { useFinanceTheme } from './useFinanceTheme';
import { useTheme } from '../../lib/theme';
import {
  View, Text, TextInput, TouchableOpacity, Pressable, StyleSheet, StatusBar,
  ActivityIndicator, useWindowDimensions,
  type ViewStyle, type TextStyle, type KeyboardTypeOptions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FIN, FIN_RADIUS, FIN_SHADOW, TABULAR, type FinancePalette, FIN_HERO, HERO_INK } from '../../constants/financeTheme';
import {
  FIN_GUTTER, FIN_GAP, contentWidth, tileColumns, quickActionColumns,
  heroStacks, columnWidth,
} from '../../lib/finance/grid';

type IconName = keyof typeof Ionicons.glyphMap;

/** Smallest interactive box we ship. Android's own guidance and WCAG agree. */
const TAP = 44;

// ── Screen chrome ───────────────────────────────────────────────────

/**
 * Screen header.
 *
 * The status-bar offset is READ from the device, not guessed. This used to be
 * `paddingTop: Platform.OS === 'ios' ? 54 : 40`, which is wrong on every
 * Android phone with a punch-hole or a hidden gesture bar — the title sat under
 * the clock on some devices and floated with a band of dead space on others.
 */
export function FinHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  const { scheme } = useTheme();
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View style={[s.header, { paddingTop: insets.top + 8 }]}>
      <StatusBar barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'} backgroundColor="transparent" translucent />
      <TouchableOpacity
        // Opened from a deep link (or the legacy /interest-calculator redirect)
        // there is nothing to go back to; land on the finance dashboard.
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/finance'))}
        hitSlop={10}
        style={s.hBtn}
        accessibilityRole="button"
        accessibilityLabel="Go back"
      >
        <Ionicons name="arrow-back" size={22} color={FIN.text} />
      </TouchableOpacity>
      <Text style={s.headerTitle} numberOfLines={1} accessibilityRole="header">{title}</Text>
      <View style={s.hRight}>{right}</View>
    </View>
  );
}

/**
 * The body wrapper every scrolling finance screen should use for its content.
 * Applies the gutter and caps the reading column on tablets, centred — past
 * ~600dp a balance sheet stretched edge to edge is a banner, not a document.
 */
export function FinBody({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const { width } = useWindowDimensions();
  const inner = contentWidth(width);
  return (
    <View style={[s.bodyOuter, style]}>
      <View style={{ width: inner, maxWidth: '100%' }}>{children}</View>
    </View>
  );
}

export function Label({ children, hint }: { children: React.ReactNode; hint?: string }) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  return <Text style={s.label}>{children}{hint ? <Text style={s.hint}>  {hint}</Text> : null}</Text>;
}

export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  return (
    <View style={s.sectionRow}>
      <Text style={s.sectionTitle} accessibilityRole="header">{children}</Text>
      {action}
    </View>
  );
}

// ── Inputs ──────────────────────────────────────────────────────────

/**
 * Text field. Focus and error are real visible states — an unvalidated money
 * field that silently swallows a bad value is how a ledger ends up wrong.
 */
export function Field(props: {
  /** The visible label's text, spoken by screen readers. The placeholder is
   *  only a sample ("₹ 0"), so it is a fallback, never the name. */
  label?: string;
  value: string; onChangeText: (t: string) => void; placeholder?: string;
  keyboardType?: KeyboardTypeOptions; multiline?: boolean; error?: string;
  /** Password fields (the Full Backup password). */
  secureTextEntry?: boolean; autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters'; autoCorrect?: boolean;
  style?: ViewStyle | TextStyle | (ViewStyle | TextStyle)[];
}) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const { style, multiline, error, label, ...rest } = props;
  const [focused, setFocused] = useState(false);
  return (
    <View>
      <TextInput
        {...rest}
        multiline={multiline}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholderTextColor={FIN.faint}
        accessibilityLabel={label ?? rest.placeholder}
        style={[
          s.field,
          multiline && s.fieldMulti,
          focused && s.fieldFocus,
          !!error && s.fieldError,
          style as any,
        ]}
      />
      {error ? <Text style={s.fieldErrTxt} accessibilityLiveRegion="polite">{error}</Text> : null}
    </View>
  );
}

/**
 * Date button. `label` is the field's name ("Start date", "End date"), so two
 * date fields on one form do not both read "Date … Change date". `onClear`
 * (optional fields only) adds a clear button once a date is set.
 */
export function DateField({ value, onPress, label = 'Date', onClear }: {
  value: string; onPress: () => void; label?: string; onClear?: () => void;
}) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <TouchableOpacity
        style={[s.dateField, { flex: 1 }]} onPress={onPress} activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={value ? `${label}: ${value}. Change ${label.toLowerCase()}` : `${label}: not set. Choose a date`}
      >
        <Text style={[s.dateTxt, !value && { color: FIN.faint }]}>{value || 'dd/mm/yyyy'}</Text>
        <View style={s.dateBtn}><Ionicons name="calendar" size={18} color={FIN.onBrand} /></View>
      </TouchableOpacity>
      {onClear && value ? (
        <IconBtn icon="close-circle-outline" label={`Clear ${label.toLowerCase()}`} onPress={onClear} />
      ) : null}
    </View>
  );
}

/** Segmented control: a recessed glass track with one raised chip. */
export function Segment<T extends string>({ options, value, onChange, small }: {
  options: { k: T; label: string }[]; value: T; onChange: (k: T) => void; small?: boolean;
}) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  return (
    <View style={s.segment} accessibilityRole="tablist">
      {options.map(o => {
        const active = value === o.k;
        return (
          <TouchableOpacity
            key={o.k}
            style={[s.segBtn, small && s.segBtnSm, active && s.segBtnOn]}
            onPress={() => onChange(o.k)}
            activeOpacity={0.85}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={o.label}
          >
            {/* Four segments including "Lucky Draw" (saved.tsx) leave ~62dp per
                label at 320dp. Shrink to fit rather than ellipsize — a segment
                reading "Lucky D…" is worse than one a point smaller. */}
            <Text
              style={[s.segTxt, small && { fontSize: 12.5 }, active && s.segTxtOn]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.82}
            >
              {o.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export function Radio({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  return (
    <TouchableOpacity
      style={s.radio} onPress={onPress} activeOpacity={0.85} hitSlop={8}
      accessibilityRole="radio" accessibilityState={{ selected: active }} accessibilityLabel={label}
    >
      <View style={[s.radioDot, active && { borderColor: FIN.brand }]}>{active && <View style={s.radioInner} />}</View>
      <Text style={[s.radioLabel, active && { color: FIN.brandInk, fontWeight: '700' }]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ── Buttons ─────────────────────────────────────────────────────────
export function Btn({ label, onPress, kind = 'primary', icon, wide, style, disabled, loading }: {
  label: string; onPress: () => void; kind?: 'primary' | 'ghost' | 'danger';
  icon?: IconName; wide?: boolean; style?: ViewStyle; disabled?: boolean; loading?: boolean;
}) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const ghost = kind === 'ghost';
  const off = !!disabled || !!loading;
  const fg = ghost ? FIN.brandInk : FIN.onBrand;

  // SINGLE-FLIGHT LATCH — the fix for six confirmed duplicate writes.
  //
  // Six finance screens pass neither `disabled` nor `loading` and hold no busy
  // state of their own, so the form stayed live for the whole await and a second
  // press wrote a second row: a repayment recorded twice in ledger_updates, a
  // duplicate loan, a duplicate chitti group, two members sharing one `number`,
  // two OS notifications where only one can ever be cancelled, a duplicate
  // interest row. Every one of those writes mints a fresh uuid() and there is no
  // unique index behind them, so nothing downstream collapses the duplicate.
  //
  // A ref, not state: `setBusy(true)` only blocks the next press once a render
  // has flushed, and these handlers open SQLite on the first call of a session,
  // which is exactly when the window is widest.
  //
  // IT LATCHES ONLY ON A PROMISE. A handler that returns nothing behaves exactly
  // as it did before this existed — which is what keeps this from changing the
  // many Btn presses that are already fine. Fixing it here rather than adding
  // six `busy` states is one change instead of six, in the component they
  // already share.
  const inFlight = React.useRef(false);
  const guardedPress = React.useCallback(() => {
    if (inFlight.current) return;
    const r = (onPress as () => unknown)();
    if (r && typeof (r as Promise<unknown>).then === 'function') {
      inFlight.current = true;
      void (r as Promise<unknown>).finally(() => { inFlight.current = false; });
    }
  }, [onPress]);

  return (
    <Pressable
      style={({ pressed }) => [
        s.btn,
        wide && { flex: 1 },
        ghost ? s.btnGhost : kind === 'danger' ? s.btnDanger : s.btnPrimary,
        pressed && !off && s.btnPressed,
        off && s.btnOff,
        style,
      ]}
      onPress={guardedPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy: !!loading }}
      accessibilityLabel={label}
    >
      {loading
        ? <ActivityIndicator size="small" color={fg} style={{ marginRight: 8 }} />
        : icon ? <Ionicons name={icon} size={16} color={fg} style={{ marginRight: 6 }} /> : null}
      <Text style={[s.btnTxt, { color: fg }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

/** Square icon button that is always at least a 44dp target. */
export function IconBtn({ icon, onPress, label, tone }: {
  icon: IconName; onPress: () => void; label: string; tone?: 'plain' | 'brand';
}) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [s.iconBtn, pressed && { opacity: 0.7 }]}
      accessibilityRole="button" accessibilityLabel={label}
    >
      <Ionicons name={icon} size={20} color={tone === 'brand' ? FIN.brandDeep : FIN.text} />
    </Pressable>
  );
}

// ── Cards / tiles ───────────────────────────────────────────────────

/** The primary glass pane. */
export function Card({ children, style, raised }: {
  children: React.ReactNode; style?: ViewStyle; raised?: boolean;
}) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  return <View style={[s.card, raised && s.cardRaised, style]}>{children}</View>;
}

export function StatTile({ value, label, tone = 'plain', style }: {
  value: string; label: string; tone?: 'plain' | 'good' | 'bad' | 'warn' | 'info' | 'brand';
  style?: ViewStyle;
}) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const c = tone === 'good' ? FIN.good : tone === 'bad' ? FIN.bad : tone === 'warn' ? FIN.warn
    : tone === 'info' ? FIN.info : tone === 'brand' ? FIN.brandDeep : FIN.text;
  return (
    // The label always states what the number is, so tone is never the only
    // carrier of meaning — the a11y requirement and the legibility one agree.
    <View style={[s.tile, style]} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={[s.tileVal, { color: c }, TABULAR]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
        {value}
      </Text>
      <Text style={s.tileLbl} numberOfLines={2}>{label}</Text>
    </View>
  );
}

/**
 * Responsive tile grid. Two-up on a phone, four-up once there is room —
 * derived from the measured window, never from a device list.
 */
export function TileGrid({ children }: { children: React.ReactNode }) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const { width } = useWindowDimensions();
  const cols = tileColumns(width);
  const w = columnWidth(contentWidth(width), cols);
  return (
    <View style={s.grid}>
      {React.Children.map(children, (child) =>
        React.isValidElement(child)
          ? <View style={{ width: w }}>{child}</View>
          : child)}
    </View>
  );
}

/** Responsive quick-action grid: as many columns as genuinely fit. */
export function ActionGrid({ children }: { children: React.ReactNode }) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const { width } = useWindowDimensions();
  const cols = quickActionColumns(width);
  const w = columnWidth(contentWidth(width), cols);
  return (
    <View style={s.grid}>
      {React.Children.map(children, (child) =>
        React.isValidElement(child)
          ? <View style={{ width: w }}>{child}</View>
          : child)}
    </View>
  );
}

/**
 * The balance hero — the one saturated surface in Vault Finance. Everything
 * else is ice glass, which is what lets this read as the primary value without
 * shouting.
 */
export function HeroCard({ children, colors }: { children: React.ReactNode; colors?: [string, string] }) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  return (
    <LinearGradient
      colors={colors ?? FIN_HERO.brand}
      start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
      style={s.hero}
    >
      {children}
    </LinearGradient>
  );
}

/**
 * Lays out the hero's two figures. Side by side normally; stacked below 360dp,
 * where a split hero breaks "₹4,52,000" across two lines mid-number. Found on
 * the 320dp Figma artboard, pinned by grid.selftest §5.
 */
export function HeroSplit({ children }: { children: React.ReactNode }) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const { width } = useWindowDimensions();
  const stack = heroStacks(width);
  return (
    <View style={stack ? s.heroStack : s.heroRow}>
      {React.Children.map(children, (child, i) => (
        <>
          {i > 0 && !stack ? <View style={s.heroDivider} /> : null}
          <View style={{ flex: stack ? undefined : 1, minWidth: 0, width: stack ? '100%' : undefined }}>
            {child}
          </View>
        </>
      ))}
    </View>
  );
}

export function Pill({ label, fg, bg }: { label: string; fg: string; bg: string }) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  return (
    <View style={[s.pill, { backgroundColor: bg }]} accessible accessibilityLabel={`Status: ${label}`}>
      <Text style={[s.pillTxt, { color: fg }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

export function RowLine({ k, v, bold, tone }: { k: string; v: string; bold?: boolean; tone?: 'good' | 'bad' | 'warn' }) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const c = tone === 'good' ? FIN.good : tone === 'bad' ? FIN.bad : tone === 'warn' ? FIN.warn : FIN.text;
  return (
    <View style={s.rowLine} accessible accessibilityLabel={`${k}: ${v}`}>
      <Text style={s.rowKey} numberOfLines={2}>{k}</Text>
      <Text style={[s.rowVal, bold && { fontWeight: '800' }, { color: c }, TABULAR]} numberOfLines={1}>{v}</Text>
    </View>
  );
}

export function QuickAction({ icon, label, onPress, colors }: {
  icon: IconName; label: string; onPress: () => void; colors?: [string, string];
}) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  return (
    <Pressable
      style={({ pressed }) => [s.qa, pressed && { opacity: 0.65, transform: [{ scale: 0.97 }] }]}
      onPress={onPress}
      accessibilityRole="button" accessibilityLabel={label}
    >
      <View style={s.qaIcon}>
        <Ionicons name={icon} size={22} color={colors ? colors[1] : FIN.brandDeep} />
      </View>
      <Text style={s.qaLbl} numberOfLines={2}>{label}</Text>
    </Pressable>
  );
}

// ── Screen states ───────────────────────────────────────────────────
export function EmptyState({ icon, title, sub }: { icon: IconName; title: string; sub?: string }) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  return (
    <View style={s.empty} accessible accessibilityLabel={sub ? `${title}. ${sub}` : title}>
      <View style={s.emptyIcon}><Ionicons name={icon} size={26} color={FIN.faint} /></View>
      <Text numberOfLines={1} style={s.emptyTitle}>{title}</Text>
      {sub ? <Text style={s.emptySub}>{sub}</Text> : null}
    </View>
  );
}

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  return (
    <View style={s.empty} accessible accessibilityLabel={label} accessibilityRole="progressbar">
      <ActivityIndicator size="small" color={FIN.brandDeep} />
      <Text style={s.emptySub}>{label}</Text>
    </View>
  );
}

export function ErrorState({ title = 'Something went wrong', sub, onRetry }: {
  title?: string; sub?: string; onRetry?: () => void;
}) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  return (
    <View style={s.empty}>
      {/* Only the message is grouped: an `accessible` outer View would also
          swallow the Try again button, leaving it unreachable on iOS. */}
      <View style={{ alignItems: 'center', gap: 6 }} accessible accessibilityRole="alert"
        accessibilityLabel={sub ? `${title}. ${sub}` : title}>
        <View style={[s.emptyIcon, { backgroundColor: FIN.badSoft }]}>
          <Ionicons name="alert-circle-outline" size={26} color={FIN.bad} />
        </View>
        <Text numberOfLines={1} style={s.emptyTitle}>{title}</Text>
        {sub ? <Text style={s.emptySub}>{sub}</Text> : null}
      </View>
      {onRetry ? <Btn label="Try again" kind="ghost" onPress={onRetry} style={{ marginTop: 12 }} /> : null}
    </View>
  );
}

/** Progress ring built from two nested circles — no SVG, no reflow cost. */
export function ProgressRing({ pct, size = 44 }: { pct: number; size?: number }) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeStyles(FIN), [FIN]);
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <View
      style={[s.ring, { width: size, height: size, borderRadius: size / 2 }]}
      accessible accessibilityLabel={`${Math.round(clamped)} percent complete`}
    >
      <View style={[s.ringInner, { width: size - 9, height: size - 9, borderRadius: (size - 9) / 2 }]}>
        <Text style={[s.ringTxt, TABULAR]}>{Math.round(clamped)}%</Text>
      </View>
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────
// `glass` is the one recipe everything reuses: translucent fill, lit rim, soft
// shadow. Spelled out once here rather than repeated per component.
// Deliberately un-annotated: `field` spreads this into a TEXT style, and typing
// it as ViewStyle would make StyleSheet.create reject fontSize/color there.
const makeStyles = (FIN: FinancePalette) => {
const glass = {
  backgroundColor: FIN.card,
  borderWidth: 1,
  borderColor: FIN.glassEdge,
  ...FIN_SHADOW.rest,
};

return StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: FIN.cardStrong,
    paddingBottom: 12, paddingHorizontal: 6,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: FIN.glassRim,
  },
  hBtn: { width: TAP, height: TAP, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, color: FIN.text, fontSize: 19, fontWeight: '800', letterSpacing: -0.3 },
  hRight: { minWidth: TAP, alignItems: 'flex-end', paddingRight: 6, flexDirection: 'row', gap: 4 },

  bodyOuter: { alignItems: 'center', width: '100%' },

  label: { color: FIN.text, fontSize: 14, fontWeight: '700', marginTop: 14, marginBottom: 6 },
  hint: { color: FIN.faint, fontSize: 12, fontWeight: '400' },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20, marginBottom: 10 },
  sectionTitle: { color: FIN.text, fontSize: 16, fontWeight: '800', letterSpacing: -0.2 },

  field: {
    ...glass,
    borderColor: FIN.border,
    borderRadius: FIN_RADIUS.sm,
    paddingHorizontal: 14, paddingVertical: 13,
    fontSize: 15, color: FIN.text,
    minHeight: TAP + 4,
  },
  fieldMulti: { height: 92, textAlignVertical: 'top' },
  fieldFocus: { borderColor: FIN.brand, backgroundColor: FIN.cardStrong },
  fieldError: { borderColor: FIN.bad, backgroundColor: FIN.badSoft },
  fieldErrTxt: { color: FIN.bad, fontSize: 12.5, fontWeight: '600', marginTop: 6 },

  dateField: {
    ...glass, borderColor: FIN.border, borderRadius: FIN_RADIUS.sm,
    flexDirection: 'row', alignItems: 'center', overflow: 'hidden', minHeight: TAP + 4,
  },
  dateTxt: { flex: 1, paddingHorizontal: 14, fontSize: 15, color: FIN.text },
  dateBtn: { backgroundColor: FIN.brandDeep, alignSelf: 'stretch', paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center' },

  segment: {
    flexDirection: 'row', backgroundColor: FIN.card2,
    borderRadius: FIN_RADIUS.sm, borderWidth: 1, borderColor: FIN.border,
    padding: 4, gap: 4,
  },
  segBtn: { flex: 1, minWidth: 0, paddingVertical: 9, borderRadius: FIN_RADIUS.xs, alignItems: 'center', justifyContent: 'center' },
  segBtnSm: { paddingVertical: 7 },
  segBtnOn: { backgroundColor: FIN.cardSolid, ...FIN_SHADOW.rest },
  segTxt: { color: FIN.sub, fontSize: 14, fontWeight: '700' },
  segTxtOn: { color: FIN.brandInk },

  radio: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: TAP },
  radioDot: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: FIN.faint, alignItems: 'center', justifyContent: 'center' },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: FIN.brand },
  radioLabel: { color: FIN.text, fontSize: 15 },

  btn: {
    flexDirection: 'row', borderRadius: FIN_RADIUS.sm,
    paddingVertical: 14, paddingHorizontal: 22, minHeight: 48,
    alignItems: 'center', justifyContent: 'center',
  },
  btnPrimary: { backgroundColor: FIN.brandDeep, ...FIN_SHADOW.brand },
  btnGhost: { backgroundColor: FIN.cardStrong, borderWidth: 1, borderColor: FIN.brand },
  btnDanger: { backgroundColor: FIN.bad },
  btnPressed: { opacity: 0.86, transform: [{ scale: 0.985 }] },
  btnOff: { opacity: 0.55 },
  btnTxt: { color: FIN.onBrand, fontSize: 15, fontWeight: '800' },

  iconBtn: {
    width: TAP, height: TAP, borderRadius: FIN_RADIUS.sm,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: FIN.card, borderWidth: 1, borderColor: FIN.glassEdge,
  },

  card: { ...glass, borderRadius: FIN_RADIUS.md, padding: 16 },
  cardRaised: { backgroundColor: FIN.cardStrong, ...FIN_SHADOW.raised },


  // `flex: 1` is load-bearing in BOTH layouts and must stay:
  //   - reports places bare StatTiles in a plain `tileRow`
  //     and rely on it to split the row evenly;
  //   - inside TileGrid the tile fills its fixed-width wrapper, which the wrap
  //     container stretches to the tallest tile on the line, so a one-line and
  //     a two-line label still produce equal-height tiles.
  tile: { ...glass, flex: 1, borderRadius: FIN_RADIUS.sm, paddingVertical: 12, paddingHorizontal: 13, minWidth: 0 },
  tileVal: { fontSize: 20, fontWeight: '800', letterSpacing: -0.5 },
  tileLbl: { color: FIN.sub, fontSize: 11.5, marginTop: 3, lineHeight: 15 },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: FIN_GAP },

  hero: { borderRadius: FIN_RADIUS.lg, padding: 20, ...FIN_SHADOW.brand },
  heroRow: { flexDirection: 'row', alignItems: 'center' },
  heroStack: { flexDirection: 'column', gap: 12 },
  heroDivider: { width: 1, alignSelf: 'stretch', backgroundColor: HERO_INK.rule, marginHorizontal: 14 },

  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: FIN_RADIUS.pill },
  pillTxt: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.3 },

  rowLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: FIN.line },
  rowKey: { color: FIN.sub, fontSize: 14, flexShrink: 1 },
  rowVal: { color: FIN.text, fontSize: 15, fontWeight: '600' },

  // width comes from ActionGrid, so no percentage here
  qa: { alignItems: 'center' },
  qaIcon: {
    ...glass,
    width: 56, height: 56, borderRadius: FIN_RADIUS.md,
    alignItems: 'center', justifyContent: 'center', marginBottom: 7,
    backgroundColor: FIN.cardStrong,
  },
  qaLbl: { color: FIN.sub, fontSize: 11.5, fontWeight: '600', textAlign: 'center', lineHeight: 15 },

  empty: { alignItems: 'center', paddingVertical: 40, gap: 6 },
  emptyIcon: {
    ...glass,
    width: 64, height: 64, borderRadius: 32,
    alignItems: 'center', justifyContent: 'center', marginBottom: 6,
  },
  emptyTitle: { color: FIN.text, fontSize: 15, fontWeight: '700' },
  emptySub: { color: FIN.sub, fontSize: 13, textAlign: 'center', paddingHorizontal: 30, lineHeight: 18 },

  ring: { backgroundColor: FIN.brand, alignItems: 'center', justifyContent: 'center' },
  ringInner: { backgroundColor: FIN.cardSolid, alignItems: 'center', justifyContent: 'center' },
  ringTxt: { fontSize: 11, fontWeight: '800', color: FIN.text },
});
};

export { FIN, FIN_GUTTER };
