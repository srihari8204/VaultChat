// components/settings/SettingsParts.tsx — rows, the Appearance picker and the
// stylesheet of app/settings.tsx (moved out of the screen unchanged).

import React, { useMemo } from 'react';
import { ActivityIndicator, StyleSheet, Switch, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, type ThemePref } from '../../lib/theme';
import { type Palette } from '../../constants/theme';
import { AppText as Text } from '../ui';

/** Memoized themed stylesheet for this screen. */
export function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

// WhatsApp-style settings row: tinted leading icon, title + sub, chevron.
export function LinkRow({ icon, title, sub, onPress, busy, last }: {
  icon: React.ComponentProps<typeof Ionicons>['name']; title: string; sub?: string;
  onPress?: () => void; busy?: boolean; last?: boolean;
}) {
  const { colors } = useTheme();
  const S = useS();
  return (
    <TouchableOpacity style={[S.linkRow, last && { borderBottomWidth: 0 }]} onPress={onPress} activeOpacity={0.7} disabled={busy}
      accessibilityRole="button" accessibilityLabel={sub ? `${title}. ${sub}` : title} accessibilityState={{ disabled: !!busy, busy: !!busy }}>
      <View style={S.linkIconWrap}><Ionicons name={icon} size={22} color={colors.text} /></View>
      <View style={{ flex: 1 }}>
        <Text style={S.linkTitle}>{title}</Text>
        {sub ? <Text style={S.linkSub}>{sub}</Text> : null}
      </View>
      {busy ? <ActivityIndicator color={colors.primary} /> : <Ionicons name="chevron-forward" size={18} color={colors.textDim} />}
    </TouchableOpacity>
  );
}

// Appearance (U3) — Light / Dark / System, persisted via the ThemeProvider.
// The control itself is theme-aware so the chosen palette previews live.
export function AppearanceSection() {
  const { pref, setPref, colors, scheme } = useTheme();
  const S = useS();
  const opts: { key: ThemePref; label: string; icon: React.ComponentProps<typeof Ionicons>['name'] }[] = [
    { key: 'system', label: 'System', icon: 'phone-portrait-outline' },
    { key: 'light',  label: 'Light',  icon: 'sunny-outline' },
    { key: 'dark',   label: 'Dark',   icon: 'moon-outline' },
  ];
  return (
    <View style={S.section}>
      <Text style={S.label}>APPEARANCE</Text>
      <View style={[apS.row, { backgroundColor: colors.glass, borderColor: colors.glassStroke }]}>
        {opts.map(o => {
          const active = pref === o.key;
          return (
            <TouchableOpacity
              key={o.key}
              style={[apS.pill, active && { backgroundColor: colors.primary }]}
              onPress={() => setPref(o.key)}
              activeOpacity={0.8}
              accessibilityRole="radio"
              accessibilityLabel={`Appearance: ${o.label}`}
              accessibilityState={{ selected: active, checked: active }}
            >
              <Ionicons name={o.icon} size={16} color={active ? colors.onPrimary : colors.textDim} />
              <Text style={[apS.pillTxt, { color: active ? colors.onPrimary : colors.textDim }]}>{o.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={[apS.hint, { color: colors.textDim }]}>
        {pref === 'system' ? `Following your device (currently ${scheme}).` : `Always ${pref}.`}
      </Text>
    </View>
  );
}

const apS = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', borderRadius: 14, borderWidth: 1, padding: 4, gap: 4, marginTop: 4 },
  pill: { flexGrow: 1, minWidth: 120, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 11 },
  pillTxt: { fontSize: 13, fontWeight: '700' },
  hint: { fontSize: 11.5, marginTop: 8, lineHeight: 16 },
});

export function ToggleRow({
  title, sub, value, busy, onValueChange,
}: {
  title:         string;
  sub:           string;
  value:         boolean;
  // Optional: most toggles are instant. A row that has no async work to do
  // should not have to pass `busy={false}` to say so.
  busy?:         boolean;
  // Takes the NEW value. A `() => void` handler is still assignable, so every
  // existing caller keeps working; the ones that need the value can now read it
  // instead of inferring it from the state they are about to change.
  onValueChange: (value: boolean) => void;
}) {
  const { colors } = useTheme();
  const S = useS();
  return (
    <View style={S.toggleRow}>
      <View style={{ flex: 1 }}>
        <Text style={S.toggleTitle}>{title}</Text>
        <Text style={S.toggleSub}>{sub}</Text>
      </View>
      {busy ? (
        <ActivityIndicator color={colors.primary} style={{ marginLeft: 8 }} />
      ) : (
        <Switch
          accessibilityLabel={title}
          value={value}
          onValueChange={onValueChange}
          trackColor={{ true: colors.primary, false: colors.border }}
          thumbColor={colors.onPrimary}
        />
      )}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  center:        { justifyContent: 'center', alignItems: 'center' },

  // The status-bar inset comes from the navigator (INSET_SCREENS in
  // app/_layout.tsx), which pads the SCREEN — so scrolled rows clip at the
  // inset instead of sliding under the clock. This is just the header's gap.
  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 4, paddingBottom: 12, gap: 8 },
  backBtn:       { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title:         { color: c.text, fontSize: 22, fontWeight: '800' },

  // Profile card
  profileCard:   { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginTop: 4, padding: 14, borderRadius: 16, backgroundColor: c.glassSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  profileMain:   { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 14 },
  qrBtn:         { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  profileAvatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  profileAvatarImg: { width: '100%', height: '100%' },
  profileAvatarTxt: { color: c.onPrimary, fontSize: 22, fontWeight: '800' },
  profileName:   { color: c.text, fontSize: 17, fontWeight: '700' },
  profileSub:    { color: c.textDim, fontSize: 13, marginTop: 2 },

  // Icon-led link rows (grouped card)
  linkCard:      { backgroundColor: c.glassSoft, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke, overflow: 'hidden' },
  linkRow:       { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 14, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  linkIconWrap:  { width: 30, alignItems: 'center', justifyContent: 'center' },
  linkTitle:     { color: c.text, fontSize: 15, fontWeight: '600' },
  linkSub:       { color: c.textDim, fontSize: 12, marginTop: 1 },

  section:       { paddingHorizontal: 16, marginTop: 16 },
  label:         { color: c.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 },

  toggleRow:     { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  prefRow:       { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  toggleTitle:   { color: c.text, fontSize: 15, fontWeight: '600' },
  toggleSub:     { color: c.textDim, fontSize: 12, lineHeight: 16, marginTop: 2 },

  blockRow:      { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  blockAvatar:   { width: 40, height: 40, borderRadius: 20, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  blockAvatarImg:{ width: '100%', height: '100%' },
  blockAvatarTxt:{ color: c.onPrimary, fontWeight: '700' },
  blockName:     { color: c.text, fontSize: 15, fontWeight: '600' },
  blockEmail:    { color: c.textDim, fontSize: 12, marginTop: 2 },
  unblockBtn:    { minHeight: 44, minWidth: 88, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, borderRadius: 22, borderWidth: 1, borderColor: c.danger },
  unblockTxt:    { color: c.danger, fontSize: 12, fontWeight: '700' },

  emptySub:      { color: c.textDim, fontSize: 13, lineHeight: 18, paddingVertical: 16 },

  // Load failure
  errorBox:      { alignItems: 'center', paddingHorizontal: 32, gap: 6 },
  errorTitle:    { color: c.text, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  errorSub:      { color: c.textDim, fontSize: 13, lineHeight: 18, textAlign: 'center' },
  errorActions:  { flexDirection: 'row', gap: 12, marginTop: 12 },
  errorBtn:      { minHeight: 44, paddingHorizontal: 16, justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: c.glassStroke, backgroundColor: c.glassSoft },
  errorBtnTxt:   { color: c.primary, fontWeight: '700' },
  blocksError:   { flexDirection: 'row', alignItems: 'center', gap: 12 },

  // Data & account section
  deleteBtn:     { marginTop: 16, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: c.danger, alignItems: 'center' },
  deleteBtnTxt:  { color: c.danger, fontWeight: '700' },
});
