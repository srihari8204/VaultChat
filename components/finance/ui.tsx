// components/finance/ui.tsx — shared UI primitives for the Vault Finance hub.
//
// One set of themed building blocks so every finance screen looks the same and
// screen files stay small. All colors come from constants/financeTheme.

import React from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, StatusBar, Platform,
  type ViewStyle, type TextStyle, type KeyboardTypeOptions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { FIN } from '../../constants/financeTheme';

type IconName = keyof typeof Ionicons.glyphMap;

// ── Screen chrome ───────────────────────────────────────────────────
export function FinHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  const router = useRouter();
  return (
    <View style={s.header}>
      <StatusBar barStyle="dark-content" backgroundColor={FIN.card} />
      <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={s.hBtn}>
        <Ionicons name="arrow-back" size={22} color={FIN.text} />
      </TouchableOpacity>
      <Text style={s.headerTitle} numberOfLines={1}>{title}</Text>
      <View style={s.hRight}>{right}</View>
    </View>
  );
}

export function Label({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return <Text style={s.label}>{children}{hint ? <Text style={s.hint}>  {hint}</Text> : null}</Text>;
}

export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <View style={s.sectionRow}>
      <Text style={s.sectionTitle}>{children}</Text>
      {action}
    </View>
  );
}

// ── Inputs ──────────────────────────────────────────────────────────
export function Field(props: {
  value: string; onChangeText: (t: string) => void; placeholder?: string;
  keyboardType?: KeyboardTypeOptions; multiline?: boolean; style?: ViewStyle | TextStyle | (ViewStyle | TextStyle)[];
}) {
  const { style, multiline, ...rest } = props;
  return (
    <TextInput
      {...rest}
      multiline={multiline}
      placeholderTextColor={FIN.faint}
      style={[s.field, multiline && s.fieldMulti, style as any]}
    />
  );
}

export function DateField({ value, onPress }: { value: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={s.dateField} onPress={onPress} activeOpacity={0.85}>
      <Text style={[s.dateTxt, !value && { color: FIN.faint }]}>{value || 'dd/mm/yyyy'}</Text>
      <View style={s.dateBtn}><Ionicons name="calendar" size={18} color="#fff" /></View>
    </TouchableOpacity>
  );
}

export function Segment<T extends string>({ options, value, onChange, small }: {
  options: { k: T; label: string }[]; value: T; onChange: (k: T) => void; small?: boolean;
}) {
  return (
    <View style={s.segment}>
      {options.map(o => {
        const active = value === o.k;
        return (
          <TouchableOpacity key={o.k} style={[s.segBtn, small && s.segBtnSm, active && s.segBtnOn]} onPress={() => onChange(o.k)} activeOpacity={0.85}>
            <Text style={[s.segTxt, small && { fontSize: 12 }, active && { color: '#fff' }]}>{o.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export function Radio({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={s.radio} onPress={onPress} activeOpacity={0.85}>
      <View style={[s.radioDot, active && { borderColor: FIN.brand }]}>{active && <View style={s.radioInner} />}</View>
      <Text style={[s.radioLabel, active && { color: FIN.brandDeep, fontWeight: '700' }]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ── Buttons ─────────────────────────────────────────────────────────
export function Btn({ label, onPress, kind = 'primary', icon, wide, style }: {
  label: string; onPress: () => void; kind?: 'primary' | 'ghost' | 'danger';
  icon?: IconName; wide?: boolean; style?: ViewStyle;
}) {
  const ghost = kind === 'ghost';
  return (
    <TouchableOpacity
      style={[s.btn, wide && { flex: 1 }, ghost ? s.btnGhost : kind === 'danger' ? s.btnDanger : s.btnPrimary, style]}
      onPress={onPress} activeOpacity={0.88}
    >
      {icon && <Ionicons name={icon} size={16} color={ghost ? FIN.brandDeep : '#fff'} style={{ marginRight: 6 }} />}
      <Text style={[s.btnTxt, ghost && { color: FIN.brandDeep }]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ── Cards / tiles ───────────────────────────────────────────────────
export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function StatTile({ value, label, tone = 'plain' }: {
  value: string; label: string; tone?: 'plain' | 'good' | 'bad' | 'warn' | 'info' | 'brand';
}) {
  const c = tone === 'good' ? FIN.good : tone === 'bad' ? FIN.bad : tone === 'warn' ? FIN.warn
    : tone === 'info' ? FIN.info : tone === 'brand' ? FIN.brandDeep : FIN.text;
  return (
    <View style={s.tile}>
      <Text style={[s.tileVal, { color: c }]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      <Text style={s.tileLbl} numberOfLines={1}>{label}</Text>
    </View>
  );
}

export function HeroCard({ children, colors }: { children: React.ReactNode; colors?: [string, string] }) {
  return (
    <LinearGradient colors={colors ?? [FIN.brandDeep, FIN.brand]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.hero}>
      {children}
    </LinearGradient>
  );
}

export function Pill({ label, fg, bg }: { label: string; fg: string; bg: string }) {
  return <View style={[s.pill, { backgroundColor: bg }]}><Text style={[s.pillTxt, { color: fg }]}>{label}</Text></View>;
}

export function RowLine({ k, v, bold, tone }: { k: string; v: string; bold?: boolean; tone?: 'good' | 'bad' | 'warn' }) {
  const c = tone === 'good' ? FIN.good : tone === 'bad' ? FIN.bad : tone === 'warn' ? FIN.warn : FIN.text;
  return (
    <View style={s.rowLine}>
      <Text style={s.rowKey}>{k}</Text>
      <Text style={[s.rowVal, bold && { fontWeight: '800' }, { color: c }]}>{v}</Text>
    </View>
  );
}

export function QuickAction({ icon, label, onPress, colors }: {
  icon: IconName; label: string; onPress: () => void; colors?: [string, string];
}) {
  return (
    <TouchableOpacity style={s.qa} onPress={onPress} activeOpacity={0.85}>
      <LinearGradient colors={colors ?? [FIN.brand, FIN.brandDeep]} style={s.qaIcon}>
        <Ionicons name={icon} size={20} color="#fff" />
      </LinearGradient>
      <Text style={s.qaLbl} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

export function EmptyState({ icon, title, sub }: { icon: IconName; title: string; sub?: string }) {
  return (
    <View style={s.empty}>
      <View style={s.emptyIcon}><Ionicons name={icon} size={26} color={FIN.faint} /></View>
      <Text style={s.emptyTitle}>{title}</Text>
      {sub ? <Text style={s.emptySub}>{sub}</Text> : null}
    </View>
  );
}

/** CSS-free progress ring using two arcs. */
export function ProgressRing({ pct, size = 44 }: { pct: number; size?: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <View style={[s.ring, { width: size, height: size, borderRadius: size / 2 }]}>
      <View style={[s.ringInner, { width: size - 10, height: size - 10, borderRadius: (size - 10) / 2 }]}>
        <Text style={s.ringTxt}>{Math.round(clamped)}%</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: FIN.card,
    paddingTop: Platform.OS === 'ios' ? 54 : 40, paddingBottom: 12, paddingHorizontal: 6,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: FIN.border,
  },
  hBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, color: FIN.text, fontSize: 19, fontWeight: '800' },
  hRight: { minWidth: 40, alignItems: 'flex-end', paddingRight: 6, flexDirection: 'row', gap: 4 },

  label: { color: FIN.text, fontSize: 14, fontWeight: '700', marginTop: 14, marginBottom: 6 },
  hint: { color: FIN.faint, fontSize: 12, fontWeight: '400' },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20, marginBottom: 10 },
  sectionTitle: { color: FIN.text, fontSize: 16, fontWeight: '800' },

  field: { backgroundColor: FIN.card, borderWidth: 1, borderColor: FIN.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, fontSize: 15, color: FIN.text },
  fieldMulti: { height: 88, textAlignVertical: 'top' },

  dateField: { flexDirection: 'row', alignItems: 'center', backgroundColor: FIN.card, borderWidth: 1, borderColor: FIN.border, borderRadius: 10, overflow: 'hidden' },
  dateTxt: { flex: 1, paddingHorizontal: 12, fontSize: 15, color: FIN.text },
  dateBtn: { backgroundColor: FIN.brandDeep, paddingVertical: 13, paddingHorizontal: 22, alignItems: 'center', justifyContent: 'center' },

  segment: { flexDirection: 'row', backgroundColor: FIN.card, borderRadius: 10, borderWidth: 1, borderColor: FIN.border, overflow: 'hidden' },
  segBtn: { flex: 1, paddingVertical: 11, alignItems: 'center', justifyContent: 'center' },
  segBtnSm: { paddingVertical: 8 },
  segBtnOn: { backgroundColor: FIN.brand },
  segTxt: { color: FIN.sub, fontSize: 14, fontWeight: '700' },

  radio: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  radioDot: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: FIN.faint, alignItems: 'center', justifyContent: 'center' },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: FIN.brand },
  radioLabel: { color: FIN.text, fontSize: 15 },

  btn: { flexDirection: 'row', borderRadius: 10, paddingVertical: 13, paddingHorizontal: 22, alignItems: 'center', justifyContent: 'center' },
  btnPrimary: { backgroundColor: FIN.brandDeep },
  btnGhost: { backgroundColor: FIN.brandSoft, borderWidth: 1, borderColor: FIN.brand },
  btnDanger: { backgroundColor: FIN.bad },
  btnTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },

  card: { backgroundColor: FIN.card, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: FIN.border },
  tile: { flex: 1, backgroundColor: FIN.card, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 12, borderWidth: 1, borderColor: FIN.border, minWidth: 0 },
  tileVal: { fontSize: 20, fontWeight: '800', letterSpacing: -0.4 },
  tileLbl: { color: FIN.sub, fontSize: 11.5, marginTop: 3 },

  hero: { borderRadius: 16, padding: 18 },

  pill: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999 },
  pillTxt: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.2 },

  rowLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: FIN.line },
  rowKey: { color: FIN.sub, fontSize: 14 },
  rowVal: { color: FIN.text, fontSize: 15, fontWeight: '600' },

  qa: { alignItems: 'center', width: '22%' },
  qaIcon: { width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  qaLbl: { color: FIN.sub, fontSize: 11, fontWeight: '600', textAlign: 'center' },

  empty: { alignItems: 'center', paddingVertical: 40, gap: 6 },
  emptyIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: FIN.card2, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  emptyTitle: { color: FIN.text, fontSize: 15, fontWeight: '700' },
  emptySub: { color: FIN.sub, fontSize: 13, textAlign: 'center', paddingHorizontal: 30 },

  ring: { backgroundColor: FIN.brand, alignItems: 'center', justifyContent: 'center' },
  ringInner: { backgroundColor: FIN.card, alignItems: 'center', justifyContent: 'center' },
  ringTxt: { fontSize: 11, fontWeight: '800', color: FIN.text },
});

export { FIN };
