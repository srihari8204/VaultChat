
// ================================================================
// app/stealth.tsx — Calculator Decoy
//
// Shown when: duress PIN entered OR threat detected
// Looks + works like a real calculator
// Data is NOT wiped — encrypted safely on device
//
// SECRET REACTIVATION GESTURE:
//   Long press the "=" button 3 times within 6 seconds
//   → Navigates to PIN screen
//   → Enter REAL PIN → VaultChat unlocks
//
// Works on Android + iOS identically
// ================================================================
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import {
  Platform, StatusBar, StyleSheet,
  Text, TouchableOpacity, Vibration, View,
} from 'react-native';

export default function StealthCalculator() {
  const router  = useRouter();
  const [display,  setDisplay]  = useState('0');
  const [prevVal,  setPrevVal]  = useState('');
  const [operator, setOperator] = useState('');
  const [newNum,   setNewNum]   = useState(false);

  // Secret gesture tracker
  const secretRef = useRef({ count: 0, lastTs: 0 });

  // ── Secret: long press "=" 3 times within 6 seconds ─────────
  const handleSecretGesture = () => {
    const now  = Date.now();
    const diff = now - secretRef.current.lastTs;

    if (diff < 6000) {
      secretRef.current.count++;
    } else {
      secretRef.current.count = 1;
    }
    secretRef.current.lastTs = now;

    // Haptic feedback on each press (subtle)
    if (Platform.OS === 'android') Vibration.vibrate(30);

    if (secretRef.current.count >= 3) {
      secretRef.current.count = 0;
      // Navigate to real PIN screen
      router.replace('/duresspin');
    }
  };

  // ── Calculator logic ─────────────────────────────────────────
  const pressNum = (n: string) => {
    if (newNum) {
      setDisplay(n);
      setNewNum(false);
    } else {
      setDisplay(d => d === '0' ? n : d.length < 12 ? d + n : d);
    }
  };

  const pressDot = () => {
    if (newNum) { setDisplay('0.'); setNewNum(false); return; }
    if (!display.includes('.')) setDisplay(d => d + '.');
  };

  const pressOp = (op: string) => {
    setPrevVal(display);
    setOperator(op);
    setNewNum(true);
  };

  const pressEquals = () => {
    if (!operator || !prevVal) return;
    const a = parseFloat(prevVal);
    const b = parseFloat(display);
    let result: number;
    switch (operator) {
      case '+': result = a + b; break;
      case '−': result = a - b; break;
      case '×': result = a * b; break;
      case '÷': result = b !== 0 ? a / b : 0; break;
      default:  result = b;
    }
    const resultStr = Number.isInteger(result)
      ? String(result)
      : parseFloat(result.toFixed(9)).toString();
    setDisplay(resultStr.length > 12 ? result.toExponential(4) : resultStr);
    setOperator('');
    setPrevVal('');
    setNewNum(true);
  };

  const pressPercent = () => {
    setDisplay(d => String(parseFloat(d) / 100));
  };

  const pressPlusMinus = () => {
    setDisplay(d => d.startsWith('-') ? d.slice(1) : d === '0' ? d : '-' + d);
  };

  const pressAC = () => {
    setDisplay('0');
    setPrevVal('');
    setOperator('');
    setNewNum(false);
  };

  const isOp = (k: string) => ['÷','×','−','+'].includes(k);

  // ── Layout identical to iOS Calculator ───────────────────────
  const ROWS = [
    ['AC','+/-','%','÷'],
    ['7','8','9','×'],
    ['4','5','6','−'],
    ['1','2','3','+'],
    ['0','.','='],
  ];

  const handleKey = (k: string) => {
    if (k === 'AC')  pressAC();
    else if (k === '+/-') pressPlusMinus();
    else if (k === '%')   pressPercent();
    else if (k === '=')   pressEquals();
    else if (k === '.')   pressDot();
    else if (isOp(k))     pressOp(k);
    else                  pressNum(k);
  };

  return (
    <View style={Ss.root}>
      <StatusBar barStyle="light-content" backgroundColor="#1C1C1E"/>

      {/* Display */}
      <View style={Ss.display}>
        <Text style={Ss.displayTxt} numberOfLines={1} adjustsFontSizeToFit>
          {display}
        </Text>
      </View>

      {/* Buttons */}
      <View style={Ss.grid}>
        {ROWS.map((row, ri) => (
          <View key={ri} style={Ss.row}>
            {row.map((k, ki) => {
              const isEq  = k === '=';
              const isOpK = isOp(k);
              const isGray= ['AC','+/-','%'].includes(k);
              const isZero= k === '0';
              return (
                <TouchableOpacity
                  key={ki}
                  onPress={() => handleKey(k)}
                  onLongPress={isEq ? handleSecretGesture : undefined}
                  delayLongPress={600}
                  activeOpacity={0.7}
                  style={[
                    Ss.btn,
                    isOpK && Ss.btnOp,
                    isGray && Ss.btnGray,
                    isEq   && Ss.btnOp,
                    isZero && Ss.btnZero,
                    operator === k && Ss.btnOpActive,
                  ]}>
                  <Text style={[
                    Ss.btnTxt,
                    isGray && Ss.btnTxtGray,
                  ]}>
                    {k}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
      </View>
    </View>
  );
}

const BTN = 78;

const Ss = StyleSheet.create({
  root:       {flex:1,backgroundColor:'#000',justifyContent:'flex-end',
               paddingBottom: Platform.OS === 'ios' ? 34 : 16},
  display:    {paddingHorizontal:24,paddingBottom:12,alignItems:'flex-end'},
  displayTxt: {color:'#fff',fontSize:72,fontWeight:'200',minWidth:60},
  grid:       {paddingHorizontal:16,gap:12},
  row:        {flexDirection:'row',justifyContent:'space-between'},
  btn:        {width:BTN,height:BTN,borderRadius:BTN/2,
               backgroundColor:'#D1D5DB',justifyContent:'center',alignItems:'center'},
  btnOp:      {backgroundColor:'#FF9F0A'},
  btnOpActive:{backgroundColor:'#fff'},
  btnGray:    {backgroundColor:'#A5A5A5'},
  btnZero:    {width:BTN*2+16,alignItems:'flex-start',paddingLeft:28},
  btnTxt:     {color:'#fff',fontSize:32,fontWeight:'400'},
  btnTxtGray: {color:'#000'},
});
