/**
 * app/facescan.tsx — DEMO VERSION
 * No camera. No native modules. Pure UI simulation.
 * Works in Expo Go and dev client instantly.
 */

import React, { useRef, useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  Animated, Dimensions, Platform, StatusBar,
} from 'react-native';
import Svg, { Circle, Line, Ellipse } from 'react-native-svg';
import { router } from 'expo-router';

const C = {
  bg: '#060E1E', panel: '#0D1F3C', cyan: '#00E5FF',
  cyan2: '#00B4D8', green: '#00FF9D', coral: '#FF4D6D',
  white: '#FFFFFF', muted: '#7BA7C4', dark: '#030A14',
};
const { width: SW } = Dimensions.get('window');
const TOP = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 44;

const PHASE = { INTRO: 'INTRO', SCANNING: 'SCANNING', CONFIRMED: 'CONFIRMED' } as const;
type P = typeof PHASE[keyof typeof PHASE];

// ── 3D Mesh ───────────────────────────────────────────────────────────────────
const MW = SW * 0.72, MH = MW * 1.24;
function buildGrid() {
  const g: { x: number; y: number }[][] = [];
  for (let r = 0; r <= 10; r++) {
    const t = r / 10, tp = t > 0.68 ? Math.max(1 - (t - 0.68) * 2.4, 0.04) : 1;
    const row: { x: number; y: number }[] = [];
    for (let c = 0; c <= 10; c++) {
      const a = Math.PI + (c / 10) * Math.PI;
      row.push({ x: MW / 2 + MW * 0.36 * tp * Math.cos(a), y: MH * 0.44 - MH * 0.46 + t * MH * 0.92 });
    }
    g.push(row);
  }
  return g;
}
const GRID = buildGrid();

function FaceMesh({ anim }: { anim: Animated.Value }) {
  const [op, setOp] = useState(0);
  useEffect(() => {
    const id = anim.addListener(({ value }) => setOp(value));
    return () => anim.removeListener(id);
  }, [anim]);
  return (
    <Svg width={MW} height={MH}>
      <Ellipse cx={MW / 2} cy={MH * 0.44} rx={MW * 0.38} ry={MH * 0.47}
        stroke={C.cyan} strokeWidth={1.5} strokeOpacity={0.6 * op} fill="none" />
      {GRID.map((row, r) => row.slice(0, -1).map((pt, c) => (
        <Line key={`h${r}${c}`} x1={pt.x} y1={pt.y} x2={row[c + 1].x} y2={row[c + 1].y}
          stroke={C.cyan} strokeWidth={0.9} strokeOpacity={0.45 * op} />
      )))}
      {GRID.slice(0, -1).map((row, r) => row.map((pt, c) => (
        <Line key={`v${r}${c}`} x1={pt.x} y1={pt.y} x2={GRID[r + 1][c].x} y2={GRID[r + 1][c].y}
          stroke={C.cyan} strokeWidth={0.9} strokeOpacity={0.45 * op} />
      )))}
      {GRID.map((row, r) => row.map((pt, c) => (
        <Circle key={`d${r}${c}`} cx={pt.x} cy={pt.y} r={2.4}
          fill={C.cyan} fillOpacity={0.95 * op} />
      )))}
    </Svg>
  );
}

function Brackets({ color, pulse }: { color: string; pulse: Animated.Value }) {
  const sz = SW * 0.64;
  const corners = [
    { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3 },
    { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3 },
    { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3 },
    { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3 },
  ];
  return (
    <View style={{ width: sz, height: sz * 1.28, position: 'relative' }}>
      {corners.map((c, i) => (
        <Animated.View key={i} style={[{
          position: 'absolute', width: 34, height: 34,
          borderColor: color, borderStyle: 'solid', opacity: pulse,
        }, c]} />
      ))}
    </View>
  );
}

function Arc({ pct }: { pct: number }) {
  const r = 40, circ = 2 * Math.PI * r, p = Math.min(pct, 1);
  return (
    <Svg width={96} height={96} style={{ position: 'absolute', top: -8, left: -8 }}>
      <Circle cx={48} cy={48} r={r} stroke="#0D1F3C" strokeWidth={5} fill="none" />
      <Circle cx={48} cy={48} r={r}
        stroke={p >= 1 ? C.green : C.cyan} strokeWidth={5} fill="none"
        strokeDasharray={`${circ * p} ${circ * (1 - p)}`}
        strokeDashoffset={circ * 0.25} strokeLinecap="round" />
    </Svg>
  );
}

function ScanLine() {
  const y = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(Animated.sequence([
      Animated.timing(y, { toValue: SW * 0.7, duration: 1800, useNativeDriver: true }),
      Animated.timing(y, { toValue: 0, duration: 1800, useNativeDriver: true }),
    ])).start();
  }, [y]);
  return (
    <Animated.View pointerEvents="none"
      style={{ position: 'absolute', left: SW * 0.18, right: SW * 0.18, top: SW * 0.12, transform: [{ translateY: y }] }}>
      <View style={{ height: 2, backgroundColor: 'rgba(0,229,255,0.55)', borderRadius: 1 }} />
    </Animated.View>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function FaceScanScreen() {
  const [phase, setPhase] = useState<P>(PHASE.SCANNING);
  const [pct, setPct] = useState(0);
  const [hint, setHint] = useState('Centre your face in the frame');

  const fadeIn  = useRef(new Animated.Value(0)).current;
  const pulse   = useRef(new Animated.Value(1)).current;
  const meshA   = useRef(new Animated.Value(0)).current;
  const okOp    = useRef(new Animated.Value(0)).current;
  const okSc    = useRef(new Animated.Value(0.88)).current;
  const pctRef  = useRef(0);
  const timer   = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    const doStartScan = () => {
      pctRef.current = 0;
      setPct(0);
      setPhase(PHASE.SCANNING);
      timer.current = setInterval(() => {
        pctRef.current = Math.min(pctRef.current + 0.05, 1);
        setPct(pctRef.current);
        if (pctRef.current >= 1) {
          clearInterval(timer.current!);
          setTimeout(() => {
            setPhase(PHASE.CONFIRMED);
            Animated.parallel([
              Animated.timing(meshA,  { toValue: 1, duration: 1400, useNativeDriver: false }),
              Animated.spring(okOp,   { toValue: 1, tension: 40, friction: 8, useNativeDriver: true }),
              Animated.spring(okSc,   { toValue: 1, tension: 40, friction: 8, useNativeDriver: true }),
            ]).start();
          }, 600);
        }
      }, 30);
    };
    doStartScan();
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [fadeIn, meshA, okOp, okSc]);

  useEffect(() => {
    if (phase !== PHASE.SCANNING) return;
    const lp = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 0.3, duration: 850, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1.0, duration: 850, useNativeDriver: true }),
    ]));
    lp.start();
    return () => lp.stop();
  }, [phase, pulse]);

  useEffect(() => {
    if (pct < 0.01)      setHint('Centre your face in the frame');
    else if (pct < 0.35) setHint('Hold still — scanning…');
    else if (pct < 0.75) setHint('Almost there…');
    else if (pct < 1)    setHint('Keep still…');
    else                 setHint('Face scan complete!');
  }, [pct]);

  const startScan = () => {
    pctRef.current = 0;
    setPct(0);
    setPhase(PHASE.SCANNING);
    timer.current = setInterval(() => {
      pctRef.current = Math.min(pctRef.current + 0.05, 1);
      setPct(pctRef.current);
      if (pctRef.current >= 1) {
        clearInterval(timer.current!);
        setTimeout(() => {
          setPhase(PHASE.CONFIRMED);
          Animated.parallel([
            Animated.timing(meshA,  { toValue: 1, duration: 1400, useNativeDriver: false }),
            Animated.spring(okOp,   { toValue: 1, tension: 40, friction: 8, useNativeDriver: true }),
            Animated.spring(okSc,   { toValue: 1, tension: 40, friction: 8, useNativeDriver: true }),
          ]).start();
        }, 600);
      }
    }, 30);
  };

  const reset = () => {
    if (timer.current) clearInterval(timer.current);
    pctRef.current = 0; setPct(0);
    meshA.setValue(0); okOp.setValue(0); okSc.setValue(0.88);
    setPhase(PHASE.INTRO);
  };

  // ── INTRO ─────────────────────────────────────────────────────────────────
  if (phase === PHASE.INTRO) return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <Animated.View style={[s.center, { opacity: fadeIn }]}>
        <Text style={s.label}>V A U L T C H A T</Text>
        <Text style={s.title}>Face ID{'\n'}Setup</Text>
        <Text style={s.sub}>Offline face scan + device biometric.{'\n'}No cloud. No API.</Text>
        {[
          { n: '01', t: 'Look at camera',          d: 'Face scan captures your geometry' },
          { n: '02', t: 'Phone confirms identity',  d: 'Uses your device biometric chip'  },
          { n: '03', t: 'Stored on device',         d: 'Never uploaded anywhere'           },
        ].map(st => (
          <View key={st.n} style={s.card}>
            <View style={s.badge}><Text style={s.bnum}>{st.n}</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={s.ctitle}>{st.t}</Text>
              <Text style={s.csub}>{st.d}</Text>
            </View>
          </View>
        ))}
        <TouchableOpacity style={s.btn} onPress={startScan} activeOpacity={0.82}>
          <Text style={s.btxt}>Begin Face Scan</Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );

  // ── SCANNING ──────────────────────────────────────────────────────────────
  if (phase === PHASE.SCANNING) return (
    <View style={{ flex: 1, backgroundColor: '#080f1c' }}>
      <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />

      {/* Fake face oval */}
      <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]} pointerEvents="none">
        <View style={{ width: SW * 0.48, height: SW * 0.62, borderRadius: SW * 0.26, borderWidth: 1, borderColor: 'rgba(0,229,255,0.12)' }} />
      </View>

      <ScanLine />

      <View style={s.topOv} pointerEvents="none" />
      <View style={s.topBar} pointerEvents="none">
        <Text style={s.labelSm}>V A U L T C H A T</Text>
        <Text style={s.camT}>Scanning Your Face…</Text>
      </View>

      <View style={[StyleSheet.absoluteFill, s.bwrap]} pointerEvents="none">
        <Brackets color={pct > 0.5 ? C.cyan : C.cyan2} pulse={pulse} />
      </View>

      <View style={s.ringWrap} pointerEvents="none">
        <Arc pct={pct} />
        <Text style={[s.ringT, pct >= 1 && { color: C.green }]}>{Math.round(pct * 100)}%</Text>
      </View>

      <View style={s.hintWrap} pointerEvents="none">
        <View style={s.hintPill}><Text style={s.hintT}>{hint}</Text></View>
      </View>
    </View>
  );

  // ── CONFIRMED ─────────────────────────────────────────────────────────────
  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <Animated.View style={[s.center, { opacity: okOp, transform: [{ scale: okSc }] }]}>
        <Text style={s.label}>V A U L T C H A T</Text>
        <Text style={s.title}>Face ID{'\n'}Registered</Text>
        <View style={{ marginVertical: 14 }}><FaceMesh anim={meshA} /></View>
        <Text style={s.ok}>✓  Secured with device biometrics</Text>
        <TouchableOpacity style={[s.btn, { backgroundColor: C.green }]}
          onPress={() => router.replace('/chats')} activeOpacity={0.82}>
          <Text style={[s.btxt, { color: C.dark }]}>Open VaultChat</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.btn, { backgroundColor: C.panel, marginTop: 10 }]}
          onPress={reset} activeOpacity={0.82}>
          <Text style={[s.btxt, { color: C.muted }]}>Scan Again</Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  root:     { flex: 1, backgroundColor: C.bg, paddingTop: TOP },
  center:   { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  label:    { fontSize: 11, letterSpacing: 7, color: C.cyan, marginBottom: 6, fontWeight: '600' },
  labelSm:  { fontSize: 10, letterSpacing: 5, color: C.cyan, fontWeight: '500', marginBottom: 3 },
  title:    { fontSize: 40, fontWeight: '800', color: C.white, textAlign: 'center', lineHeight: 48, marginBottom: 10 },
  sub:      { fontSize: 14, color: C.muted, textAlign: 'center', lineHeight: 22, marginBottom: 24 },
  ok:       { fontSize: 15, fontWeight: '600', color: C.green, marginBottom: 22 },
  card:     { flexDirection: 'row', alignItems: 'flex-start', width: '100%', backgroundColor: C.panel, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#0E2A48', marginBottom: 10 },
  badge:    { width: 32, height: 32, borderRadius: 16, backgroundColor: C.cyan2, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  bnum:     { fontSize: 10, fontWeight: '800', color: C.dark },
  ctitle:   { fontSize: 13, fontWeight: '700', color: C.white, marginBottom: 2 },
  csub:     { fontSize: 11, color: C.muted },
  btn:      { marginTop: 8, backgroundColor: C.cyan, paddingVertical: 15, borderRadius: 13, width: '100%', alignItems: 'center' },
  btxt:     { fontSize: 16, fontWeight: '700', color: C.dark },
  topOv:    { position: 'absolute', top: 0, left: 0, right: 0, height: 155, backgroundColor: 'rgba(6,14,30,0.68)' },
  topBar:   { position: 'absolute', top: TOP + 10, left: 0, right: 0, alignItems: 'center' },
  camT:     { fontSize: 20, fontWeight: '700', color: C.white },
  bwrap:    { alignItems: 'center', justifyContent: 'center' },
  ringWrap: { position: 'absolute', bottom: 155, alignSelf: 'center', width: 80, height: 80, alignItems: 'center', justifyContent: 'center' },
  ringT:    { fontSize: 17, fontWeight: '800', color: C.cyan },
  hintWrap: { position: 'absolute', bottom: 88, left: 0, right: 0, alignItems: 'center' },
  hintPill: { backgroundColor: 'rgba(6,14,30,0.82)', paddingHorizontal: 20, paddingVertical: 9, borderRadius: 22, borderWidth: 1, borderColor: 'rgba(0,229,255,0.20)' },
  hintT:    { fontSize: 14, fontWeight: '600', color: C.white },
});
