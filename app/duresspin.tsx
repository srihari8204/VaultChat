
// ================================================================
// app/duresspin.tsx
// Real PIN  → VaultChat opens normally
// Duress PIN → Stealth mode activates, Calculator shown
//              Data is NOT wiped — hidden + encrypted only
//
// Compliant with:
//   Android: Google Play policy (no hidden functionality harm)
//   iOS:     App Store guideline 2.5.4 (no background processes harm)
//
// SECRET REACTIVATION:
//   Long press "=" button 3 times on Calculator
//   → Returns to this PIN screen
//   → Enter REAL PIN → VaultChat unlocks
// ================================================================
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Animated, Platform, StyleSheet,
  Text, TouchableOpacity, Vibration, View,
} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { stealthMode } from '../lib/stealthMode';

const REAL_PIN_KEY   = 'vaultRealPin';
const DURESS_PIN_KEY = 'vaultDuressPin';

const C = {
  bg:'#010812', primary:'#4A9FFF',
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
    const realPin = await SecureStore.getItemAsync(REAL_PIN_KEY);
    if (!realPin) {
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
      await SecureStore.setItemAsync(REAL_PIN_KEY, pin);
      setEntered('');
      setSetupStep('duress');
      setLabel('Set duress PIN (shown to attacker)');
    } else if (setupStep === 'duress') {
      const realPin = await SecureStore.getItemAsync(REAL_PIN_KEY);
      if (pin === realPin) {
        triggerShake('Duress PIN cannot match real PIN');
        return;
      }
      await SecureStore.setItemAsync(DURESS_PIN_KEY, pin);
      setEntered('');
      setIsSetup(false);
      setSetupStep('done');
      setLabel('Enter PIN');
    }
  };

  // ── Verify PIN on normal entry ───────────────────────────────
  const verify = async (pin: string) => {
    const realPin   = await SecureStore.getItemAsync(REAL_PIN_KEY);
    const duressPin = await SecureStore.getItemAsync(DURESS_PIN_KEY);

    if (pin === realPin) {
      // ✅ Real PIN — open VaultChat normally
      await stealthMode.deactivate();
      router.replace('/chats');

    } else if (pin === duressPin) {
      // 🔮 Duress PIN — activate stealth, show calculator
      // Data stays safe and encrypted — NOT wiped
      await stealthMode.activate('Duress PIN entered');
      router.replace('/stealth');

    } else {
      // ❌ Wrong PIN
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
      <LinearGradient colors={['#010812','#020B18']} style={StyleSheet.absoluteFillObject}/>
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
