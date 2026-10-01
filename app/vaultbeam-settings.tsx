// app/vaultbeam-settings.tsx — VaultBeam auto-download settings.
//
// Controls lib/vaultBeamSettings. Manual is the default (no change for existing
// users). Files ≥ 2.5 GB always require manual approval regardless of these
// settings (VB_AUTO_MAX_BYTES, enforced in the engine).

import React from 'react';
import { View, ScrollView, StyleSheet, TouchableOpacity, Switch, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useTheme } from '../lib/theme';
import { AppText as Text, AuroraBackground } from '../components/ui';
import { BRAND_ACCENT } from '../constants/theme';
import { VB_AUTODOWNLOAD } from '../constants/flags';
import {
  useVBSettings, patchSettings, SIZE_OPTIONS,
  type VBMode, type VBNetwork,
} from '../lib/vaultBeamSettings';

export default function VaultBeamSettings() {
  const router = useRouter();
  const { colors } = useTheme();   // scheme went with the StatusBar removed below
  const s = useVBSettings();
  const auto = s.mode === 'auto';

  const C = colors as any;
  const card = { backgroundColor: C.glass, borderColor: C.glassStroke };

  return (
    <View style={[styles.screen, { backgroundColor: C.bg }]}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      {/* No <StatusBar> here. It used to be
              barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'}
          which is the SAME decision app/_layout.tsx:883 already makes from the
          same `scheme` — one theme-aware owner, and this was a second copy of it.
          Duplicating it buys nothing and is a place for the two to disagree.
          A screen may still own the bar when its surface is dark at EVERY theme
          (a call, the camera, a media or story viewer) or when it goes immersive;
          this screen follows the palette, so the root bar decides. */}
      <View style={[styles.header, { borderBottomColor: C.glassStroke }]}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={10} style={styles.hBtn}>
          <Ionicons name="arrow-back" size={22} color={C.text} />
        </TouchableOpacity>
        <Text style={[styles.hTitle, { color: C.text }]}>VaultBeam auto-download</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        {!VB_AUTODOWNLOAD && (
          <View style={[styles.notice, { backgroundColor: C.glassSoft, borderColor: C.glassStroke }]}>
            <Ionicons name="information-circle-outline" size={16} color={C.textDim} />
            <Text style={[styles.noticeTxt, { color: C.textDim }]}>Auto-download is disabled in this build. These preferences are saved and take effect when it’s enabled.</Text>
          </View>
        )}

        {/* Mode */}
        <Section title="Mode" colors={C}>
          <Radio label="Manual approval" desc="Tap Accept for every file (current behavior)" active={s.mode === 'manual'} onPress={() => patchSettings({ mode: 'manual' as VBMode })} card={card} colors={C} />
          <Radio label="Auto-download" desc="Accept eligible files automatically" active={auto} onPress={() => patchSettings({ mode: 'auto' as VBMode })} card={card} colors={C} />
        </Section>

        {auto && (
          <>
            <Section title="Network" colors={C}>
              <Radio label="Wi-Fi only" active={s.network === 'wifi'} onPress={() => patchSettings({ network: 'wifi' as VBNetwork })} card={card} colors={C} />
              <Radio label="Mobile data only" active={s.network === 'cellular'} onPress={() => patchSettings({ network: 'cellular' as VBNetwork })} card={card} colors={C} />
              <Radio label="Any network" active={s.network === 'any'} onPress={() => patchSettings({ network: 'any' as VBNetwork })} card={card} colors={C} />
              <Toggle label="Only on unmetered networks" value={s.unmeteredOnly} onValueChange={(v) => patchSettings({ unmeteredOnly: v })} card={card} colors={C} />
              <Toggle label="Pause auto-downloads while roaming" value={s.pauseRoaming} onValueChange={(v) => patchSettings({ pauseRoaming: v })} card={card} colors={C} />
            </Section>

            <Section title="Sender" colors={C}>
              <Toggle label="Trusted contacts only" desc="Only auto-download from verified contacts" value={s.trustedOnly} onValueChange={(v) => patchSettings({ trustedOnly: v })} card={card} colors={C} />
            </Section>

            <Section title="Max auto file size" colors={C}>
              {SIZE_OPTIONS.map((o) => (
                <Radio key={o.label} label={o.label} active={s.maxBytes === o.bytes} onPress={() => patchSettings({ maxBytes: o.bytes })} card={card} colors={C} />
              ))}
              <Text style={[styles.hint, { color: C.textFaint ?? C.textDim }]}>Files 2.5 GB and larger always require manual approval (up to the 12 GB limit).</Text>
            </Section>

            <Section title="Battery" colors={C}>
              <Toggle label="Only while charging" value={s.onlyCharging} onValueChange={(v) => patchSettings({ onlyCharging: v })} card={card} colors={C} />
              <Toggle label="Don't auto-download when battery is low" value={s.notLowBattery} onValueChange={(v) => patchSettings({ notLowBattery: v })} card={card} colors={C} />
            </Section>
          </>
        )}
        <View style={{ height: 30 }} />
      </ScrollView>
    </View>
  );
}

function Section({ title, children, colors }: { title: string; children: React.ReactNode; colors: any }) {
  return (
    <View style={{ marginTop: 20 }}>
      <Text numberOfLines={1} style={[styles.section, { color: colors.textDim }]}>{title.toUpperCase()}</Text>
      <View style={{ gap: 8 }}>{children}</View>
    </View>
  );
}

function Radio({ label, desc, active, onPress, card, colors }: { label: string; desc?: string; active: boolean; onPress: () => void; card: any; colors: any }) {
  return (
    <TouchableOpacity style={[styles.row, card]} onPress={onPress} activeOpacity={0.8}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowLabel, { color: colors.text }]}>{label}</Text>
        {desc ? <Text style={[styles.rowDesc, { color: colors.textDim }]}>{desc}</Text> : null}
      </View>
      <Ionicons name={active ? 'radio-button-on' : 'radio-button-off'} size={22} color={active ? BRAND_ACCENT : colors.textDim} />
    </TouchableOpacity>
  );
}

function Toggle({ label, desc, value, onValueChange, card, colors }: { label: string; desc?: string; value: boolean; onValueChange: (v: boolean) => void; card: any; colors: any }) {
  return (
    <View style={[styles.row, card]}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowLabel, { color: colors.text }]}>{label}</Text>
        {desc ? <Text style={[styles.rowDesc, { color: colors.textDim }]}>{desc}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onValueChange} trackColor={{ true: BRAND_ACCENT }} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: Platform.OS === 'ios' ? 54 : 40, paddingBottom: 12, paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth },
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
});
