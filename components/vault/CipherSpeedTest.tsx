// components/vault/CipherSpeedTest.tsx — "Test encryption speed" (Vault Features).
//
// Seals a few MiB in memory with the cipher this build uses for vault files
// (lib/vaultCipherSpeed), and, when that is the native one, a smaller run with
// the JS fallback for comparison. It is the only way to read the phone's own
// number; nothing is written to disk and no file is touched.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, TouchableOpacity, View } from 'react-native';
import { AppText as Text } from '../ui/Text';
import { useTheme } from '../../lib/theme';
import type { Palette } from '../../constants/theme';
import { formatMbPerSec, measureSealSpeed, type SealSpeed } from '../../lib/vaultCipherSpeed';
import { chunkCipher, jsChunkCipher, VaultCancelledError } from '../../lib/vaultCrypto';

const NATIVE_MIB = 16;
const JS_MIB = 2;

type Result = { inUse: SealSpeed; js: SealSpeed | null };

export function speedSummary(r: Result): string {
  const used = r.inUse.cipher === 'native'
    ? `Native AES-256-GCM: ${formatMbPerSec(r.inUse.mbPerSec)}`
    : `JavaScript AES-256-GCM (native module not available): ${formatMbPerSec(r.inUse.mbPerSec)}`;
  return r.js ? `${used}. JavaScript fallback: ${formatMbPerSec(r.js.mbPerSec)}.` : `${used}.`;
}

export function CipherSpeedTest() {
  const { colors: c } = useTheme();
  const s = useMemo(() => makeStyles(c), [c]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [failed, setFailed] = useState(false);
  const gone = useRef(false);
  useEffect(() => () => { gone.current = true; }, []);
  // A ref, not `busy`: two taps in one frame would both pass a state check.
  const running = useRef(false);

  const run = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true); setFailed(false); setResult(null);
    const cancelled = () => gone.current;
    try {
      // The JS cipher holds the JS thread for each chunk, so it gets a short run.
      const inUse = await measureSealSpeed(chunkCipher().name === 'native' ? NATIVE_MIB : JS_MIB, { cancelled });
      const js = inUse.cipher === 'native' ? await measureSealSpeed(JS_MIB, { cipher: jsChunkCipher, cancelled }) : null;
      if (!gone.current) setResult({ inUse, js });
    } catch (e: unknown) {
      if (!(e instanceof VaultCancelledError) && !gone.current) setFailed(true);
    } finally {
      running.current = false;
      if (!gone.current) setBusy(false);
    }
  };

  return (
    <View>
      <TouchableOpacity style={[s.btn, busy && s.btnDim]} onPress={run} disabled={busy}
        accessibilityRole="button" accessibilityLabel="Test encryption speed"
        accessibilityHint="Encrypts a few megabytes in memory and shows how fast this phone does it"
        accessibilityState={{ disabled: busy, busy }}>
        {busy ? <ActivityIndicator size="small" color={c.primary} /> : <Text style={s.btnText}>Test encryption speed</Text>}
      </TouchableOpacity>
      <View accessibilityLiveRegion="polite">
        {busy && <Text style={s.note}>Testing… this takes a few seconds.</Text>}
        {result && <Text style={s.result}>{speedSummary(result)}</Text>}
        {failed && <Text style={s.error} accessibilityRole="alert">The test could not run. Try again.</Text>}
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  btn: {
    minHeight: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: c.glassStroke, backgroundColor: c.surfaceSolid, paddingHorizontal: 14,
  },
  btnDim:  { opacity: 0.6 },
  btnText: { color: c.primary, fontWeight: '700', fontSize: 14 },
  note:    { marginTop: 10, fontSize: 12, color: c.textDim },
  result:  { marginTop: 10, fontSize: 13, color: c.text, lineHeight: 19 },
  error:   { marginTop: 10, fontSize: 12, color: c.danger },
});
