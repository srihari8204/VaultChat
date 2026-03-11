import { CAMERA_AVAILABLE, isExpoGo } from '../lib/compat';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, Easing, StyleSheet, Text, View } from 'react-native';

const { width: SW, height: SH } = Dimensions.get('window');
const CX = SW / 2;
const CY = SH * 0.42;

// Face mesh node positions (relative to CX/CY)
const REGIONS = [
  {
    id: 'face', color: '#4A9FFF', label: 'FACE CONTOUR', delay: 0,
    pts: [[-72,-110],[-90,-70],[-98,-22],[-95,30],[-85,80],[-60,118],[-30,138],[0,144],[30,138],[60,118],[85,80],[95,30],[98,-22],[90,-70],[72,-110],[50,-128],[20,-136],[0,-138],[-20,-136],[-50,-128]],
  },
  {
    id: 'leye', color: '#00EEFF', label: 'LEFT EYE', delay: 220,
    pts: [[-58,-42],[-46,-52],[-30,-54],[-16,-50],[-14,-42],[-16,-34],[-30,-30],[-46,-34]],
  },
  {
    id: 'reye', color: '#00EEFF', label: 'RIGHT EYE', delay: 280,
    pts: [[58,-42],[46,-52],[30,-54],[16,-50],[14,-42],[16,-34],[30,-30],[46,-34]],
  },
  {
    id: 'lbrow', color: '#A855F7', label: 'LEFT BROW', delay: 440,
    pts: [[-70,-68],[-58,-74],[-44,-76],[-30,-74],[-18,-68]],
  },
  {
    id: 'rbrow', color: '#A855F7', label: 'RIGHT BROW', delay: 500,
    pts: [[70,-68],[58,-74],[44,-76],[30,-74],[18,-68]],
  },
  {
    id: 'nose', color: '#FACC15', label: 'NOSE', delay: 640,
    pts: [[0,-38],[0,-22],[0,-6],[-14,4],[-8,10],[0,12],[8,10],[14,4]],
  },
  {
    id: 'mouth', color: '#F87171', label: 'MOUTH', delay: 860,
    pts: [[-32,48],[-20,42],[-8,40],[0,42],[8,40],[20,42],[32,48],[20,52],[0,54],[-20,52],[-28,56],[0,64],[28,56]],
  },
  {
    id: 'cheeks', color: '#34D399', label: 'CHEEKS', delay: 1060,
    pts: [[-68,20],[-74,40],[-70,60],[68,20],[74,40],[70,60]],
  },
];

const STATUS_STEPS = [
  { t: 0,    txt: 'Initialising biometric engine...' },
  { t: 200,  txt: 'Face geometry detected' },
  { t: 440,  txt: 'Mapping eye structures...' },
  { t: 640,  txt: 'Capturing brow topology...' },
  { t: 840,  txt: 'Nose landmark analysis...' },
  { t: 1060, txt: 'Lip contour extraction...' },
  { t: 1260, txt: 'Finalising mesh — 133 pts' },
  { t: 1500, txt: 'Biometric identity confirmed ✓' },
];

export default function FaceScanScreen() {
  const router = useRouter();
  const [visibleRegions, setVisibleRegions] = useState({});
  const [status, setStatus]   = useState(STATUS_STEPS[0].txt);
  const [phase, setPhase]     = useState(0);
  const [ptCount, setPtCount] = useState(0);

  const fadeAnim    = useRef(new Animated.Value(0)).current;
  const scanLine    = useRef(new Animated.Value(0)).current;
  const pulseAnim   = useRef(new Animated.Value(1)).current;
  const glowAnim    = useRef(new Animated.Value(0)).current;
  const successAnim = useRef(new Animated.Value(0)).current;
  const timers      = useRef([]);

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: true }).start();

    Animated.loop(Animated.timing(scanLine, {
      toValue: 1, duration: 1200, easing: Easing.inOut(Easing.ease), useNativeDriver: false,
    })).start();

    Animated.loop(Animated.sequence([
      Animated.timing(glowAnim,  { toValue: 1, duration: 1800, useNativeDriver: false }),
      Animated.timing(glowAnim,  { toValue: 0, duration: 1800, useNativeDriver: false }),
    ])).start();

    Animated.loop(Animated.sequence([
      Animated.timing(pulseAnim, { toValue: 1.05, duration: 1400, useNativeDriver: true }),
      Animated.timing(pulseAnim, { toValue: 1,    duration: 1400, useNativeDriver: true }),
    ])).start();

    REGIONS.forEach(r => {
      timers.current.push(setTimeout(() => {
        setVisibleRegions(prev => ({ ...prev, [r.id]: true }));
        setPtCount(c => c + r.pts.length);
      }, r.delay));
    });

    STATUS_STEPS.forEach(s => {
      timers.current.push(setTimeout(() => setStatus(s.txt), s.t));
    });

    timers.current.push(setTimeout(() => {
      setPhase(1);
      Animated.spring(successAnim, { toValue: 1, tension: 55, friction: 8, useNativeDriver: true }).start();
      setTimeout(() => router.replace('/chats'), 900);
    }, 1600));

    return () => timers.current.forEach(clearTimeout);
  }, []);

  const scanY = scanLine.interpolate({ inputRange: [0, 1], outputRange: [CY - 140, CY + 150] });
  const isOK  = phase === 1;

  const BADGES = [
    { lbl: 'EYES',   color: '#00EEFF', done: visibleRegions.leye },
    { lbl: 'BROWS',  color: '#A855F7', done: visibleRegions.lbrow },
    { lbl: 'NOSE',   color: '#FACC15', done: visibleRegions.nose },
    { lbl: 'MOUTH',  color: '#F87171', done: visibleRegions.mouth },
    { lbl: 'CHEEKS', color: '#34D399', done: visibleRegions.cheeks },
  ];

  return (
    <View style={S.root}>
      <LinearGradient colors={['#010812', '#030E1E', '#010812']} style={StyleSheet.absoluteFillObject} />

      {/* Background grid dots */}
      {Array.from({ length: 80 }).map((_, i) => (
        <View key={i} style={{
          position: 'absolute',
          left: (i % 10) * (SW / 10) + 6,
          top:  Math.floor(i / 10) * 90 + 8,
          width: 1.5, height: 1.5, borderRadius: 1,
          backgroundColor: `rgba(74,159,255,${0.04 + (i % 3) * 0.02})`,
        }} />
      ))}

      {/* Ambient glow */}
      <Animated.View style={{
        position: 'absolute', alignSelf: 'center', top: CY - 160,
        width: 320, height: 320, borderRadius: 160,
        backgroundColor: glowAnim.interpolate({ inputRange: [0,1], outputRange: ['rgba(74,159,255,0.04)','rgba(74,159,255,0.13)'] }),
      }} />

      {/* Concentric reference rings */}
      {[160, 148, 136].map((r, i) => (
        <View key={i} style={{
          position: 'absolute', left: CX - r, top: CY - r,
          width: r * 2, height: r * 2, borderRadius: r,
          borderWidth: 0.8, borderColor: `rgba(74,159,255,${0.05 + i * 0.03})`,
          borderStyle: 'solid',
        }} />
      ))}

      <Animated.View style={{ flex: 1, opacity: fadeAnim }}>

        {/* Header */}
        <View style={S.header}>
          <Text style={S.hTitle}>Biometric Authentication</Text>
          <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: isOK ? '#10B981' : '#4A9FFF' }} />
            <Text style={S.hSub}>{isOK ? 'IDENTITY CONFIRMED' : 'SCANNING FACE MESH'}</Text>
          </View>
        </View>

        {/* Mesh dots — all regions */}
        {REGIONS.map(r => visibleRegions[r.id] && r.pts.map((p, i) => {
          const dotSize = r.id === 'leye' || r.id === 'reye' || r.id === 'mouth' ? 5 : r.id === 'face' ? 3 : 4;
          return (
            <View key={r.id + i} style={{
              position: 'absolute',
              left: CX + p[0] - dotSize / 2,
              top:  CY + p[1] - dotSize / 2,
              width: dotSize, height: dotSize, borderRadius: dotSize / 2,
              backgroundColor: r.color,
              opacity: 0.92,
              zIndex: 10,
            }} />
          );
        }))}

        {/* Mesh connection lines between consecutive face outline pts */}
        {visibleRegions.face && REGIONS[0].pts.map((p, i) => {
          const next = REGIONS[0].pts[(i + 1) % REGIONS[0].pts.length];
          const x1 = CX + p[0], y1 = CY + p[1];
          const x2 = CX + next[0], y2 = CY + next[1];
          const len = Math.sqrt((x2-x1)**2 + (y2-y1)**2);
          const angle = Math.atan2(y2-y1, x2-x1) * 180 / Math.PI;
          return (
            <View key={'fl'+i} style={{
              position: 'absolute', left: x1, top: y1 - 0.6,
              width: len, height: 1.2,
              backgroundColor: 'rgba(74,159,255,0.35)',
              transform: [{ rotate: angle + 'deg' }, { translateX: 0 }],
              transformOrigin: 'left center',
              zIndex: 5,
            }} />
          );
        })}

        {/* Eye contour lines */}
        {['leye','reye'].map(id => {
          const region = REGIONS.find(r=>r.id===id);
          if (!visibleRegions[id]) return null;
          return region.pts.map((p, i) => {
            const next = region.pts[(i + 1) % region.pts.length];
            const x1 = CX+p[0], y1 = CY+p[1], x2 = CX+next[0], y2 = CY+next[1];
            const len = Math.sqrt((x2-x1)**2+(y2-y1)**2);
            const angle = Math.atan2(y2-y1,x2-x1)*180/Math.PI;
            return (
              <View key={id+'l'+i} style={{
                position:'absolute', left:x1, top:y1-0.5,
                width:len, height:1, backgroundColor:'rgba(0,238,255,0.55)',
                transform:[{rotate:angle+'deg'}], transformOrigin:'left center', zIndex:5,
              }}/>
            );
          });
        })}

        {/* Cross-axis lines */}
        <View style={{ position: 'absolute', left: CX - 130, top: CY - 0.4, width: 260, height: 0.8, backgroundColor: 'rgba(74,159,255,0.1)' }} />
        <View style={{ position: 'absolute', left: CX - 0.4, top: CY - 145, width: 0.8, height: 295, backgroundColor: 'rgba(74,159,255,0.1)' }} />
        <View style={{ position: 'absolute', left: CX - 4, top: CY - 4, width: 8, height: 8, borderRadius: 4, backgroundColor: 'rgba(74,159,255,0.3)' }} />

        {/* Success checkmark ring */}
        {isOK && (
          <Animated.View style={{
            position: 'absolute', left: CX - 68, top: CY - 68,
            width: 136, height: 136, borderRadius: 68,
            borderWidth: 2, borderColor: '#10B981',
            backgroundColor: 'rgba(16,185,129,0.1)',
            justifyContent: 'center', alignItems: 'center',
            transform: [{ scale: successAnim }], zIndex: 20,
          }}>
            <Text style={{ color: '#10B981', fontSize: 52, fontWeight: '900' }}>✓</Text>
          </Animated.View>
        )}

        {/* Scan line */}
        {!isOK && (
          <Animated.View style={[S.scanLine, { top: scanY }]} />
        )}

        {/* Corner brackets */}
        {[
          { top: CY - 148, left: CX - 140 },
          { top: CY - 148, left: CX + 112, scaleX: -1 },
          { top: CY + 122, left: CX - 140, scaleY: -1 },
          { top: CY + 122, left: CX + 112, scaleX: -1, scaleY: -1 },
        ].map(({ scaleX=1, scaleY=1, ...pos }, i) => (
          <View key={i} style={[S.bracket, pos, { transform: [{ scaleX }, { scaleY }] }]}>
            <View style={[S.bH, isOK && { backgroundColor: '#10B981' }]} />
            <View style={[S.bV, isOK && { backgroundColor: '#10B981' }]} />
          </View>
        ))}

        {/* Spacer to push stats down */}
        <View style={{ flex: 1 }} />

        {/* Feature badges */}
        <View style={S.badgesRow}>
          {BADGES.map((b, i) => (
            <View key={i} style={[S.badge, b.done && { borderColor: b.color + '55', backgroundColor: b.color + '10' }]}>
              <View style={[S.badgeDot, { backgroundColor: b.done ? b.color : 'rgba(255,255,255,0.12)' }]} />
              <Text style={[S.badgeLbl, { color: b.done ? b.color : 'rgba(255,255,255,0.2)' }]}>{b.lbl}</Text>
            </View>
          ))}
        </View>

        {/* Stats row */}
        <View style={S.statsRow}>
          {[
            { lbl: 'LANDMARKS', val: ptCount > 0 ? ptCount.toString() : '--',           color: ptCount >= 80 ? '#10B981' : '#4A9FFF' },
            { lbl: 'CONFIDENCE', val: isOK ? '99.8%' : ptCount > 30 ? `${Math.min(99, 55 + ptCount).toFixed(0)}%` : '--', color: '#A855F7' },
            { lbl: 'DEEPFAKE',   val: ptCount > 30 ? 'REAL' : 'SCAN',                  color: ptCount > 30 ? '#10B981' : '#F59E0B' },
          ].map((s, i) => (
            <View key={i} style={S.statCard}>
              <Text style={S.statLabel}>{s.lbl}</Text>
              <Text style={[S.statVal, { color: s.color }]}>{s.val}</Text>
            </View>
          ))}
        </View>

        {/* Status */}
        <View style={S.statusRow}>
          <View style={[S.statusDot, { backgroundColor: isOK ? '#10B981' : '#4A9FFF' }]} />
          <Text style={S.statusTxt}>{status}</Text>
        </View>

      </Animated.View>
    </View>
  );
}

const S = StyleSheet.create({
  root:      { flex: 1, backgroundColor: '#010812' },
  header:    { paddingTop: 52, paddingBottom: 10, alignItems: 'center', gap: 5 },
  hTitle:    { color: '#fff', fontSize: 17, fontWeight: '900', letterSpacing: 0.3 },
  hSub:      { color: 'rgba(74,159,255,0.65)', fontSize: 9, fontWeight: '700', letterSpacing: 2.5 },
  scanLine:  { position: 'absolute', left: CX - 140, width: 280, height: 1.5, backgroundColor: '#4A9FFF', opacity: 0.7 },
  bracket:   { position: 'absolute', width: 28, height: 28, zIndex: 20 },
  bH:        { position: 'absolute', top: 0, left: 0, width: 28, height: 3, backgroundColor: '#4A9FFF', borderRadius: 2 },
  bV:        { position: 'absolute', top: 0, left: 0, width: 3, height: 28, backgroundColor: '#4A9FFF', borderRadius: 2 },
  badgesRow: { flexDirection: 'row', paddingHorizontal: 20, gap: 7, marginBottom: 12 },
  badge:     { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(10,22,40,0.8)', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 7, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },
  badgeDot:  { width: 5, height: 5, borderRadius: 2.5 },
  badgeLbl:  { fontSize: 8, fontWeight: '800', letterSpacing: 0.5 },
  statsRow:  { flexDirection: 'row', paddingHorizontal: 20, gap: 10, marginBottom: 10 },
  statCard:  { flex: 1, backgroundColor: 'rgba(10,22,40,0.85)', borderRadius: 14, padding: 11, alignItems: 'center', gap: 3, borderWidth: 1, borderColor: 'rgba(74,159,255,0.1)' },
  statLabel: { color: 'rgba(255,255,255,0.3)', fontSize: 7, fontWeight: '800', letterSpacing: 1 },
  statVal:   { fontSize: 14, fontWeight: '900' },
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingBottom: 40 },
  statusDot: { width: 7, height: 7, borderRadius: 3.5 },
  statusTxt: { color: 'rgba(255,255,255,0.4)', fontSize: 12 },
});
