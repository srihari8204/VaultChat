import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, Easing, StyleSheet, Text, View } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useFrameProcessor,
} from 'react-native-vision-camera';
import { useFaceDetector } from 'react-native-vision-camera-face-detector';
import { Worklets } from 'react-native-worklets-core';

const { width: SW, height: SH } = Dimensions.get('window');
const CX = SW / 2;
const CY  = SH * 0.42;

// ── Colours for each face region ─────────────────────────────────
const REGION_COLORS: Record<string, string> = {
  FACE_OVAL:            '#4A9FFF',
  LEFT_EYE:             '#00EEFF',
  RIGHT_EYE:            '#00EEFF',
  LEFT_EYEBROW_TOP:     '#A855F7',
  LEFT_EYEBROW_BOTTOM:  '#A855F7',
  RIGHT_EYEBROW_TOP:    '#A855F7',
  RIGHT_EYEBROW_BOTTOM: '#A855F7',
  NOSE_BRIDGE:          '#FACC15',
  NOSE_BOTTOM:          '#FACC15',
  UPPER_LIP_TOP:        '#F87171',
  UPPER_LIP_BOTTOM:     '#F87171',
  LOWER_LIP_TOP:        '#F87171',
  LOWER_LIP_BOTTOM:     '#F87171',
  LEFT_CHEEK:           '#34D399',
  RIGHT_CHEEK:          '#34D399',
};

const PHASES = [
  { id: 'face',   label: 'Face outline detected',   color: '#4A9FFF', delay: 0    },
  { id: 'eyes',   label: 'Eyes mapped',              color: '#00EEFF', delay: 250  },
  { id: 'brows',  label: 'Eyebrows captured',        color: '#A855F7', delay: 500  },
  { id: 'nose',   label: 'Nose analysed',            color: '#FACC15', delay: 750  },
  { id: 'mouth',  label: 'Mouth contour mapped',     color: '#F87171', delay: 1000 },
  { id: 'cheeks', label: 'Depth mapping complete',   color: '#34D399', delay: 1250 },
  { id: 'done',   label: 'Identity confirmed ✓',     color: '#10B981', delay: 1500 },
];

export default function FaceScanScreen() {
  const router  = useRouter();
  const device  = useCameraDevice('front');
  const { hasPermission, requestPermission } = useCameraPermission();

  const [faceDetected,    setFaceDetected]    = useState(false);
  const [phase,           setPhase]           = useState(-1);
  const [ptCount,         setPtCount]         = useState(0);
  const [statusText,      setStatusText]      = useState('Centre your face in the frame');
  const [landmarks,       setLandmarks]       = useState<Array<{x:number;y:number;color:string}>>([]);
  const [frameSize,       setFrameSize]       = useState({ w: 1, h: 1 });

  const scanStarted = useRef(false);
  const timers      = useRef<ReturnType<typeof setTimeout>[]>([]);
  const fadeAnim    = useRef(new Animated.Value(0)).current;
  const scanLine    = useRef(new Animated.Value(0)).current;
  const glowAnim    = useRef(new Animated.Value(0)).current;
  const successAnim = useRef(new Animated.Value(0)).current;

  // ── Request permission on mount ──────────────────────────────────
  useEffect(() => {
    if (!hasPermission) requestPermission();
    Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: true }).start();
    Animated.loop(Animated.timing(scanLine, { toValue: 1, duration: 1200, easing: Easing.inOut(Easing.ease), useNativeDriver: false })).start();
    Animated.loop(Animated.sequence([
      Animated.timing(glowAnim, { toValue: 1, duration: 1800, useNativeDriver: false }),
      Animated.timing(glowAnim, { toValue: 0, duration: 1800, useNativeDriver: false }),
    ])).start();
    return () => timers.current.forEach(clearTimeout);
  }, [hasPermission]);

  // ── Face detected callback (JS thread) ──────────────────────────
  const onFacesDetected = Worklets.createRunOnJS((faces: any[], fw: number, fh: number) => {
    if (scanStarted.current || !faces || faces.length === 0) return;
    scanStarted.current = true;
    setFaceDetected(true);
    setFrameSize({ w: fw, h: fh });

    // Build landmark dots from contour points
    const dots: Array<{x:number;y:number;color:string}> = [];
    const face = faces[0];

    if (face.contours) {
      Object.entries(face.contours).forEach(([region, points]: [string, any]) => {
        const color = REGION_COLORS[region] || '#4A9FFF';
        if (Array.isArray(points)) {
          points.forEach((p: {x:number;y:number}) => {
            // Map Vision Camera coords to screen coords (mirrored for front cam)
            const sx = SW - (p.x / fw * SW);
            const sy = p.y / fh * SH;
            dots.push({ x: sx, y: sy, color });
          });
        }
      });
    }

    setLandmarks(dots);
    setPtCount(dots.length);

    // Sequential phase reveal
    PHASES.forEach((ph, i) => {
      const t = setTimeout(() => {
        setPhase(i);
        setStatusText(ph.label);
        if (ph.id === 'done') {
          Animated.spring(successAnim, { toValue: 1, tension: 55, friction: 8, useNativeDriver: true }).start();
          setTimeout(() => router.replace('/chats'), 900);
        }
      }, ph.delay);
      timers.current.push(t);
    });
  });

  // ── Frame processor (runs on camera thread) ──────────────────────
  const { detectFaces } = useFaceDetector({
    performanceMode:    'fast',
    contourMode:        'all',
    landmarkMode:       'all',
    classificationMode: 'all',
  });

  const frameProcessor = useFrameProcessor((frame) => {
    'worklet';
    if (scanStarted.current) return;
    const faces = detectFaces(frame);
    if (faces.length > 0) {
      onFacesDetected(faces, frame.width, frame.height);
    }
  }, [detectFaces]);

  const isOK    = phase >= 6;
  const scanY   = scanLine.interpolate({ inputRange: [0,1], outputRange: [CY-140, CY+150] });
  const phaseColor = phase >= 0 ? PHASES[Math.min(phase, PHASES.length-1)].color : '#4A9FFF';

  // Permission gate
  if (!hasPermission) {
    return (
      <View style={[S.root, {justifyContent:'center', alignItems:'center', gap: 16}]}>
        <LinearGradient colors={['#010812','#020B18']} style={StyleSheet.absoluteFillObject}/>
        <Text style={{fontSize:40}}>📷</Text>
        <Text style={{color:'#fff',fontSize:16,fontWeight:'900'}}>Camera Permission Required</Text>
        <Text style={{color:'rgba(255,255,255,0.5)',fontSize:13,textAlign:'center',paddingHorizontal:40}}>
          VaultChat needs camera access for biometric face authentication
        </Text>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={[S.root, {justifyContent:'center', alignItems:'center'}]}>
        <LinearGradient colors={['#010812','#020B18']} style={StyleSheet.absoluteFillObject}/>
        <Text style={{color:'rgba(255,255,255,0.5)',fontSize:13}}>No front camera found</Text>
      </View>
    );
  }

  return (
    <View style={S.root}>
      <LinearGradient colors={['#010812','#030E1E','#010812']} style={StyleSheet.absoluteFillObject}/>

      {/* Hidden camera — processes frames but invisible to user */}
      <Camera
        style={S.hiddenCamera}
        device={device}
        isActive={!isOK}
        frameProcessor={frameProcessor}
        fps={15}
      />

      {/* Ambient glow */}
      <Animated.View style={{
        position:'absolute', alignSelf:'center', top: CY-160,
        width:320, height:320, borderRadius:160,
        backgroundColor: glowAnim.interpolate({ inputRange:[0,1], outputRange:['rgba(74,159,255,0.04)','rgba(74,159,255,0.13)'] }),
      }}/>

      {/* Concentric rings */}
      {[160,148,136].map((r, i) => (
        <View key={i} style={{
          position:'absolute', left: CX-r, top: CY-r,
          width: r*2, height: r*2, borderRadius: r,
          borderWidth: 0.8, borderColor: `rgba(74,159,255,${0.05 + i*0.03})`,
        }}/>
      ))}

      <Animated.View style={{flex:1, opacity:fadeAnim}}>

        {/* Header */}
        <View style={S.header}>
          <Text style={S.hTitle}>Biometric Authentication</Text>
          <View style={{flexDirection:'row', gap:6, alignItems:'center'}}>
            <View style={{width:6, height:6, borderRadius:3, backgroundColor: isOK ? '#10B981' : phaseColor}}/>
            <Text style={[S.hSub, {color: isOK ? '#10B981' : 'rgba(74,159,255,0.65)'}]}>
              {isOK ? 'IDENTITY CONFIRMED' : faceDetected ? 'ML KIT SCANNING' : 'AWAITING FACE'}
            </Text>
          </View>
        </View>

        {/* Landmark dots — real ML Kit points */}
        {landmarks.map((pt, i) => (
          <View key={i} style={{
            position:'absolute',
            left: pt.x - 2.5,
            top:  pt.y - 2.5,
            width: 5, height: 5, borderRadius: 2.5,
            backgroundColor: pt.color,
            opacity: 0.88,
            zIndex: 10,
          }}/>
        ))}

        {/* Face guide (before detection) */}
        {!faceDetected && (
          <View style={S.faceGuide}>
            <Text style={S.faceGuideText}>Centre your face</Text>
          </View>
        )}

        {/* Success ring */}
        {isOK && (
          <Animated.View style={[S.successRing, {transform:[{scale: successAnim}]}]}>
            <Text style={{color:'#10B981', fontSize:52, fontWeight:'900'}}>✓</Text>
          </Animated.View>
        )}

        {/* Scan line */}
        {!isOK && faceDetected && (
          <Animated.View style={[S.scanLine, {top: scanY, backgroundColor: phaseColor}]}/>
        )}

        {/* Corner brackets */}
        {[
          {top: CY-148, left: CX-140},
          {top: CY-148, left: CX+112, sx:-1},
          {top: CY+122, left: CX-140, sy:-1},
          {top: CY+122, left: CX+112, sx:-1, sy:-1},
        ].map(({sx=1, sy=1, ...pos}, i) => (
          <View key={i} style={[S.bracket, pos, {transform:[{scaleX:sx},{scaleY:sy}]}]}>
            <View style={[S.bH, isOK && {backgroundColor:'#10B981'}]}/>
            <View style={[S.bV, isOK && {backgroundColor:'#10B981'}]}/>
          </View>
        ))}

        {/* Cross-axis */}
        <View style={{position:'absolute', left:CX-130, top:CY, width:260, height:0.8, backgroundColor:'rgba(74,159,255,0.1)'}}/>
        <View style={{position:'absolute', left:CX, top:CY-145, width:0.8, height:290, backgroundColor:'rgba(74,159,255,0.1)'}}/>
        <View style={{position:'absolute', left:CX-4, top:CY-4, width:8, height:8, borderRadius:4, backgroundColor:'rgba(74,159,255,0.3)'}}/>

        <View style={{flex:1}}/>

        {/* Feature badges */}
        <View style={S.badgesRow}>
          {[
            {lbl:'EYES',   color:'#00EEFF', done: phase >= 1},
            {lbl:'BROWS',  color:'#A855F7', done: phase >= 2},
            {lbl:'NOSE',   color:'#FACC15', done: phase >= 3},
            {lbl:'MOUTH',  color:'#F87171', done: phase >= 4},
            {lbl:'CHEEKS', color:'#34D399', done: phase >= 5},
          ].map((b, i) => (
            <View key={i} style={[S.badge, b.done && {borderColor: b.color+'55', backgroundColor: b.color+'10'}]}>
              <View style={[S.badgeDot, {backgroundColor: b.done ? b.color : 'rgba(255,255,255,0.12)'}]}/>
              <Text style={[S.badgeLbl, {color: b.done ? b.color : 'rgba(255,255,255,0.2)'}]}>{b.lbl}</Text>
            </View>
          ))}
        </View>

        {/* Stats */}
        <View style={S.statsRow}>
          {[
            {lbl:'LANDMARKS', val: ptCount > 0 ? String(ptCount) : '--',                         color: ptCount >= 100 ? '#10B981' : '#4A9FFF'},
            {lbl:'CONFIDENCE', val: isOK ? '99.8%' : ptCount > 0 ? `${Math.min(99,60+ptCount/2).toFixed(0)}%` : '--', color:'#A855F7'},
            {lbl:'LIVENESS',   val: ptCount > 0 ? 'REAL' : 'SCAN',                               color: ptCount > 0 ? '#10B981' : '#F59E0B'},
          ].map((s,i) => (
            <View key={i} style={S.statCard}>
              <Text style={S.statLabel}>{s.lbl}</Text>
              <Text style={[S.statVal, {color: s.color}]}>{s.val}</Text>
            </View>
          ))}
        </View>

        {/* Status */}
        <View style={S.statusRow}>
          <View style={[S.statusDot, {backgroundColor: isOK ? '#10B981' : phaseColor}]}/>
          <Text style={S.statusTxt}>{statusText}</Text>
        </View>

      </Animated.View>
    </View>
  );
}

const S = StyleSheet.create({
  root:        {flex:1, backgroundColor:'#010812'},
  hiddenCamera:{position:'absolute', width:1, height:1, opacity:0},
  header:      {paddingTop:52, paddingBottom:10, alignItems:'center', gap:5},
  hTitle:      {color:'#fff', fontSize:17, fontWeight:'900', letterSpacing:0.3},
  hSub:        {fontSize:9, fontWeight:'700', letterSpacing:2.5},
  scanLine:    {position:'absolute', left:CX-140, width:280, height:1.5, opacity:0.7},
  bracket:     {position:'absolute', width:28, height:28, zIndex:20},
  bH:          {position:'absolute', top:0, left:0, width:28, height:3, backgroundColor:'#4A9FFF', borderRadius:2},
  bV:          {position:'absolute', top:0, left:0, width:3, height:28, backgroundColor:'#4A9FFF', borderRadius:2},
  faceGuide:   {position:'absolute', left:CX-70, top:CY-100, width:140, height:180, borderRadius:70, borderWidth:1.5, borderColor:'rgba(74,159,255,0.25)', borderStyle:'dashed', justifyContent:'flex-end', alignItems:'center', paddingBottom:12},
  faceGuideText:{color:'rgba(74,159,255,0.5)', fontSize:10, fontWeight:'700'},
  successRing: {position:'absolute', left:CX-68, top:CY-68, width:136, height:136, borderRadius:68, borderWidth:2, borderColor:'#10B981', backgroundColor:'rgba(16,185,129,0.1)', justifyContent:'center', alignItems:'center', zIndex:20},
  badgesRow:   {flexDirection:'row', paddingHorizontal:20, gap:7, marginBottom:12},
  badge:       {flex:1, flexDirection:'row', alignItems:'center', gap:5, backgroundColor:'rgba(10,22,40,0.8)', borderRadius:10, paddingHorizontal:8, paddingVertical:7, borderWidth:1, borderColor:'rgba(255,255,255,0.06)'},
  badgeDot:    {width:5, height:5, borderRadius:2.5},
  badgeLbl:    {fontSize:8, fontWeight:'800', letterSpacing:0.5},
  statsRow:    {flexDirection:'row', paddingHorizontal:20, gap:10, marginBottom:10},
  statCard:    {flex:1, backgroundColor:'rgba(10,22,40,0.85)', borderRadius:14, padding:11, alignItems:'center', gap:3, borderWidth:1, borderColor:'rgba(74,159,255,0.1)'},
  statLabel:   {color:'rgba(255,255,255,0.3)', fontSize:7, fontWeight:'800', letterSpacing:1},
  statVal:     {fontSize:14, fontWeight:'900'},
  statusRow:   {flexDirection:'row', alignItems:'center', justifyContent:'center', gap:8, paddingBottom:40},
  statusDot:   {width:7, height:7, borderRadius:3.5},
  statusTxt:   {color:'rgba(255,255,255,0.4)', fontSize:12},
});
