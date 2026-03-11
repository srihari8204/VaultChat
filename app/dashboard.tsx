import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Animated, Easing, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { ErrorBoundary } from '../components/ErrorBoundary';

const C = {
  bg:'#020B18', surface:'rgba(10,22,40,0.85)', surface2:'rgba(6,14,34,0.9)',
  primary:'#4A9FFF', secondary:'#7C3AED', accent:'#10B981', danger:'#EF4444', warning:'#F59E0B',
  border:'rgba(74,159,255,0.15)', borderDim:'rgba(255,255,255,0.06)',
  text:'#FFFFFF', textDim:'rgba(255,255,255,0.5)', textFaint:'rgba(255,255,255,0.22)',
};

const NAV = [
  {id:'chats',icon:'💬',label:'Chats',route:'/chats'},
  {id:'shield',icon:'🛡️',label:'Shield',route:'/dashboard'},
  {id:'community',icon:'🌐',label:'Community',route:'/communities'},
  {id:'vault',icon:'📦',label:'Vault',route:'/filevault'},
  {id:'alerts',icon:'🔔',label:'Alerts',route:'/notifications'},
];

const MODULES = [
  {name:'End-to-End Encryption',icon:'🔐',status:'active',score:100,desc:'AES-256 active on all channels'},
  {name:'Face Scan Auth',icon:'👁️',status:'active',score:98,desc:'468-point biometric mesh running'},
  {name:'Screenshot Prevention',icon:'🛡️',status:'active',score:100,desc:'Screen capture blocked globally'},
  {name:'VaultID Blockchain',icon:'⛓️',status:'active',score:95,desc:'Identity verified on Ethereum'},
  {name:'DeepFake Detection',icon:'🤖',status:'active',score:97,desc:'4-engine AI analysis active'},
  {name:'Dark Web Monitor',icon:'🕵️',status:'warning',score:72,desc:'2 breach alerts require review'},
  {name:'AI Behavioral Guard',icon:'🧠',status:'active',score:94,desc:'Keystroke dynamics normal'},
  {name:'MemoryShield',icon:'💥',status:'active',score:100,desc:'Nuclear wipe protocol armed'},
  {name:'VoiceCloak',icon:'🎙️',status:'active',score:91,desc:'Voice morphing engine active'},
  {name:'TimeLock',icon:'⏱️',status:'active',score:100,desc:'Scheduled encryption active'},
];

const THREATS = [
  {type:'Screenshot attempt blocked',severity:'high',time:'2m ago',resolved:true},
  {type:'Unknown device login attempt',severity:'critical',time:'15m ago',resolved:true},
  {type:'Dark web email mention',severity:'medium',time:'1h ago',resolved:false},
  {type:'Suspicious message pattern',severity:'low',time:'3h ago',resolved:true},
];

function DashboardContent() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState('shield');
  const [contentTab, setContentTab] = useState<'modules'|'threats'>('modules');
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const fadeAnim  = useRef(new Animated.Value(0)).current;
  const radarAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const scoreAnim = useRef(new Animated.Value(0)).current;

  useEffect(()=>{
    Animated.timing(fadeAnim,{toValue:1,duration:500,useNativeDriver:true}).start();
    Animated.loop(Animated.timing(radarAnim,{toValue:1,duration:3500,easing:Easing.linear,useNativeDriver:true})).start();
    Animated.loop(Animated.sequence([
      Animated.timing(pulseAnim,{toValue:1.04,duration:2500,easing:Easing.inOut(Easing.ease),useNativeDriver:true}),
      Animated.timing(pulseAnim,{toValue:1,duration:2500,easing:Easing.inOut(Easing.ease),useNativeDriver:true}),
    ])).start();
    Animated.timing(scoreAnim,{toValue:94,duration:1400,useNativeDriver:false}).start();
  },[]);

  const runScan = () => {
    if(scanning) return;
    setScanning(true); setScanProgress(0);
    let p=0;
    const iv = setInterval(()=>{
      p += Math.random()*4+2;
      setScanProgress(Math.min(p,100));
      if(p>=100){ clearInterval(iv); setScanning(false); setScanProgress(0); Alert.alert('Scan Complete','All 10 modules checked. Score: 94/100. System is secure.'); }
    },80);
  };

  const handleNav = (item:typeof NAV[0]) => {
    setActiveTab(item.id);
    if(item.id!=='shield') router.push(item.route as any);
  };

  const getStatusColor = (s:string) => s==='active'?C.accent:s==='warning'?C.warning:C.danger;
  const getSevColor = (s:string) => s==='critical'?C.danger:s==='high'?C.warning:s==='medium'?C.primary:C.accent;
  const radarDeg = radarAnim.interpolate({inputRange:[0,1],outputRange:['0deg','360deg']});

  return (
    <View style={S.container}>
      <LinearGradient colors={['#020B18','#040F20','#060F24']} style={StyleSheet.absoluteFillObject}/>
      <View style={S.glowTop}/>

      <Animated.View style={[{flex:1},{ opacity:fadeAnim}]}>
        <View style={S.header}>
          <TouchableOpacity onPress={()=>router.back()} style={S.backBtn}><Text style={{color:C.primary,fontSize:18}}>←</Text></TouchableOpacity>
          <View style={{flex:1}}>
            <Text style={S.title}>🛡️ Security Hub</Text>
            <Text style={{color:C.textFaint,fontSize:9,letterSpacing:2}}>REAL-TIME THREAT MONITORING</Text>
          </View>
          <TouchableOpacity onPress={runScan} style={[S.scanBtn,scanning&&{opacity:0.65}]}>
            <Text style={{color:C.primary,fontSize:10,fontWeight:'800',letterSpacing:1}}>{scanning?'SCANNING...':'SCAN NOW'}</Text>
          </TouchableOpacity>
        </View>

        <View style={S.scoreArea}>
          <Animated.View style={[S.scoreRing,{transform:[{scale:pulseAnim}]}]}>
            <View style={S.radarBg}/>
            <Animated.View style={[S.radarSweep,{transform:[{rotate:radarDeg}]}]}/>
            <View style={[S.radarRing,{width:100,height:100,borderRadius:50}]}/>
            <View style={[S.radarRing,{width:68,height:68,borderRadius:34}]}/>
            <View style={S.scoreCenter}>
              <Text style={S.scoreNum}>94</Text>
              <Text style={S.scoreLabel}>VAULT SCORE</Text>
              <View style={{flexDirection:'row',alignItems:'center',gap:4,marginTop:3}}>
                <View style={{width:6,height:6,borderRadius:3,backgroundColor:C.accent}}/>
                <Text style={{color:C.accent,fontSize:9,fontWeight:'700'}}>SECURE</Text>
              </View>
            </View>
          </Animated.View>

          {scanning&&(
            <View style={{width:'65%',marginTop:16}}>
              <View style={{height:3,backgroundColor:'rgba(255,255,255,0.06)',borderRadius:2,overflow:'hidden'}}>
                <View style={{width:scanProgress+'%',height:3,backgroundColor:C.primary,borderRadius:2}}/>
              </View>
              <Text style={{color:C.textFaint,fontSize:9,letterSpacing:1,marginTop:5,textAlign:'center'}}>SCANNING {Math.floor(scanProgress)}%</Text>
            </View>
          )}
        </View>

        <View style={S.statsRow}>
          {[
            {label:'Messages Encrypted',value:'14.2K',icon:'🔐',color:C.primary},
            {label:'Threats Blocked',value:'847',icon:'🛡️',color:C.accent},
            {label:'Breach Alerts',value:'2',icon:'🕵️',color:C.warning},
            {label:'Active Modules',value:'10',icon:'⚡',color:C.secondary},
          ].map((s,i)=>(
            <View key={i} style={S.statCard}>
              <Text style={{fontSize:16}}>{s.icon}</Text>
              <Text style={{color:s.color,fontSize:15,fontWeight:'900'}}>{s.value}</Text>
              <Text style={{color:C.textFaint,fontSize:7,letterSpacing:0.5,textAlign:'center',marginTop:1}}>{s.label}</Text>
            </View>
          ))}
        </View>

        <View style={S.tabs}>
          {(['modules','threats'] as const).map(tab=>(
            <TouchableOpacity key={tab} onPress={()=>setContentTab(tab)} style={[S.tab,contentTab===tab&&S.tabActive]}>
              <Text style={[S.tabText,{color:contentTab===tab?C.primary:C.textFaint}]}>{tab.toUpperCase()}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <ScrollView contentContainerStyle={{paddingHorizontal:18,paddingBottom:110}} showsVerticalScrollIndicator={false}>
          {contentTab==='modules'&&MODULES.map((mod,i)=>(
            <View key={i} style={S.moduleRow}>
              <View style={[S.modIcon,{backgroundColor:getStatusColor(mod.status)+'18',borderColor:getStatusColor(mod.status)+'44'}]}>
                <Text style={{fontSize:20}}>{mod.icon}</Text>
              </View>
              <View style={{flex:1}}>
                <View style={{flexDirection:'row',alignItems:'center',gap:8,marginBottom:4}}>
                  <Text style={{color:C.text,fontSize:12,fontWeight:'700'}}>{mod.name}</Text>
                  <View style={{backgroundColor:getStatusColor(mod.status)+'18',borderRadius:5,paddingHorizontal:5,paddingVertical:2,borderWidth:1,borderColor:getStatusColor(mod.status)}}>
                    <Text style={{color:getStatusColor(mod.status),fontSize:7,fontWeight:'800',letterSpacing:1}}>{mod.status.toUpperCase()}</Text>
                  </View>
                </View>
                <Text style={{color:C.textFaint,fontSize:10,marginBottom:6}}>{mod.desc}</Text>
                <View style={{height:3,backgroundColor:'rgba(255,255,255,0.06)',borderRadius:2,overflow:'hidden'}}>
                  <View style={{width:mod.score+'%',height:3,backgroundColor:getStatusColor(mod.status),borderRadius:2}}/>
                </View>
              </View>
              <Text style={{color:getStatusColor(mod.status),fontSize:16,fontWeight:'900',marginLeft:10}}>{mod.score}</Text>
            </View>
          ))}

          {contentTab==='threats'&&THREATS.map((t,i)=>(
            <View key={i} style={[S.threatRow,{borderLeftColor:getSevColor(t.severity)}]}>
              <View style={{flex:1}}>
                <Text style={{color:C.text,fontSize:13,fontWeight:'700',marginBottom:5}}>{t.type}</Text>
                <View style={{flexDirection:'row',gap:10,alignItems:'center'}}>
                  <View style={{backgroundColor:getSevColor(t.severity)+'18',borderRadius:5,paddingHorizontal:6,paddingVertical:2,borderWidth:1,borderColor:getSevColor(t.severity)}}>
                    <Text style={{color:getSevColor(t.severity),fontSize:8,fontWeight:'800'}}>{t.severity.toUpperCase()}</Text>
                  </View>
                  <Text style={{color:C.textFaint,fontSize:10}}>{t.time}</Text>
                  {t.resolved&&<Text style={{color:C.accent,fontSize:10}}>✓ Resolved</Text>}
                </View>
              </View>
              {!t.resolved&&(
                <TouchableOpacity onPress={()=>Alert.alert('Alert Reviewed','This threat has been marked as reviewed.')}>
                  <Text style={{color:C.warning,fontSize:12,fontWeight:'700'}}>Review</Text>
                </TouchableOpacity>
              )}
            </View>
          ))}
        </ScrollView>
      </Animated.View>

      <View style={S.navBar}>
        {NAV.map(item=>(
          <TouchableOpacity key={item.id} onPress={()=>handleNav(item)} style={[S.navItem,activeTab===item.id&&S.navItemActive]}>
            <Text style={{fontSize:20,lineHeight:22}}>{item.icon}</Text>
            <Text style={[S.navLabel,{color:activeTab===item.id?C.primary:C.textFaint}]}>{item.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

export default function DashboardScreen() {
  return (
    <ErrorBoundary fallbackTitle="Dashboard Error" fallbackMessage="Security dashboard had a problem.">
      <DashboardContent/>
    </ErrorBoundary>
  );
}

const S = StyleSheet.create({
  container:{flex:1,backgroundColor:'#020B18'},
  glowTop:{position:'absolute',top:-40,alignSelf:'center',width:300,height:300,borderRadius:150,backgroundColor:'rgba(74,159,255,0.06)'},
  header:{flexDirection:'row',alignItems:'center',paddingHorizontal:18,paddingTop:50,paddingBottom:14,gap:10},
  title:{color:'#fff',fontSize:20,fontWeight:'900'},
  backBtn:{width:36,height:36,borderRadius:18,backgroundColor:'rgba(10,22,40,0.8)',justifyContent:'center',alignItems:'center',borderWidth:1,borderColor:'rgba(255,255,255,0.06)'},
  scanBtn:{backgroundColor:'rgba(74,159,255,0.1)',borderRadius:14,paddingHorizontal:14,paddingVertical:8,borderWidth:1,borderColor:'rgba(74,159,255,0.3)'},
  scoreArea:{alignItems:'center',paddingVertical:14},
  scoreRing:{width:148,height:148,borderRadius:74,borderWidth:2,borderColor:'rgba(74,159,255,0.2)',justifyContent:'center',alignItems:'center',overflow:'hidden',position:'relative'},
  radarBg:{position:'absolute',top:0,left:0,right:0,bottom:0,backgroundColor:'rgba(74,159,255,0.04)'},
  radarSweep:{position:'absolute',top:0,left:'50%',width:2,height:'50%',backgroundColor:'rgba(74,159,255,0.5)',transformOrigin:'bottom center'},
  radarRing:{position:'absolute',borderWidth:1,borderColor:'rgba(74,159,255,0.15)'},
  scoreCenter:{alignItems:'center',zIndex:2},
  scoreNum:{color:'#4A9FFF',fontSize:40,fontWeight:'900',lineHeight:42},
  scoreLabel:{color:'rgba(255,255,255,0.3)',fontSize:8,letterSpacing:2,marginTop:2},
  statsRow:{flexDirection:'row',paddingHorizontal:18,gap:8,marginBottom:14},
  statCard:{flex:1,backgroundColor:'rgba(10,22,40,0.8)',borderRadius:14,padding:10,alignItems:'center',borderWidth:1,borderColor:'rgba(255,255,255,0.06)',gap:3},
  tabs:{flexDirection:'row',marginHorizontal:18,backgroundColor:'rgba(6,14,34,0.9)',borderRadius:14,padding:4,marginBottom:12},
  tab:{flex:1,paddingVertical:9,alignItems:'center',borderRadius:10},
  tabActive:{backgroundColor:'rgba(10,22,40,0.9)',borderWidth:1,borderColor:'rgba(74,159,255,0.15)'},
  tabText:{fontSize:10,fontWeight:'800',letterSpacing:1},
  moduleRow:{flexDirection:'row',alignItems:'center',backgroundColor:'rgba(10,22,40,0.8)',borderRadius:16,padding:12,marginBottom:8,borderWidth:1,borderColor:'rgba(255,255,255,0.06)',gap:12},
  modIcon:{width:44,height:44,borderRadius:22,justifyContent:'center',alignItems:'center',borderWidth:1},
  threatRow:{backgroundColor:'rgba(10,22,40,0.8)',borderRadius:16,padding:14,marginBottom:8,borderWidth:1,borderColor:'rgba(255,255,255,0.06)',borderLeftWidth:3,flexDirection:'row',alignItems:'center',gap:12},
  navBar:{position:'absolute',bottom:18,left:14,right:14,backgroundColor:'rgba(4,12,28,0.92)',borderRadius:28,borderWidth:1,borderColor:'rgba(74,159,255,0.12)',paddingVertical:10,paddingHorizontal:6,flexDirection:'row',justifyContent:'space-around',alignItems:'center'},
  navItem:{alignItems:'center',gap:4,paddingVertical:6,paddingHorizontal:12,borderRadius:20,borderWidth:1,borderColor:'transparent'},
  navItemActive:{backgroundColor:'rgba(74,159,255,0.12)',borderColor:'rgba(74,159,255,0.25)'},
  navLabel:{fontSize:9,letterSpacing:0.5,fontWeight:'600'},
});
