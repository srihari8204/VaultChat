import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Animated, Easing, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { ErrorBoundary } from '../components/ErrorBoundary';

const C = { bg:'#020B18',surface:'rgba(10,22,40,0.85)',primary:'#4A9FFF',secondary:'#7C3AED',accent:'#10B981',danger:'#EF4444',warning:'#F59E0B',border:'rgba(74,159,255,0.15)',borderDim:'rgba(255,255,255,0.06)',text:'#FFFFFF',textDim:'rgba(255,255,255,0.5)',textFaint:'rgba(255,255,255,0.22)' };
const NAV = [{id:'chats',icon:'💬',label:'Chats',route:'/chats'},{id:'shield',icon:'🛡️',label:'Shield',route:'/dashboard'},{id:'community',icon:'🌐',label:'Community',route:'/communities'},{id:'vault',icon:'📦',label:'Vault',route:'/filevault'},{id:'alerts',icon:'🔔',label:'Alerts',route:'/notifications'}];

const BREACH_ALERTS = [
  {id:'1',source:'LinkedIn 2024',email:'user@email.com',severity:'critical',date:'2 days ago',exposed:['Password (plain text)','Email','Phone number','Employment history'],fixed:false},
  {id:'2',source:'RockYou2024',email:'user@email.com',severity:'high',date:'1 week ago',exposed:['Password (hashed)','Email address'],fixed:false},
  {id:'3',source:'Adobe 2023',email:'alt@email.com',severity:'medium',date:'3 months ago',exposed:['Email address','Username'],fixed:true},
  {id:'4',source:'Twitter 2022',email:'user@email.com',severity:'low',date:'1 year ago',exposed:['Email address'],fixed:true},
];

const MONITORED = [
  {id:'1',value:'user@email.com',type:'Email',status:'active',breachCount:3},
  {id:'2',value:'+44 7911 ****',type:'Phone',status:'active',breachCount:1},
  {id:'3',value:'username123',type:'Username',status:'active',breachCount:0},
];

function BreachGuardContent() {
  const router=useRouter();
  const [activeTab,setActiveTab]=useState<'alerts'|'monitor'|'scanner'>('alerts');
  const [navTab,setNavTab]=useState('shield');
  const [alerts,setAlerts]=useState(BREACH_ALERTS.map(a=>({...a})));
  const [monitored,setMonitored]=useState(MONITORED.map(m=>({...m})));
  const [scanning,setScanning]=useState(false);
  const [scanProgress,setScanProgress]=useState(0);
  const [scanPhase,setScanPhase]=useState('');
  const [showAddMonitor,setShowAddMonitor]=useState(false);
  const [newMonitorValue,setNewMonitorValue]=useState('');
  const [newMonitorType,setNewMonitorType]=useState('Email');
  const fadeIn=useRef(new Animated.Value(0)).current;
  const scanAnim=useRef(new Animated.Value(0)).current;
  const pulseAnim=useRef(new Animated.Value(1)).current;

  useEffect(()=>{
    Animated.timing(fadeIn,{toValue:1,duration:500,useNativeDriver:true}).start();
    Animated.loop(Animated.sequence([
      Animated.timing(pulseAnim,{toValue:1.05,duration:2000,easing:Easing.inOut(Easing.ease),useNativeDriver:true}),
      Animated.timing(pulseAnim,{toValue:1,duration:2000,easing:Easing.inOut(Easing.ease),useNativeDriver:true}),
    ])).start();
  },[fadeIn, pulseAnim]);

  const runScan=()=>{ if(scanning)return; setScanning(true); setScanProgress(0); const phases=['Querying HaveIBeenPwned...','Checking DeHashed database...','Scanning IntelligenceX...','Analyzing breach patterns...','Finalizing report...']; let p=0,phaseIdx=0; Animated.loop(Animated.timing(scanAnim,{toValue:1,duration:1200,easing:Easing.linear,useNativeDriver:true})).start(); const iv=setInterval(()=>{ p+=Math.random()*3+1; setScanProgress(Math.min(p,100)); const idx=Math.floor(p/20); if(idx!==phaseIdx&&idx<phases.length){ phaseIdx=idx; setScanPhase(phases[idx]); } if(p>=100){ clearInterval(iv); scanAnim.stopAnimation(); setScanning(false); setScanPhase('Scan complete'); Alert.alert('Scan Complete','Dark web scan finished. Found '+alerts.filter(a=>!a.fixed).length+' active breach alerts requiring attention.'); } },80); };

  const dismissAlert=(id:string)=>{ setAlerts(prev=>prev.map(a=>a.id===id?{...a,fixed:true}:a)); };
  const addMonitor=()=>{ if(!newMonitorValue.trim())return; setMonitored(prev=>[...prev,{id:Date.now().toString(),value:newMonitorValue.trim(),type:newMonitorType,status:'active',breachCount:0}]); setShowAddMonitor(false); setNewMonitorValue(''); Alert.alert('Monitoring Added','We will alert you if this '+newMonitorType.toLowerCase()+' appears in any future breaches.'); };
  const getSevColor=(s:string)=>s==='critical'?C.danger:s==='high'?C.warning:s==='medium'?C.primary:C.accent;
  const handleNav=(item:typeof NAV[0])=>{ setNavTab(item.id); if(item.id!=='shield')router.push(item.route as any); };
  const activeBreaches=alerts.filter(a=>!a.fixed).length;
  const scanDeg=scanAnim.interpolate({inputRange:[0,1],outputRange:['0deg','360deg']});

  return (
    <View style={S.container}>
      <LinearGradient colors={['#020B18','#040F20','#060F24']} style={StyleSheet.absoluteFillObject}/>
      <View style={{position:'absolute',top:-40,alignSelf:'center',width:280,height:280,borderRadius:140,backgroundColor:activeBreaches>0?'rgba(239,68,68,0.05)':'rgba(16,185,129,0.04)'}}/>
      <Animated.View style={{flex:1,opacity:fadeIn}}>
        <View style={S.header}>
          <TouchableOpacity onPress={()=>router.back()} style={S.backBtn}><Text style={{color:C.primary,fontSize:18}}>←</Text></TouchableOpacity>
          <View style={{flex:1}}><Text style={S.title}>🕵️ Dark Web Guard</Text><Text style={{color:C.textFaint,fontSize:9,letterSpacing:2}}>BREACH MONITORING ACTIVE</Text></View>
          <TouchableOpacity onPress={runScan} style={[{backgroundColor:scanning?'rgba(239,68,68,0.12)':'rgba(74,159,255,0.12)',borderRadius:14,paddingHorizontal:14,paddingVertical:8,borderWidth:1,borderColor:scanning?C.danger+'44':C.border},scanning&&{opacity:0.8}]}>
            <Text style={{color:scanning?C.danger:C.primary,fontSize:10,fontWeight:'800',letterSpacing:1}}>{scanning?'SCANNING...':'SCAN NOW'}</Text>
          </TouchableOpacity>
        </View>

        <Animated.View style={[S.statusCard,{borderColor:activeBreaches>0?C.danger+'33':C.accent+'33',transform:[{scale:pulseAnim}]}]}>
          <LinearGradient colors={activeBreaches>0?['rgba(239,68,68,0.12)','rgba(239,68,68,0.06)']:['rgba(16,185,129,0.12)','rgba(16,185,129,0.06)']} style={S.statusCardInner}>
            <Text style={{fontSize:36}}>{activeBreaches>0?'🚨':'🛡️'}</Text>
            <View style={{flex:1}}>
              <Text style={{color:activeBreaches>0?C.danger:C.accent,fontSize:15,fontWeight:'900'}}>{activeBreaches>0?activeBreaches+' ACTIVE BREACH'+(activeBreaches>1?'ES':''):'YOU ARE PROTECTED'}</Text>
              <Text style={{color:C.textDim,fontSize:11,marginTop:3}}>{activeBreaches>0?'Immediate action required':'No new breaches detected'}</Text>
            </View>
            {scanning&&(
              <Animated.View style={{width:28,height:28,borderRadius:14,borderWidth:2,borderColor:C.danger,borderTopColor:'transparent',transform:[{rotate:scanDeg}]}}/>
            )}
          </LinearGradient>
        </Animated.View>

        {scanning&&(
          <View style={{marginHorizontal:18,marginBottom:10}}>
            <View style={{height:3,backgroundColor:'rgba(255,255,255,0.06)',borderRadius:2,overflow:'hidden',marginBottom:5}}>
              <View style={{width:(scanProgress+'%') as any,height:3,backgroundColor:C.primary,borderRadius:2}}/>
            </View>
            <Text style={{color:C.textFaint,fontSize:9,letterSpacing:1}}>{scanPhase}</Text>
          </View>
        )}

        <View style={S.tabs}>
          {[{id:'alerts',label:'BREACHES'},{id:'monitor',label:'MONITORED'},{id:'scanner',label:'SOURCES'}].map(tab=>(
            <TouchableOpacity key={tab.id} onPress={()=>setActiveTab(tab.id as any)} style={[S.tab,activeTab===tab.id&&S.tabActive]}>
              <Text style={[S.tabText,{color:activeTab===tab.id?C.primary:C.textFaint}]}>{tab.label}</Text>
              {tab.id==='alerts'&&activeBreaches>0&&<View style={{backgroundColor:C.danger,borderRadius:8,minWidth:16,height:16,justifyContent:'center',alignItems:'center',paddingHorizontal:4,marginLeft:4}}><Text style={{color:'#fff',fontSize:8,fontWeight:'900'}}>{activeBreaches}</Text></View>}
            </TouchableOpacity>
          ))}
        </View>

        <ScrollView contentContainerStyle={{paddingHorizontal:18,paddingBottom:110}} showsVerticalScrollIndicator={false}>
          {activeTab==='alerts'&&alerts.map((alert,i)=>(
            <View key={i} style={[S.alertCard,{borderLeftColor:getSevColor(alert.severity),opacity:alert.fixed?0.5:1}]}>
              <View style={{flexDirection:'row',alignItems:'center',gap:8,marginBottom:10}}>
                <View style={{backgroundColor:getSevColor(alert.severity)+'18',borderRadius:6,paddingHorizontal:6,paddingVertical:3,borderWidth:1,borderColor:getSevColor(alert.severity)}}><Text style={{color:getSevColor(alert.severity),fontSize:8,fontWeight:'800',letterSpacing:1}}>{alert.severity.toUpperCase()}</Text></View>
                <Text style={{color:C.text,fontSize:13,fontWeight:'800',flex:1}}>{alert.source}</Text>
                <Text style={{color:C.textFaint,fontSize:10}}>{alert.date}</Text>
              </View>
              <Text style={{color:C.textFaint,fontSize:10,marginBottom:8}}>Exposed data: {alert.exposed.join(', ')}</Text>
              {!alert.fixed&&(
                <TouchableOpacity onPress={()=>dismissAlert(alert.id)} style={{backgroundColor:C.accent+'15',borderRadius:12,paddingVertical:9,alignItems:'center',borderWidth:1,borderColor:C.accent+'44'}}>
                  <Text style={{color:C.accent,fontSize:12,fontWeight:'700'}}>✓ Mark as Resolved</Text>
                </TouchableOpacity>
              )}
              {alert.fixed&&<Text style={{color:C.accent,fontSize:11}}>✓ Resolved</Text>}
            </View>
          ))}

          {activeTab==='monitor'&&(
            <>
              <TouchableOpacity onPress={()=>setShowAddMonitor(true)} style={{flexDirection:'row',alignItems:'center',backgroundColor:'rgba(74,159,255,0.1)',borderRadius:16,padding:14,marginBottom:12,borderWidth:1,borderColor:C.border,gap:10}}>
                <Text style={{fontSize:22}}>➕</Text>
                <View style={{flex:1}}><Text style={{color:C.primary,fontSize:13,fontWeight:'700'}}>Add to Monitoring</Text><Text style={{color:C.textFaint,fontSize:11,marginTop:1}}>Email, phone, username or password</Text></View>
              </TouchableOpacity>
              {monitored.map((item,i)=>(
                <View key={i} style={[S.monitorRow,{borderColor:item.breachCount>0?C.warning+'33':C.border}]}>
                  <View style={{width:42,height:42,borderRadius:21,backgroundColor:item.breachCount>0?C.warning+'18':C.accent+'18',borderWidth:1,borderColor:item.breachCount>0?C.warning+'55':C.accent+'55',justifyContent:'center',alignItems:'center'}}>
                    <Text style={{fontSize:20}}>{item.type==='Email'?'📧':item.type==='Phone'?'📱':'👤'}</Text>
                  </View>
                  <View style={{flex:1}}>
                    <Text style={{color:C.text,fontSize:13,fontWeight:'700'}}>{item.value}</Text>
                    <Text style={{color:C.textFaint,fontSize:10,marginTop:2}}>{item.type} · {item.breachCount>0?item.breachCount+' breach'+(item.breachCount>1?'es':''):'Clean'}</Text>
                  </View>
                  <View style={{backgroundColor:C.accent+'18',borderRadius:8,paddingHorizontal:8,paddingVertical:4,borderWidth:1,borderColor:C.accent+'44'}}><Text style={{color:C.accent,fontSize:9,fontWeight:'700'}}>ACTIVE</Text></View>
                </View>
              ))}
            </>
          )}

          {activeTab==='scanner'&&(
            <View style={{gap:10}}>
              {[
                {name:'HaveIBeenPwned',desc:'Most trusted breach database — 12B+ records',icon:'🔍',status:'Connected',color:C.accent},
                {name:'DeHashed',desc:'Real-time breach intelligence platform',icon:'🗄️',status:'Connected',color:C.primary},
                {name:'IntelligenceX',desc:'Deep web and darknet archive',icon:'🌑',status:'Demo Mode',color:C.warning},
                {name:'LeakCheck',desc:'Password and credential monitoring',icon:'🔑',status:'Demo Mode',color:C.textDim},
              ].map((src,i)=>(
                <View key={i} style={{backgroundColor:'rgba(10,22,40,0.8)',borderRadius:16,padding:14,borderWidth:1,borderColor:'rgba(255,255,255,0.06)',flexDirection:'row',alignItems:'center',gap:12}}>
                  <View style={{width:44,height:44,borderRadius:22,backgroundColor:src.color+'18',borderWidth:1,borderColor:src.color+'44',justifyContent:'center',alignItems:'center'}}><Text style={{fontSize:22}}>{src.icon}</Text></View>
                  <View style={{flex:1}}>
                    <Text style={{color:C.text,fontSize:13,fontWeight:'700'}}>{src.name}</Text>
                    <Text style={{color:C.textFaint,fontSize:10,marginTop:2}}>{src.desc}</Text>
                  </View>
                  <View style={{backgroundColor:src.color+'18',borderRadius:8,paddingHorizontal:8,paddingVertical:4,borderWidth:1,borderColor:src.color+'44'}}><Text style={{color:src.color,fontSize:9,fontWeight:'700'}}>{src.status.toUpperCase()}</Text></View>
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      </Animated.View>

      <Modal visible={showAddMonitor} transparent animationType="slide">
        <TouchableOpacity style={{flex:1,backgroundColor:'rgba(0,0,0,0.6)'}} activeOpacity={1} onPress={()=>setShowAddMonitor(false)}>
          <View style={{position:'absolute',bottom:0,left:0,right:0}}>
            <LinearGradient colors={['rgba(10,22,40,0.99)','rgba(6,14,34,0.99)']} style={{borderTopLeftRadius:28,borderTopRightRadius:28,padding:24,paddingBottom:44,borderWidth:1,borderColor:'rgba(74,159,255,0.12)'}}>
              <Text style={{color:C.text,fontSize:18,fontWeight:'900',marginBottom:20}}>Add to Monitoring</Text>
              <View style={{flexDirection:'row',gap:8,marginBottom:14}}>
                {['Email','Phone','Username'].map(type=>(<TouchableOpacity key={type} onPress={()=>setNewMonitorType(type)} style={{flex:1,backgroundColor:newMonitorType===type?C.primary+'22':'rgba(6,14,34,0.9)',borderRadius:12,paddingVertical:10,alignItems:'center',borderWidth:1.5,borderColor:newMonitorType===type?C.primary:'rgba(255,255,255,0.08)'}}><Text style={{color:newMonitorType===type?C.primary:C.textDim,fontSize:12,fontWeight:'700'}}>{type}</Text></TouchableOpacity>))}
              </View>
              <TextInput value={newMonitorValue} onChangeText={setNewMonitorValue} placeholder={newMonitorType==='Email'?'email@example.com':newMonitorType==='Phone'?'+44 7900 000000':'username'} placeholderTextColor={C.textFaint} style={[S.input,{marginBottom:16}]}/>
              <View style={{backgroundColor:'rgba(74,159,255,0.08)',borderRadius:12,padding:12,marginBottom:16,borderWidth:1,borderColor:'rgba(74,159,255,0.15)'}}><Text style={{color:C.primary,fontSize:11,lineHeight:17}}>🔐 Your data is hashed before checking. We never store your actual credentials.</Text></View>
              <TouchableOpacity onPress={addMonitor}><LinearGradient colors={[C.primary,C.secondary]} style={{borderRadius:16,paddingVertical:14,alignItems:'center'}}><Text style={{color:'#fff',fontSize:15,fontWeight:'900'}}>Start Monitoring</Text></LinearGradient></TouchableOpacity>
            </LinearGradient>
          </View>
        </TouchableOpacity>
      </Modal>

      <View style={S.navBar}>
        {NAV.map(item=>(<TouchableOpacity key={item.id} onPress={()=>handleNav(item)} style={[S.navItem,navTab===item.id&&S.navItemActive]}><Text style={{fontSize:20,lineHeight:22}}>{item.icon}</Text><Text style={[S.navLabel,{color:navTab===item.id?C.primary:C.textFaint}]}>{item.label}</Text></TouchableOpacity>))}
      </View>
    </View>
  );
}

export default function BreachGuardScreen() {
  return (<ErrorBoundary fallbackTitle="BreachGuard Error" fallbackMessage="Dark Web Guard had a problem."><BreachGuardContent/></ErrorBoundary>);
}

const S = StyleSheet.create({
  container:{flex:1,backgroundColor:'#020B18'},
  header:{flexDirection:'row',alignItems:'center',paddingHorizontal:18,paddingTop:50,paddingBottom:14,gap:10},
  title:{color:'#fff',fontSize:20,fontWeight:'900'},
  backBtn:{width:36,height:36,borderRadius:18,backgroundColor:'rgba(10,22,40,0.8)',justifyContent:'center',alignItems:'center',borderWidth:1,borderColor:'rgba(255,255,255,0.06)'},
  statusCard:{marginHorizontal:18,marginBottom:12,borderRadius:18,borderWidth:1,overflow:'hidden'},
  statusCardInner:{flexDirection:'row',alignItems:'center',gap:14,padding:16},
  tabs:{flexDirection:'row',marginHorizontal:18,backgroundColor:'rgba(6,14,34,0.9)',borderRadius:14,padding:4,marginBottom:12},
  tab:{flex:1,paddingVertical:9,alignItems:'center',borderRadius:10,flexDirection:'row',justifyContent:'center'},
  tabActive:{backgroundColor:'rgba(10,22,40,0.9)',borderWidth:1,borderColor:'rgba(74,159,255,0.15)'},
  tabText:{fontSize:10,fontWeight:'800',letterSpacing:0.5},
  alertCard:{backgroundColor:'rgba(10,22,40,0.8)',borderRadius:16,padding:14,marginBottom:10,borderWidth:1,borderColor:'rgba(255,255,255,0.06)',borderLeftWidth:3},
  monitorRow:{flexDirection:'row',alignItems:'center',backgroundColor:'rgba(10,22,40,0.8)',borderRadius:16,padding:14,marginBottom:8,borderWidth:1,gap:12},
  input:{backgroundColor:'rgba(6,14,34,0.9)',borderRadius:14,padding:15,color:'#fff',fontSize:14,borderWidth:1,borderColor:'rgba(255,255,255,0.08)'},
  navBar:{position:'absolute',bottom:18,left:14,right:14,backgroundColor:'rgba(4,12,28,0.92)',borderRadius:28,borderWidth:1,borderColor:'rgba(74,159,255,0.12)',paddingVertical:10,paddingHorizontal:6,flexDirection:'row',justifyContent:'space-around',alignItems:'center'},
  navItem:{alignItems:'center',gap:4,paddingVertical:6,paddingHorizontal:12,borderRadius:20,borderWidth:1,borderColor:'transparent'},
  navItemActive:{backgroundColor:'rgba(74,159,255,0.12)',borderColor:'rgba(74,159,255,0.25)'},
  navLabel:{fontSize:9,letterSpacing:0.5,fontWeight:'600'},
});
