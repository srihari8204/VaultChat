
// ================================================================
// app/duresspin.tsx — duress / decoy unlock (genuine crypto separation).
//
// Real PIN   → opens VaultChat normally.
// Duress PIN → opens the believable, persistent decoy account (/decoy-chats).
//
// Selection is cryptographic, not a flag: each PIN derives a key (scrypt) that
// authenticates exactly ONE AES-256-GCM-sealed vault header. The duress PIN
// cannot derive or open the real vault, so the real account is unreachable —
// not merely hidden. Neither PIN is ever stored. See
// services/security/duressVault.ts + vaultKeys.ts (Node-proven separation).
// ================================================================
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Animated, Platform, StyleSheet,
  Text, TouchableOpacity, Vibration, View,
} from 'react-native';
import { stealthMode } from '../lib/stealthMode';
import { isVaultSetup, setupVaults, unlockWithPin } from '../services/security/duressVault';
import { activateGhost, deactivateGhost, seedDecoyAccount } from '../lib/ghostProtocol';

// A LOCK SCREEN IS ALWAYS DARK — and every foreground on it is white.
//
// `bg` was '#FFFFFF' while the title, the keypad digits and the PIN dots are
// all #fff / white-alpha, so the entire screen rendered white-on-white: on a
// real handset you saw a blank page with a padlock emoji and nothing to tap.
// The duress PIN is the one screen that must never be unusable.
//
// Hardcoded rather than themed, deliberately, and consistent with the rest of
// the lock/call surfaces (constants/callTheme.ts): this screen must look
// identical whatever the app theme is, because it is what an attacker sees.
const C = {
  bg:'#0A0A0F', primary:'#4A9FFF',
  dim:'rgba(255,255,255,0.4)', faint:'rgba(255,255,255,0.15)',
};

export default function DuressPin() {
  const router = useRouter();
  const [entered, setEntered]   = useState('');
  const [label,   setLabel]     = useState('Enter PIN');
  const [isSetup, setIsSetup]   = useState(false);
  const [setupStep, setSetupStep] = useState<'real'|'confirm_real'|'duress'|'done'>('real');
  const [tempPin, setTempPin]   = useState('');
  const shakeAnim = useRef(new Animated.Value(0)).current;

  const KEYS = ['1','2','3','4','5','6','7','8','9','','0','⌫'];

  useEffect(() => {
    checkSetup();
  }, []);

  const checkSetup = async () => {
    const ready = await isVaultSetup();
    if (!ready) {
      setIsSetup(true);
      setLabel('Set your real PIN (6 digits)');
    }
  };

  const press = (k: string) => {
    if (k === '⌫') { setEntered(p => p.slice(0,-1)); return; }
    if (!k) return;
    const next = entered + k;
    if (next.length > 6) return;
    setEntered(next);
    if (next.length === 6) setTimeout(() => isSetup ? handleSetup(next) : verify(next), 120);
  };

  // ── First time setup flow ────────────────────────────────────
  const handleSetup = async (pin: string) => {
    if (setupStep === 'real') {
      setTempPin(pin);
      setEntered('');
      setSetupStep('confirm_real');
      setLabel('Confirm real PIN');
    } else if (setupStep === 'confirm_real') {
      if (pin !== tempPin) {
        triggerShake('PINs do not match');
        setSetupStep('real');
        setLabel('Set your real PIN (6 digits)');
        return;
      }
      // tempPin still holds the confirmed real PIN; keep it for the duress step.
      setEntered('');
      setSetupStep('duress');
      setLabel('Set duress PIN (shown to attacker)');
    } else if (setupStep === 'duress') {
      if (pin === tempPin) {
        triggerShake('Duress PIN cannot match real PIN');
        return;
      }
      // Provision two cryptographically separate vaults. Neither PIN is stored —
      // each derives a key that opens only its own AES-GCM-sealed vault header.
      await setupVaults(tempPin, pin);
      await seedDecoyAccount();
      setTempPin('');
      setEntered('');
      setIsSetup(false);
      setSetupStep('done');
      setLabel('Enter PIN');
    }
  };

  // ── Verify PIN on normal entry ───────────────────────────────
  const verify = async (pin: string) => {
    // Cryptographic selection: the entered PIN derives a key that authenticates
    // exactly one sealed vault. The duress PIN can never open the real vault.
    const res = await unlockWithPin(pin);

    if (res?.kind === 'real') {
      // ✅ Real PIN — clear any decoy/stealth state and open VaultChat.
      await deactivateGhost();
      await stealthMode.deactivate();
      router.replace('/(tabs)/chats');

    } else if (res?.kind === 'decoy') {
      // 🎭 Duress PIN — open the believable, persistent decoy account. The real
      // vault is not decryptable with this PIN, so real chats stay sealed.
      await activateGhost();
      await seedDecoyAccount();
      router.replace('/decoy-chats' as any);

    } else {
      // ❌ Unrecognised PIN
      triggerShake('Wrong PIN');
      setEntered('');
    }
  };

  const triggerShake = (msg?: string) => {
    if (Platform.OS !== 'web') Vibration.vibrate(200);
    Animated.sequence([
      Animated.timing(shakeAnim,{toValue:12, duration:60,useNativeDriver:true}),
      Animated.timing(shakeAnim,{toValue:-12,duration:60,useNativeDriver:true}),
      Animated.timing(shakeAnim,{toValue:8,  duration:60,useNativeDriver:true}),
      Animated.timing(shakeAnim,{toValue:0,  duration:60,useNativeDriver:true}),
    ]).start();
  };

  return (
    <View style={{flex:1,backgroundColor:C.bg}}>
      <LinearGradient colors={[C.bg, C.bg]} style={StyleSheet.absoluteFillObject}/>
      <View style={Ss.root}>

        {/* Icon */}
        <Text style={{fontSize:52,marginBottom:8}}>🔐</Text>
        <Text style={Ss.title}>VaultChat</Text>
        <Text style={Ss.label}>{label}</Text>

        {/* PIN dots */}
        <Animated.View style={[Ss.dots,{transform:[{translateX:shakeAnim}]}]}>
          {Array.from({length:6},(_,i) => (
            <View key={i} style={[Ss.dot, i < entered.length && Ss.dotFilled]}/>
          ))}
        </Animated.View>

        {/* Keypad */}
        <View style={Ss.keypad}>
          {KEYS.map((k,i) => (
            <TouchableOpacity
              key={i}
              onPress={() => press(k)}
              style={[Ss.key, !k && {opacity:0}]}
              disabled={!k}
              activeOpacity={0.6}>
              <Text style={Ss.keyTxt}>{k}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Setup hint */}
        {isSetup && (
          <Text style={Ss.hint}>
            {setupStep === 'real'         ? 'This PIN opens VaultChat'         :
             setupStep === 'confirm_real' ? 'Re-enter to confirm'               :
             setupStep === 'duress'       ? 'This PIN hides app (data is safe)' : ''}
          </Text>
        )}

      </View>
    </View>
  );
}

const Ss = StyleSheet.create({
  root:      {flex:1,justifyContent:'center',alignItems:'center',gap:14},
  title:     {color:'#fff',fontSize:26,fontWeight:'900'},
  label:     {color:C.dim,fontSize:13,textAlign:'center',paddingHorizontal:32},
  dots:      {flexDirection:'row',gap:18,marginVertical:12},
  dot:       {width:14,height:14,borderRadius:7,borderWidth:2,
               borderColor:'rgba(74,159,255,0.4)',backgroundColor:'transparent'},
  dotFilled: {backgroundColor:'#4A9FFF',borderColor:'#4A9FFF'},
  keypad:    {flexDirection:'row',flexWrap:'wrap',width:252,marginTop:8},
  key:       {width:84,height:84,justifyContent:'center',alignItems:'center'},
  keyTxt:    {color:'#fff',fontSize:26,fontWeight:'300'},
  hint:      {color:'rgba(74,159,255,0.6)',fontSize:11,
               textAlign:'center',paddingHorizontal:40,marginTop:4},
});
