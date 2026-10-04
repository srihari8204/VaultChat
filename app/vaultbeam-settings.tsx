// app/vaultbeam-settings.tsx — VaultBeam auto-download settings.
//
// Controls lib/vaultBeamSettings. Manual is the default (no change for existing
// users). Files ≥ 2.5 GB always require manual approval regardless of these
// settings (VB_AUTO_MAX_BYTES, enforced in the engine).

import React from 'react';
import { View, ScrollView, StyleSheet, TouchableOpacity, Switch, StatusBar, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useTheme } from '../lib/theme';
import { AppText as Text, AuroraBackground } from '../components/ui';
import { type Palette } from '../constants/theme';
import { VB_AUTODOWNLOAD } from '../constants/flags';
import {
  useVBSettings, patchSettings, SIZE_OPTIONS, type VBSettings,
} from '../lib/vaultBeamSettings';

export default function VaultBeamSettings() {
  const router = useRouter();
  const { colors, scheme } = useTheme();
  const s = useVBSettings();
  const auto = s.mode === 'auto';
  // A failed write still applies for this session; say it will not survive a
  // restart, and offer to write it again.
  const [saveFailed, setSaveFailed] = React.useState(false);
  // The change applies at once; lib/vaultBeamSettings writes to disk one
  // write after another, in order, so the newest choice is the one kept.
  const save = (p: Partial<VBSettings>) => {
    patchSettings(p).then(() => setSaveFailed(false), () => setSaveFailed(true));
  };

  const C = colors;
  const card: ViewStyle = { backgroundColor: C.glass, borderColor: C.glassStroke };
  // Mobile data always counts as metered (lib/vaultBeamAutoDownload), so
  // "Mobile data only" + "Only on unmetered networks" could never download.
  // Picking mobile data turns the unmetered rule off, and the switch is
  // disabled while it cannot apply.
  const cellular = s.network === 'cellular';

  return (
    <View style={[styles.screen, { backgroundColor: C.bg }]}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'} />
      <View style={[styles.header, { borderBottomColor: C.glassStroke }]}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={10} style={styles.hBtn}>
          <Ionicons name="arrow-back" size={22} color={C.text} />
        </TouchableOpacity>
        <Text style={[styles.hTitle, { color: C.text }]} accessibilityRole="header">VaultBeam auto-download</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        {!VB_AUTODOWNLOAD && (
          <View style={[styles.notice, { backgroundColor: C.glassSoft, borderColor: C.glassStroke }]}>
            <Ionicons name="information-circle-outline" size={16} color={C.textDim} />
            <Text style={[styles.noticeTxt, { color: C.textDim }]}>Auto-download is disabled in this build. These preferences are saved and take effect when it’s enabled.</Text>
          </View>
        )}

        {saveFailed && (
          <View style={[styles.notice, { backgroundColor: C.glassSoft, borderColor: C.danger, alignItems: 'center' }]} accessibilityLiveRegion="polite">
            <Ionicons name="alert-circle-outline" size={16} color={C.danger} />
            <Text style={[styles.noticeTxt, { color: C.text }]}>Couldn’t save your last change. It applies until the app restarts.</Text>
            {/* Writes the whole current settings again (patchSettings with no change). */}
            <TouchableOpacity onPress={() => save({})} accessibilityRole="button" accessibilityLabel="Try saving again"
              style={[styles.retryBtn, { borderColor: C.glassStroke }]}>
              <Text style={{ color: C.primary, fontWeight: '700' }}>Try again</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Mode */}
        <Section title="Mode" colors={C}>
          <Radio label="Manual approval" desc="Tap Accept for every file (current behavior)" active={s.mode === 'manual'} onPress={() => save({ mode: 'manual' })} card={card} colors={C} />
          <Radio label="Auto-download" desc="Accept eligible files automatically" active={auto} onPress={() => save({ mode: 'auto' })} card={card} colors={C} />
        </Section>

        {auto && (
          <>
            <Section title="Network" colors={C}>
              <Radio label="Wi-Fi only" active={s.network === 'wifi'} onPress={() => save({ network: 'wifi' })} card={card} colors={C} />
              <Radio label="Mobile data only" active={cellular} onPress={() => save({ network: 'cellular', unmeteredOnly: false })} card={card} colors={C} />
              <Radio label="Any network" active={s.network === 'any'} onPress={() => save({ network: 'any' })} card={card} colors={C} />
              <Toggle label="Only on unmetered networks"
                desc={cellular ? 'Not available with Mobile data only: mobile data is always metered.' : undefined}
                value={s.unmeteredOnly && !cellular} disabled={cellular}
                onValueChange={(v) => save({ unmeteredOnly: v })} card={card} colors={C} />
              {/* "Pause while roaming" is not offered: NetInfo does not expose
                  roaming, so lib/vaultBeamAutoDownload never reads the setting.
                  "Only on unmetered networks" above is the control that works. */}
            </Section>

            <Section title="Sender" colors={C}>
              <Toggle label="Trusted contacts only" desc="Only auto-download from verified contacts" value={s.trustedOnly} onValueChange={(v) => save({ trustedOnly: v })} card={card} colors={C} />
            </Section>

            <Section title="Max auto file size" colors={C}>
              {SIZE_OPTIONS.map((o) => (
                <Radio key={o.label} label={o.label} active={s.maxBytes === o.bytes} onPress={() => save({ maxBytes: o.bytes })} card={card} colors={C} />
              ))}
              <Text style={[styles.hint, { color: C.textFaint }]}>Files 2.5 GB and larger always require manual approval (up to the 12 GB limit).</Text>
            </Section>

            <Section title="Battery" colors={C}>
              <Toggle label="Only while charging" value={s.onlyCharging} onValueChange={(v) => save({ onlyCharging: v })} card={card} colors={C} />
              <Toggle label="Don't auto-download when battery is low" value={s.notLowBattery} onValueChange={(v) => save({ notLowBattery: v })} card={card} colors={C} />
            </Section>
          </>
        )}
        <View style={{ height: 30 }} />
      </ScrollView>
    </View>
  );
}

function Section({ title, children, colors }: { title: string; children: React.ReactNode; colors: Palette }) {
  return (
    <View style={{ marginTop: 20 }}>
      <Text numberOfLines={1} accessibilityRole="header" style={[styles.section, { color: colors.textDim }]}>{title.toUpperCase()}</Text>
      <View style={{ gap: 8 }}>{children}</View>
    </View>
  );
}

function Radio({ label, desc, active, onPress, card, colors }: { label: string; desc?: string; active: boolean; onPress: () => void; card: ViewStyle; colors: Palette }) {
  return (
    <TouchableOpacity style={[styles.row, card]} onPress={onPress} activeOpacity={0.8}
      accessibilityRole="radio" accessibilityLabel={desc ? `${label}. ${desc}` : label} accessibilityState={{ selected: active, checked: active }}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowLabel, { color: colors.text }]}>{label}</Text>
        {desc ? <Text style={[styles.rowDesc, { color: colors.textDim }]}>{desc}</Text> : null}
      </View>
      <Ionicons name={active ? 'radio-button-on' : 'radio-button-off'} size={22} color={active ? colors.primary : colors.textDim} />
    </TouchableOpacity>
  );
}

function Toggle({ label, desc, value, disabled, onValueChange, card, colors }: { label: string; desc?: string; value: boolean; disabled?: boolean; onValueChange: (v: boolean) => void; card: ViewStyle; colors: Palette }) {
  return (
    <View style={[styles.row, card, disabled && { opacity: 0.6 }]}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowLabel, { color: colors.text }]}>{label}</Text>
        {desc ? <Text style={[styles.rowDesc, { color: colors.textDim }]}>{desc}</Text> : null}
      </View>
      <Switch accessibilityLabel={desc ? `${label}. ${desc}` : label} value={value} disabled={disabled} onValueChange={onValueChange} trackColor={{ true: colors.primary, false: colors.border }} thumbColor={colors.onPrimary} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  // The status-bar inset comes from the navigator: this screen is in
  // INSET_SCREENS (app/_layout.tsx), which already pads it. A second 40/54
  // here put a band of empty space above the header.
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 4, paddingBottom: 12, paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  hBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  hTitle: { fontSize: 18, fontWeight: '800' },
  body: { padding: 16 },
  notice: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 4 },
  noticeTxt: { flex: 1, fontSize: 12.5, lineHeight: 18 },
  section: { fontSize: 11, fontWeight: '800', letterSpacing: 0.6, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13 },
  rowLabel: { fontSize: 14.5, fontWeight: '600' },
  rowDesc: { fontSize: 12, marginTop: 2 },
  hint: { fontSize: 11.5, lineHeight: 17, marginTop: 4, paddingHorizontal: 2 },
  retryBtn: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 10, borderWidth: 1 },
});
