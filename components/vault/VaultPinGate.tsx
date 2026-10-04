// components/vault/VaultPinGate.tsx — app/vault.tsx's Device PIN gate and its
// back button (moved out of the screen file; behaviour unchanged). The PIN is
// checked by services/security/pinStore, which also runs the brute-force
// backoff; the screen gets the verified PIN through onUnlock.

import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, TouchableOpacity, View, Vibration } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { AppText as Text } from '../ui/Text';
import { AuroraBackground } from '../ui';
import { PinPad } from '../PinPad';
import * as pinStore from '../../services/security/pinStore';
import { isPinFormat, PIN_MAX, PIN_MIN } from '../../services/security/pinFormat';
import { useColors } from '../../lib/theme';
import { HEADER_TOP } from '../../constants/layout';
import { makePinStyles } from './vaultStyles';

export function PinGate({ onUnlock }: { onUnlock: (pin: string) => Promise<void> }) {
  const c = useColors();
  const router = useRouter();
  const pinStyles = useMemo(() => makePinStyles(c), [c]);
  const [pin,   setPin]   = useState('');
  const [error, setError] = useState('');
  const [busy,  setBusy]  = useState(false);
  // null = not checked yet. Re-checked on focus, so returning from Device PIN
  // setup shows the keypad without leaving the screen.
  const [havePin, setHavePin] = useState<boolean | null>(null);
  useFocusEffect(useCallback(() => {
    let live = true;
    pinStore.hasPin().then(h => { if (live) setHavePin(h); }).catch(() => { if (live) setHavePin(true); });
    return () => { live = false; };
  }, []));

  const submit = async (v: string) => {
    if (busy) return;
    if (!isPinFormat(v)) { setError(`Enter your ${PIN_MIN}–${PIN_MAX} digit Device PIN.`); return; }
    setBusy(true);
    try {
      // pinStore verifies against the scrypt record (and migrates a legacy value
      // on first success) — the PIN is no longer readable to compare against.
      if (await pinStore.verifyPin(v)) { await onUnlock(v); return; }
      // verifyPin also answers false while a brute-force backoff is running;
      // "Incorrect PIN" would then be a lie the user cannot act on.
      const wait = await pinStore.pinBackoffMs();
      Vibration.vibrate([0, 100, 100, 100]);
      setError(wait > 0
        ? `Too many attempts. Try again in ${Math.ceil(wait / 1000)} s.`
        : 'Incorrect PIN. Try again.');
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  if (havePin === false) {
    return (
      <View style={pinStyles.container}>
        <AuroraBackground />
        <BackButton onPress={() => router.back()} color={c.primary} />
        <Ionicons name="lock-closed" size={52} color={c.primary} style={pinStyles.lockIcon} importantForAccessibility="no" accessibilityElementsHidden />
        <Text style={pinStyles.title} accessibilityRole="header">Vault</Text>
        <Text style={[pinStyles.sub, { textAlign: 'center', paddingHorizontal: 32 }]}>
          The vault opens with your Device PIN, and this phone does not have one yet.
        </Text>
        <TouchableOpacity
          style={pinStyles.setBtn}
          onPress={() => router.push('/backup-pin?from=settings')}
          accessibilityRole="button"
          accessibilityLabel="Set a Device PIN"
        >
          <Text style={pinStyles.setBtnText}>Set a Device PIN</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={pinStyles.container}>
      <AuroraBackground />
      <BackButton onPress={() => router.back()} color={c.primary} />
      <Ionicons name="lock-closed" size={52} color={c.primary} style={pinStyles.lockIcon} importantForAccessibility="no" accessibilityElementsHidden />
      <Text style={pinStyles.title} accessibilityRole="header">Vault</Text>
      <Text style={pinStyles.sub} accessibilityLabel="Enter your Device PIN, then tap Done">Enter your Device PIN, then tap ✓</Text>

      <PinPad
        value={pin}
        onChange={(v) => { setPin(v); setError(''); }}
        length={PIN_MAX}
        minLength={PIN_MIN}
        onSubmit={submit}
        onComplete={submit}
        error={!!error}
      />

      {busy ? <ActivityIndicator color={c.primary} style={{ marginTop: 8 }} /> : null}
      {error ? <Text style={pinStyles.error} accessibilityLiveRegion="polite">{error}</Text> : null}

      <Text style={pinStyles.note}>
        Files are AES-256-GCM encrypted
      </Text>
    </View>
  );
}

function BackButton({ onPress, color }: { onPress: () => void; color: string }) {
  return (
    <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={onPress} hitSlop={8}
      style={{ position: 'absolute', top: HEADER_TOP, left: 12, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name="arrow-back" size={26} color={color} />
    </TouchableOpacity>
  );
}
