// app/split-key-backup.tsx — Shamir split-key recovery for the backup passphrase.
//
// Single-passphrase backups have one point of failure: forget the passphrase and
// the backup is gone. This screen splits that passphrase into N recovery shares
// (Shamir Secret Sharing, services/crypto/shamir) where any K reconstruct it and
// any K-1 reveal nothing. The user hands shares to trusted people / stores them
// in separate places; later they gather K and recombine to recover the passphrase
// — which then unlocks Restore in Chat Backup.
//
// Pure on-device crypto; nothing here touches the network.

import { Ionicons } from '@expo/vector-icons';
import { brandAlpha } from '../constants/theme';
import { Stack, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView,
  Share, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { combineString, shareThreshold, splitString } from '../services/crypto/shamir';

type Mode = 'split' | 'recover';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function SplitKeyBackupScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('split');

  return (
    <View style={S.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={S.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title}>Split-key recovery</Text>
      </View>

      <View style={S.toggle}>
        <TouchableOpacity style={[S.toggleBtn, mode === 'split' && S.toggleOn]} onPress={() => setMode('split')}>
          <Text style={[S.toggleTxt, mode === 'split' && S.toggleTxtOn]}>Create shares</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[S.toggleBtn, mode === 'recover' && S.toggleOn]} onPress={() => setMode('recover')}>
          <Text style={[S.toggleTxt, mode === 'recover' && S.toggleTxtOn]}>Recover</Text>
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {mode === 'split' ? <SplitPane /> : <RecoverPane />}
      </KeyboardAvoidingView>
    </View>
  );
}

function SplitPane() {
  const { colors } = useTheme();
  const S = useS();
  const [passphrase, setPassphrase] = useState('');
  const [n, setN] = useState(5);
  const [k, setK] = useState(3);
  const [shares, setShares] = useState<string[] | null>(null);

  // Keep k <= n and both sane.
  const setNsafe = (v: number) => { const nn = Math.max(2, Math.min(10, v)); setN(nn); if (k > nn) setK(nn); setShares(null); };
  const setKsafe = (v: number) => { const kk = Math.max(2, Math.min(n, v)); setK(kk); setShares(null); };

  const generate = () => {
    if (passphrase.trim().length < 1) { Alert.alert('Enter a passphrase', 'Type the backup passphrase you want to protect.'); return; }
    try {
      setShares(splitString(passphrase, { n, k }));
    } catch (e: any) {
      Alert.alert('Could not split', e?.message ?? 'Try again');
    }
  };

  const copyShare = async (s: string, i: number) => {
    await Clipboard.setStringAsync(s);
    Alert.alert('Copied', `Share ${i + 1} copied. Give it to a different trusted person or store it separately.`);
  };
  const shareOne = async (s: string, i: number) => {
    try {
      await Share.share({ message: `VaultChat recovery share ${i + 1} of ${n} (need ${k} to recover):\n\n${s}` });
    } catch { /* cancelled */ }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
      <Text style={S.label}>BACKUP PASSPHRASE TO PROTECT</Text>
      <TextInput
        style={S.input}
        value={passphrase}
        onChangeText={(v) => { setPassphrase(v); setShares(null); }}
        placeholder="The passphrase you used for your encrypted backup"
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
      />

      <View style={S.row}>
        <Stepper label="Total shares (N)" value={n} onDec={() => setNsafe(n - 1)} onInc={() => setNsafe(n + 1)} S={S} />
        <Stepper label="Needed (K)" value={k} onDec={() => setKsafe(k - 1)} onInc={() => setKsafe(k + 1)} S={S} />
      </View>
      <Text style={S.hint}>Any {k} of the {n} shares can recover your passphrase. Fewer than {k} reveal nothing.</Text>

      <TouchableOpacity style={S.primaryBtn} onPress={generate} activeOpacity={0.85}>
        <Text style={S.primaryTxt}>Generate {n} shares</Text>
      </TouchableOpacity>

      {shares && (
        <View style={{ marginTop: 24, gap: 12 }}>
          <View style={S.warnBox}>
            <Text style={S.warnTxt}>
              Distribute these to {n} different people or places. Anyone who collects {k} can
              recover your passphrase — so don’t store {k}+ together. VaultChat keeps no copy.
            </Text>
          </View>
          {shares.map((s, i) => (
            <View key={i} style={S.shareCard}>
              <Text style={S.shareNum}>SHARE {i + 1} OF {n}</Text>
              <Text style={S.shareCode} selectable>{s}</Text>
              <View style={S.shareActions}>
                <TouchableOpacity style={S.smallBtn} onPress={() => copyShare(s, i)}><Text style={S.smallTxt}>Copy</Text></TouchableOpacity>
                <TouchableOpacity style={S.smallBtn} onPress={() => shareOne(s, i)}><Text style={S.smallTxt}>Share…</Text></TouchableOpacity>
              </View>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function RecoverPane() {
  const { colors } = useTheme();
  const S = useS();
  const [inputs, setInputs] = useState<string[]>(['', '']);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const setInput = (i: number, v: string) => { setInputs(prev => { const n = [...prev]; n[i] = v; return n; }); setResult(null); };
  const addField = () => setInputs(prev => [...prev, '']);

  const needed = useMemo(() => {
    const first = inputs.find(s => s.trim());
    try { return first ? shareThreshold(first) : null; } catch { return null; }
  }, [inputs]);

  const recover = async () => {
    const shares = inputs.map(s => s.trim()).filter(Boolean);
    if (shares.length < 2) { Alert.alert('Add shares', 'Enter the recovery shares you collected.'); return; }
    setBusy(true);
    try {
      const pass = combineString(shares);
      setResult(pass);
    } catch (e: any) {
      setResult(null);
      Alert.alert('Could not recover', e?.message ?? 'Check the shares and try again');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
      <Text style={S.hint}>
        Enter the recovery shares you gathered{needed ? ` — you need ${needed}` : ''}. Order doesn’t matter.
      </Text>

      {inputs.map((v, i) => (
        <View key={i}>
          <Text style={S.label}>SHARE {i + 1}</Text>
          <TextInput
            style={[S.input, { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12 }]}
            value={v}
            onChangeText={(t) => setInput(i, t)}
            placeholder="VCSS1-…"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="characters"
            autoCorrect={false}
            multiline
          />
        </View>
      ))}

      <TouchableOpacity style={S.addBtn} onPress={addField} activeOpacity={0.7}>
        <Text style={S.addTxt}>＋ Add another share</Text>
      </TouchableOpacity>

      <TouchableOpacity style={S.primaryBtn} onPress={recover} disabled={busy} activeOpacity={0.85}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={S.primaryTxt}>Recover passphrase</Text>}
      </TouchableOpacity>

      {result != null && (
        <View style={S.resultBox}>
          <Text style={S.resultLabel}>RECOVERED PASSPHRASE</Text>
          <Text style={S.resultPass} selectable>{result}</Text>
          <TouchableOpacity
            style={S.smallBtn}
            onPress={async () => { await Clipboard.setStringAsync(result); Alert.alert('Copied', 'Use it in Chat Backup → Restore.'); }}
          >
            <Text style={S.smallTxt}>Copy</Text>
          </TouchableOpacity>
          <Text style={S.resultNote}>
            If this looks wrong, you combined shares from a different backup or one was mistyped.
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

function Stepper({ label, value, onDec, onInc, S }: { label: string; value: number; onDec: () => void; onInc: () => void; S: any }) {
  return (
    <View style={S.stepper}>
      <Text style={S.stepperLabel}>{label}</Text>
      <View style={S.stepperRow}>
        <TouchableOpacity style={S.stepBtn} onPress={onDec}><Text style={S.stepBtnTxt}>−</Text></TouchableOpacity>
        <Text style={S.stepVal}>{value}</Text>
        <TouchableOpacity style={S.stepBtn} onPress={onInc}><Text style={S.stepBtnTxt}>＋</Text></TouchableOpacity>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 56, paddingBottom: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backTxt: { color: c.text, fontSize: 26, fontWeight: '600' },
  title: { color: c.text, fontSize: 22, fontWeight: '800' },

  toggle: { flexDirection: 'row', margin: 16, backgroundColor: c.card, borderRadius: 12, padding: 4, gap: 4 },
  toggleBtn: { flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: 'center' },
  toggleOn: { backgroundColor: c.primary },
  toggleTxt: { color: c.textDim, fontWeight: '700', fontSize: 14 },
  toggleTxtOn: { color: '#fff' },

  label: { color: c.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 6, marginTop: 14 },
  input: { color: c.text, backgroundColor: c.card, borderColor: c.border, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  hint: { color: c.textDim, fontSize: 12, lineHeight: 18, marginTop: 10 },

  row: { flexDirection: 'row', gap: 12, marginTop: 16 },
  stepper: { flex: 1, backgroundColor: c.card, borderColor: c.border, borderWidth: 1, borderRadius: 12, padding: 12 },
  stepperLabel: { color: c.textDim, fontSize: 11, fontWeight: '700', marginBottom: 8 },
  stepperRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stepBtn: { width: 36, height: 36, borderRadius: 10, backgroundColor: c.surfaceSolid, alignItems: 'center', justifyContent: 'center' },
  stepBtnTxt: { color: c.text, fontSize: 20, fontWeight: '700' },
  stepVal: { color: c.text, fontSize: 20, fontWeight: '800' },

  primaryBtn: { backgroundColor: c.primary, borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 22 },
  primaryTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },

  warnBox: { backgroundColor: 'rgba(245,158,11,0.1)', borderColor: 'rgba(245,158,11,0.3)', borderWidth: 1, borderRadius: 12, padding: 14 },
  warnTxt: { color: '#F59E0B', fontSize: 12, lineHeight: 18 },

  shareCard: { backgroundColor: c.card, borderColor: c.border, borderWidth: 1, borderRadius: 12, padding: 14 },
  shareNum: { color: c.primary, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 8 },
  shareCode: { color: c.text, fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', lineHeight: 18 },
  shareActions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  smallBtn: { backgroundColor: c.surfaceSolid, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 8, alignSelf: 'flex-start' },
  smallTxt: { color: c.text, fontSize: 13, fontWeight: '700' },

  addBtn: { alignItems: 'center', paddingVertical: 12, marginTop: 8 },
  addTxt: { color: c.primary, fontSize: 14, fontWeight: '700' },

  resultBox: { marginTop: 24, backgroundColor: brandAlpha(0.08), borderColor: brandAlpha(0.3), borderWidth: 1, borderRadius: 12, padding: 16, gap: 10 },
  resultLabel: { color: c.primary, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  resultPass: { color: c.text, fontSize: 18, fontWeight: '700' },
  resultNote: { color: c.textDim, fontSize: 11, lineHeight: 16 },
});
