import { ErrorBoundary } from '../components/ErrorBoundary';
﻿// app/deepfake.tsx — DeepFake Detection Screen
import { CameraView, useCameraPermissions } from 'expo-camera';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Animated, Dimensions, Easing, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { DeepFakeResult, analyzeFrame, clearFrameHistory, getRiskColor } from '../constants/deepfakeDetection';

const { width } = Dimensions.get('window');

function DeepFakeScreenContent() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<DeepFakeResult | null>(null);
  const [frameCount, setFrameCount] = useState(0);
  const [showDetails, setShowDetails] = useState(false);
  const [history, setHistory] = useState<DeepFakeResult[]>([]);
  const [autoMode, setAutoMode] = useState(false);
  const [facing, setFacing] = useState<'front'|'back'>('front');

  const cameraRef  = useRef<CameraView>(null);
  const fadeIn     = useRef(new Animated.Value(0)).current;
  const scanAnim   = useRef(new Animated.Value(0)).current;
  const alertAnim  = useRef(new Animated.Value(0)).current;
  const radarAnim  = useRef(new Animated.Value(0)).current;
  const pulseAnim  = useRef(new Animated.Value(1)).current;
  const autoTimer  = useRef<ReturnType<typeof setInterval>|null>(null);
  const scanAnimRef = useRef<Animated.CompositeAnimation|null>(null);

  useEffect(()=>{
    Animated.timing(fadeIn,{toValue:1,duration:600,useNativeDriver:true}).start();
    Animated.loop(Animated.timing(radarAnim,{toValue:1,duration:3000,easing:Easing.linear,useNativeDriver:true})).start();
    Animated.loop(Animated.sequence([
      Animated.timing(pulseAnim,{toValue:1.05,duration:1500,easing:Easing.inOut(Easing.ease),useNativeDriver:true}),
      Animated.timing(pulseAnim,{toValue:1.00,duration:1500,easing:Easing.inOut(Easing.ease),useNativeDriver:true}),
    ])).start();
    return ()=>{
      if(autoTimer.current) clearInterval(autoTimer.current);
      clearFrameHistory();
    };
  },[]);

  useEffect(()=>{
    if(autoMode){
      autoTimer.current = setInterval(()=>captureAndAnalyze(),3000);
    } else {
      if(autoTimer.current){ clearInterval(autoTimer.current); autoTimer.current=null; }
    }
    return ()=>{ if(autoTimer.current) clearInterval(autoTimer.current); };
  },[autoMode]);

  useEffect(()=>{
    if(result && (result.riskLevel==='HIGH'||result.riskLevel==='CRITICAL')){
      Animated.sequence([
        Animated.timing(alertAnim,{toValue:1,duration:200,useNativeDriver:true}),
        Animated.timing(alertAnim,{toValue:0,duration:200,useNativeDriver:true}),
        Animated.timing(alertAnim,{toValue:1,duration:200,useNativeDriver:true}),
        Animated.timing(alertAnim,{toValue:0,duration:200,useNativeDriver:true}),
      ]).start();
    }
  },[result]);

  const startScanAnimation = () => {
    scanAnim.setValue(0);
    scanAnimRef.current = Animated.loop(Animated.sequence([
      Animated.timing(scanAnim,{toValue:1,duration:1200,easing:Easing.inOut(Easing.quad),useNativeDriver:false}),
      Animated.timing(scanAnim,{toValue:0,duration:1200,easing:Easing.inOut(Easing.quad),useNativeDriver:false}),
    ]));
    scanAnimRef.current.start();
  };

  const captureAndAnalyze = async () => {
    if(isAnalyzing || !cameraRef.current) return;
    setIsAnalyzing(true);
    startScanAnimation();
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality:0.4, base64:false, skipProcessing:true,
      });
      if(!photo?.uri) return;
      setFrameCount(f=>f+1);
      const res = await analyzeFrame(photo.uri);
      setResult(res);
      setHistory(prev=>[res,...prev].slice(0,10));
      if(res.riskLevel==='CRITICAL'){
        Alert.alert(
          '🚨 DEEPFAKE DETECTED',
          'Critical: AI-generated face detected on this call.\n\nRecommendation: End the call immediately.',
          [{text:'End Call',style:'destructive',onPress:()=>router.back()},{text:'Continue Monitoring',style:'cancel'}]
        );
      }
    } catch(e){ console.log('Analysis error:',e); }
    finally{ setIsAnalyzing(false); scanAnimRef.current?.stop(); }
  };

  const riskColor = result ? getRiskColor(result.riskLevel) : '#1D4ED8';
  const scanTop = scanAnim.interpolate({inputRange:[0,1],outputRange:[0,width*0.7]});
  const radarRotate = radarAnim.interpolate({inputRange:[0,1],outputRange:['0deg','360deg']});
  const alertOpacity = alertAnim.interpolate({inputRange:[0,1],outputRange:[0,0.3]});

  if(!permission) return (
    <LinearGradient colors={['#020B18','#060F24']} style={{flex:1,justifyContent:'center',alignItems:'center'}}>
      <Text style={{color:'#fff'}}>Loading...</Text>
    </LinearGradient>
  );

  if(!permission.granted) return (
    <LinearGradient colors={['#020B18','#040F20','#060F24']} style={{flex:1,justifyContent:'center',alignItems:'center',padding:32}}>
      <Text style={{fontSize:60,marginBottom:20}}>🎭</Text>
      <Text style={{color:'#fff',fontSize:22,fontWeight:'900',textAlign:'center',marginBottom:10}}>Camera Required</Text>
      <Text style={{color:'#3D5A7A',fontSize:14,textAlign:'center',marginBottom:30,lineHeight:22}}>DeepFake Detection needs camera access to analyze video frames in real-time.</Text>
      <TouchableOpacity onPress={requestPermission}>
        <LinearGradient colors={['#1D4ED8','#7C3AED']} style={{borderRadius:16,paddingVertical:16,paddingHorizontal:40}}>
          <Text style={{color:'#fff',fontSize:16,fontWeight:'800'}}>Allow Camera</Text>
        </LinearGradient>
      </TouchableOpacity>
    </LinearGradient>
  );

  return (
    <LinearGradient colors={['#020B18','#040F20','#060F24']} style={{flex:1}}>
      <Animated.View style={{flex:1,opacity:fadeIn}}>
        <ScrollView contentContainerStyle={S.container}>

          {/* Header */}
          <View style={S.header}>
            <TouchableOpacity onPress={()=>router.back()} style={S.backBtn}>
              <Text style={{color:'#4A9FFF',fontSize:18}}>←</Text>
            </TouchableOpacity>
            <View style={{flex:1}}>
              <Text style={S.title}>🎭 DeepFake Detector</Text>
              <Text style={{color:'#3D5A7A',fontSize:9,letterSpacing:1.5}}>REAL-TIME AI ANALYSIS · WORLD FIRST</Text>
            </View>
            <TouchableOpacity onPress={()=>setFacing(f=>f==='front'?'back':'front')} style={S.flipBtn}>
              <Text style={{fontSize:18}}>🔄</Text>
            </TouchableOpacity>
          </View>

          {/* Status banner */}
          {result&&(
            <Animated.View style={[S.statusBanner,{backgroundColor:riskColor+'22',borderColor:riskColor}]}>
              <Text style={{fontSize:20}}>
                {result.riskLevel==='SAFE'?'✅':result.riskLevel==='LOW'?'🟡':result.riskLevel==='MEDIUM'?'⚠️':result.riskLevel==='HIGH'?'🚨':'🔴'}
              </Text>
              <View style={{flex:1,marginLeft:10}}>
                <Text style={[S.statusTitle,{color:riskColor}]}>{result.riskLevel} RISK — {result.isDeepFake?'DEEPFAKE DETECTED':'APPEARS REAL'}</Text>
                <Text style={{color:'#3D5A7A',fontSize:10}}>{result.confidence.toFixed(1)}% deepfake confidence · {result.analysisTime}ms</Text>
              </View>
            </Animated.View>
          )}

          {/* Camera view */}
          <View style={S.cameraContainer}>
            {/* Alert flash overlay */}
            {result&&result.riskLevel!=='SAFE'&&(
              <Animated.View style={[S.alertOverlay,{opacity:alertOpacity,backgroundColor:riskColor}]}/>
            )}

            <CameraView ref={cameraRef} style={S.camera} facing={facing}/>

            {/* Radar overlay */}
            <View style={S.overlay}>
              {/* Corner brackets */}
              <View style={[S.corner,S.cTL,{borderColor:riskColor}]}/>
              <View style={[S.corner,S.cTR,{borderColor:riskColor}]}/>
              <View style={[S.corner,S.cBL,{borderColor:riskColor}]}/>
              <View style={[S.corner,S.cBR,{borderColor:riskColor}]}/>

              {/* Radar circles */}
              <View style={{position:'absolute',alignItems:'center',justifyContent:'center',width:'100%',height:'100%'}}>
                <Animated.View style={[S.radarRing,{width:width*0.5,height:width*0.5,borderRadius:width*0.25,borderColor:riskColor,transform:[{rotate:radarRotate}],opacity:0.3}]}/>
                <Animated.View style={[S.radarRing,{width:width*0.35,height:width*0.35,borderRadius:width*0.175,borderColor:riskColor,transform:[{rotate:radarRotate}],opacity:0.2}]}/>
              </View>

              {/* Scan line */}
              {isAnalyzing&&(
                <Animated.View style={[S.scanLine,{top:scanTop,backgroundColor:riskColor}]}/>
              )}

              {/* Analysis points */}
              {[
                {x:'20%',y:'25%',label:'BROW'},
                {x:'75%',y:'25%',label:'BROW'},
                {x:'48%',y:'42%',label:'NOSE'},
                {x:'25%',y:'55%',label:'CHEEK'},
                {x:'70%',y:'55%',label:'CHEEK'},
                {x:'48%',y:'68%',label:'MOUTH'},
                {x:'48%',y:'15%',label:'HEAD'},
              ].map((pt,i)=>(
                <View key={i} style={{position:'absolute',left:pt.x as any,top:pt.y as any,alignItems:'center'}}>
                  <View style={[S.analysisPoint,{backgroundColor:riskColor}]}/>
                  <Text style={[S.analysisLabel,{color:riskColor}]}>{pt.label}</Text>
                </View>
              ))}

              {/* HUD */}
              <View style={{position:'absolute',top:8,left:12}}>
                <Text style={{color:riskColor,fontSize:8,fontWeight:'900',letterSpacing:1.5}}>DEEPFAKE•AI</Text>
              </View>
              <View style={{position:'absolute',top:8,right:12}}>
                <Text style={{color:riskColor,fontSize:8,fontWeight:'900',letterSpacing:1}}>FRAMES:{frameCount}</Text>
              </View>
              <View style={{position:'absolute',bottom:8,left:12}}>
                <Text style={{color:riskColor,fontSize:8,fontWeight:'900',letterSpacing:1}}>{autoMode?'AUTO•SCAN':'MANUAL'}</Text>
              </View>
              <View style={{position:'absolute',bottom:8,right:12}}>
                <Text style={{color:riskColor,fontSize:8,fontWeight:'900',letterSpacing:1}}>{isAnalyzing?'SCANNING...':'READY'}</Text>
              </View>
            </View>
          </View>

          {/* Scan controls */}
          <View style={S.controls}>
            <TouchableOpacity
              onPress={captureAndAnalyze}
              disabled={isAnalyzing}
              style={{flex:1}}
            >
              <LinearGradient
                colors={isAnalyzing?['#1D2D44','#1D2D44']:['#1D4ED8','#7C3AED']}
                style={S.scanBtn}
              >
                <Text style={{fontSize:22}}>{isAnalyzing?'⏳':'🎭'}</Text>
                <Text style={S.scanBtnText}>{isAnalyzing?'Analyzing...':'Scan Frame'}</Text>
              </LinearGradient>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={()=>setAutoMode(!autoMode)}
              style={{flex:1}}
            >
              <LinearGradient
                colors={autoMode?['#7C3AED','#6D28D9']:['#0A1628','#0D1E3A']}
                style={S.scanBtn}
              >
                <Text style={{fontSize:22}}>{autoMode?'⏸️':'▶️'}</Text>
                <Text style={[S.scanBtnText,{color:autoMode?'#fff':'#4A9FFF'}]}>{autoMode?'Stop Auto':'Auto Scan'}</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>

          {/* Analysis metrics */}
          {result&&(
            <View style={S.metricsCard}>
              <Text style={S.metricsTitle}>📊 Analysis Metrics</Text>
              {[
                {label:'Texture Analysis',value:result.textureScore,icon:'🔬'},
                {label:'Blink Pattern',value:result.blinkPattern,icon:'👁️'},
                {label:'Facial Consistency',value:result.facialConsistency,icon:'🎭'},
                {label:'Motion Analysis',value:result.motionScore,icon:'🎬'},
              ].map((m,i)=>{
                const c = m.value>70?'#10B981':m.value>40?'#F59E0B':'#EF4444';
                return (
                  <View key={i} style={S.metricRow}>
                    <Text style={{width:28,fontSize:14}}>{m.icon}</Text>
                    <Text style={S.metricLabel}>{m.label}</Text>
                    <View style={S.metricBarBg}>
                      <View style={[S.metricBarFill,{width:m.value+'%' as any,backgroundColor:c}]}/>
                    </View>
                    <Text style={[S.metricValue,{color:c}]}>{m.value.toFixed(0)}</Text>
                  </View>
                );
              })}

              {/* Alerts */}
              {result.alerts.length>0&&(
                <View style={S.alertsBox}>
                  {result.alerts.map((a,i)=>(
                    <Text key={i} style={S.alertText}>{a}</Text>
                  ))}
                </View>
              )}

              <TouchableOpacity onPress={()=>setShowDetails(true)} style={{marginTop:10,alignItems:'center'}}>
                <Text style={{color:'#4A9FFF',fontSize:12,fontWeight:'700'}}>View Full Report →</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Scan history */}
          {history.length>0&&(
            <View style={S.historyCard}>
              <Text style={S.metricsTitle}>📋 Scan History</Text>
              {history.map((h,i)=>(
                <View key={i} style={[S.historyRow,{borderLeftColor:getRiskColor(h.riskLevel)}]}>
                  <View style={[S.historyDot,{backgroundColor:getRiskColor(h.riskLevel)}]}/>
                  <Text style={{color:'#fff',fontSize:12,fontWeight:'700',flex:1}}>{h.riskLevel}</Text>
                  <Text style={{color:'#3D5A7A',fontSize:11}}>{h.confidence.toFixed(0)}% fake</Text>
                  <Text style={{color:'#3D5A7A',fontSize:10,marginLeft:8}}>{h.analysisTime}ms</Text>
                </View>
              ))}
            </View>
          )}

          {/* Info cards */}
          <View style={S.infoGrid}>
            {[
              {icon:'🔬',title:'Texture Analysis',sub:'Detects AI skin smoothing'},
              {icon:'👁️',title:'Blink Detection',sub:'Natural vs synthetic blinks'},
              {icon:'🎬',title:'Motion Analysis',sub:'Frame-to-frame consistency'},
              {icon:'🎨',title:'Color Analysis',sub:'Pixel distribution patterns'},
            ].map((c,i)=>(
              <View key={i} style={S.infoCard}>
                <Text style={{fontSize:20,marginBottom:4}}>{c.icon}</Text>
                <Text style={{color:'#fff',fontSize:10,fontWeight:'700',textAlign:'center'}}>{c.title}</Text>
                <Text style={{color:'#3D5A7A',fontSize:8,textAlign:'center',marginTop:2}}>{c.sub}</Text>
              </View>
            ))}
          </View>

          <LinearGradient colors={['#1D4ED8','#7C3AED']} style={{borderRadius:12,paddingVertical:10,alignItems:'center',marginBottom:20}} start={{x:0,y:0}} end={{x:1,y:0}}>
            <Text style={{color:'#fff',fontSize:10,fontWeight:'800',letterSpacing:0.8}}>🎭 REAL-TIME DEEPFAKE DETECTION · WORLD FIRST · VAULTCHAT</Text>
          </LinearGradient>

        </ScrollView>
      </Animated.View>

      {/* Full Report Modal */}
      <Modal visible={showDetails} transparent animationType="slide">
        <View style={{flex:1,backgroundColor:'rgba(0,0,0,0.92)',justifyContent:'flex-end'}}>
          <LinearGradient colors={['#0A1628','#0D1E3A']} style={{borderTopLeftRadius:28,borderTopRightRadius:28,padding:24,paddingBottom:44,maxHeight:'80%'}}>
            <ScrollView>
              <Text style={{color:'#fff',fontSize:20,fontWeight:'900',marginBottom:4}}>📊 Full Analysis Report</Text>
              <Text style={{color:'#3D5A7A',fontSize:12,marginBottom:16}}>Frame #{frameCount} · {result?.analysisTime}ms analysis time</Text>
              {result&&[
                {label:'Risk Level',value:result.riskLevel,color:riskColor},
                {label:'DeepFake Confidence',value:result.confidence.toFixed(2)+'%',color:riskColor},
                {label:'Verdict',value:result.isDeepFake?'⚠️ DEEPFAKE DETECTED':'✅ APPEARS GENUINE',color:riskColor},
                {label:'Texture Score',value:result.textureScore.toFixed(2)+'/100',color:'#4A9FFF'},
                {label:'Blink Pattern Score',value:result.blinkPattern.toFixed(2)+'/100',color:'#4A9FFF'},
                {label:'Facial Consistency',value:result.facialConsistency.toFixed(2)+'/100',color:'#4A9FFF'},
                {label:'Motion Score',value:result.motionScore.toFixed(2)+'/100',color:'#4A9FFF'},
                {label:'Frames Analyzed',value:frameCount.toString(),color:'#A78BFA'},
                {label:'Analysis Engine',value:'VaultChat AI v1.0',color:'#A78BFA'},
              ].map((item,i)=>(
                <View key={i} style={{marginBottom:12,backgroundColor:'#060E22',borderRadius:10,padding:12}}>
                  <Text style={{color:'#3D5A7A',fontSize:9,letterSpacing:1,marginBottom:3}}>{item.label.toUpperCase()}</Text>
                  <Text style={{color:item.color,fontSize:15,fontWeight:'800'}}>{item.value}</Text>
                </View>
              ))}
              {result&&result.alerts.length>0&&(
                <View style={{backgroundColor:'#3B0A0A',borderRadius:10,padding:12,marginBottom:12,borderWidth:1,borderColor:'#7F1D1D'}}>
                  <Text style={{color:'#FCA5A5',fontSize:11,fontWeight:'700',marginBottom:6}}>ACTIVE ALERTS</Text>
                  {result.alerts.map((a,i)=><Text key={i} style={{color:'#FCA5A5',fontSize:12,marginBottom:3}}>{a}</Text>)}
                </View>
              )}
              <TouchableOpacity onPress={()=>setShowDetails(false)} style={{alignItems:'center',paddingVertical:14,marginTop:4}}>
                <Text style={{color:'#4A9FFF',fontSize:14,fontWeight:'700'}}>Close Report</Text>
              </TouchableOpacity>
            </ScrollView>
          </LinearGradient>
        </View>
      </Modal>
    </LinearGradient>
  );
}

const S = StyleSheet.create({
  container:{paddingHorizontal:18,paddingTop:50,paddingBottom:20},
  header:{flexDirection:'row',alignItems:'center',marginBottom:14,gap:10},
  backBtn:{width:36,height:36,borderRadius:18,backgroundColor:'#0A1628',justifyContent:'center',alignItems:'center',borderWidth:1,borderColor:'#0D1E3A'},
  flipBtn:{width:36,height:36,borderRadius:18,backgroundColor:'#0A1628',justifyContent:'center',alignItems:'center',borderWidth:1,borderColor:'#0D1E3A'},
  title:{color:'#fff',fontSize:18,fontWeight:'900'},
  statusBanner:{flexDirection:'row',alignItems:'center',borderRadius:14,padding:14,marginBottom:14,borderWidth:1.5},
  statusTitle:{fontSize:13,fontWeight:'900',letterSpacing:0.5},
  cameraContainer:{width:'100%',height:width*0.75,borderRadius:20,overflow:'hidden',marginBottom:14,borderWidth:2,borderColor:'#1D4ED8',position:'relative'},
  alertOverlay:{position:'absolute',width:'100%',height:'100%',zIndex:5},
  camera:{width:'100%',height:'100%'},
  overlay:{position:'absolute',width:'100%',height:'100%',zIndex:10},
  corner:{position:'absolute',width:22,height:22,borderWidth:3},
  cTL:{top:12,left:12,borderRightWidth:0,borderBottomWidth:0,borderTopLeftRadius:4},
  cTR:{top:12,right:12,borderLeftWidth:0,borderBottomWidth:0,borderTopRightRadius:4},
  cBL:{bottom:12,left:12,borderRightWidth:0,borderTopWidth:0,borderBottomLeftRadius:4},
  cBR:{bottom:12,right:12,borderLeftWidth:0,borderTopWidth:0,borderBottomRightRadius:4},
  radarRing:{borderWidth:1,borderStyle:'dashed',position:'absolute'},
  scanLine:{position:'absolute',left:0,right:0,height:2,opacity:0.8,shadowOffset:{width:0,height:0},shadowOpacity:1,shadowRadius:8,elevation:8},
  analysisPoint:{width:6,height:6,borderRadius:3},
  analysisLabel:{fontSize:7,fontWeight:'900',letterSpacing:0.5,marginTop:2},
  controls:{flexDirection:'row',gap:10,marginBottom:14},
  scanBtn:{borderRadius:16,padding:16,alignItems:'center',flexDirection:'row',justifyContent:'center',gap:8},
  scanBtnText:{color:'#fff',fontSize:14,fontWeight:'800'},
  metricsCard:{backgroundColor:'#0A1628',borderRadius:18,padding:16,marginBottom:14,borderWidth:1,borderColor:'#0D1E3A'},
  metricsTitle:{color:'#fff',fontSize:14,fontWeight:'800',marginBottom:14},
  metricRow:{flexDirection:'row',alignItems:'center',marginBottom:10,gap:8},
  metricLabel:{color:'#3D5A7A',fontSize:11,flex:1},
  metricBarBg:{flex:2,height:6,backgroundColor:'#060E22',borderRadius:3,overflow:'hidden'},
  metricBarFill:{height:6,borderRadius:3},
  metricValue:{color:'#fff',fontSize:11,fontWeight:'700',width:28,textAlign:'right'},
  alertsBox:{backgroundColor:'#3B0A0A',borderRadius:10,padding:12,marginTop:8,borderWidth:1,borderColor:'#7F1D1D'},
  alertText:{color:'#FCA5A5',fontSize:11,marginBottom:3},
  historyCard:{backgroundColor:'#0A1628',borderRadius:18,padding:16,marginBottom:14,borderWidth:1,borderColor:'#0D1E3A'},
  historyRow:{flexDirection:'row',alignItems:'center',paddingVertical:8,borderLeftWidth:3,paddingLeft:10,marginBottom:4,gap:8},
  historyDot:{width:8,height:8,borderRadius:4},
  infoGrid:{flexDirection:'row',flexWrap:'wrap',gap:10,marginBottom:14},
  infoCard:{width:(width-46)/2,backgroundColor:'#0A1628',borderRadius:14,padding:14,alignItems:'center',borderWidth:1,borderColor:'#0D1E3A'},
});

export default function DeepFakeScreen() {
  return (
    <ErrorBoundary fallbackTitle="DeepFake Error" fallbackMessage="DeepFake detection had a problem.">
      <DeepFakeScreenContent />
    </ErrorBoundary>
  );
}
