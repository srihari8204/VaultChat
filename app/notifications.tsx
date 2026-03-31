import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Animated, Easing, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { ErrorBoundary } from '../components/ErrorBoundary';

const C = { bg:'#FFFFFF',surface:'rgba(10,22,40,0.85)',primary:'#4A9FFF',secondary:'#7C3AED',accent:'#10B981',danger:'#EF4444',warning:'#F59E0B',border:'rgba(74,159,255,0.15)',borderDim:'rgba(255,255,255,0.06)',text:'#FFFFFF',textDim:'rgba(255,255,255,0.5)',textFaint:'rgba(255,255,255,0.22)' };
const NAV = [{id:'chats',icon:'💬',label:'Chats',route:'/(tabs)/chats'},{id:'shield',icon:'🛡️',label:'Shield',route:'/dashboard'},{id:'community',icon:'🌐',label:'Community',route:'/communities'},{id:'vault',icon:'📦',label:'Vault',route:'/filevault'},{id:'alerts',icon:'🔔',label:'Alerts',route:'/notifications'}];

const DEMO_ALERTS = [
  {id:'1',type:'Breach Detected',message:'Your email was found in a new data breach. Change your password immediately.',time:'2m ago',severity:'critical',read:false},
  {id:'2',type:'Login Attempt Blocked',message:'Unknown device tried to access your vault from London, UK.',time:'15m ago',severity:'high',read:false},
  {id:'3',type:'Screenshot Blocked',message:'A screenshot attempt was detected and blocked in secure chat.',time:'1h ago',severity:'medium',read:true},
  {id:'4',type:'Trust Verification',message:'Alice Chen has verified your blockchain TrustScore.',time:'3h ago',severity:'low',read:true},
  {id:'5',type:'Auto-Destruct Triggered',message:'A TimeLock message has been permanently deleted as scheduled.',time:'5h ago',severity:'low',read:true},
];

const SETTINGS = [
  {id:'1',title:'Breach Alerts',desc:'Notify when credentials found on dark web',icon:'🕵️',enabled:true,cat:'Security'},
  {id:'2',title:'Login Attempts',desc:'Alert on unrecognized device access',icon:'🔐',enabled:true,cat:'Security'},
  {id:'3',title:'Screenshot Blocked',desc:'Notify when screen capture is prevented',icon:'🛡️',enabled:true,cat:'Security'},
  {id:'4',title:'Message Received',desc:'New encrypted message notifications',icon:'💬',enabled:true,cat:'Messages'},
  {id:'5',title:'Self-Destruct Warning',desc:'Alert before messages auto-delete',icon:'💣',enabled:true,cat:'Messages'},
  {id:'6',title:'TrustScore Changes',desc:'Alert when trust score is verified on chain',icon:'⛓️',enabled:true,cat:'Vault'},
  {id:'7',title:'Vault Access',desc:'Notify on file vault open events',icon:'📦',enabled:false,cat:'Vault'},
  {id:'8',title:'Community Mentions',desc:'Alert when mentioned in anonymous rooms',icon:'🌐',enabled:true,cat:'Community'},
];

const PANIC_CONTACTS = [
  {id:'1',name:'Sarah (Sister)',phone:'+44 7911 111111',emoji:'👧'},
  {id:'2',name:'James (Friend)',phone:'+44 7922 222222',emoji:'👦'},
  {id:'3',name:'Emergency Services',phone:'999',emoji:'🚨'},
];

function NotificationsContent() {
  const router=useRouter();
  const [settings,setSettings]=useState(SETTINGS.map(s=>({...s})));
  const [alerts,setAlerts]=useState(DEMO_ALERTS.map(a=>({...a})));
  const [activeTab,setActiveTab]=useState('alerts');
  const [navTab,setNavTab]=useState('alerts');
  const [panicArmed,setPanicArmed]=useState(false);
  const [panicCountdown,setPanicCountdown]=useState(0);
  const fadeIn=useRef(new Animated.Value(0)).current;
  const panicAnim=useRef(new Animated.Value(1)).current;
  const glowAnim=useRef(new Animated.Value(0)).current;

  useEffect(()=>{
    Animated.timing(fadeIn,{toValue:1,duration:500,useNativeDriver:true}).start();
    Animated.loop(Animated.sequence([
      Animated.timing(glowAnim,{toValue:1,duration:1800,easing:Easing.inOut(Easing.ease),useNativeDriver:false}),
      Animated.timing(glowAnim,{toValue:0,duration:1800,easing:Easing.inOut(Easing.ease),useNativeDriver:false}),
    ])).start();
  },[fadeIn, glowAnim]);

  useEffect(()=>{
    if(panicCountdown<=0)return;
    if(panicCountdown===1){ Alert.alert('PANIC ALERT SENT','Emergency alert sent to '+PANIC_CONTACTS.length+' trusted contacts. They have been notified of your situation.'); setPanicCountdown(0); setPanicArmed(false); return; }
    const t=setTimeout(()=>setPanicCountdown(c=>c-1),1000);
    return()=>clearTimeout(t);
  },[panicCountdown]);

  const armPanic=()=>{ if(panicArmed){ setPanicArmed(false); setPanicCountdown(0); return; } setPanicArmed(true); setPanicCountdown(3); Animated.sequence([Animated.timing(panicAnim,{toValue:0.94,duration:100,useNativeDriver:true}),Animated.timing(panicAnim,{toValue:1,duration:300,useNativeDriver:true})]).start(); };
  const getSevColor=(s:string)=>s==='critical'?C.danger:s==='high'?C.warning:s==='medium'?C.primary:C.accent;
  const unread=alerts.filter(a=>!a.read).length;
  const categories=[...new Set(SETTINGS.map(s=>s.cat))];
  const handleNav=(item:typeof NAV[0])=>{ setNavTab(item.id); if(item.id!=='alerts')router.push(item.route as any); };
  const panicBorderColor=glowAnim.interpolate({inputRange:[0,1],outputRange:['rgba(239,68,68,0.3)','rgba(239,68,68,0.8)']});

  return (
    <View style={S.container}>
      <LinearGradient colors={['#FFFFFF','#040F20','#060F24']} style={StyleSheet.absoluteFillObject}/>
      <Animated.View style={{flex:1,opacity:fadeIn}}>
        <View style={S.header}>
          <TouchableOpacity onPress={()=>router.back()} style={S.backBtn}><Text style={{color:C.primary,fontSize:18}}>←</Text></TouchableOpacity>
          <View style={{flex:1}}>
            <Text style={S.title}>🔔 Smart Alerts</Text>
            <Text style={{color:C.textFaint,fontSize:9,letterSpacing:2}}>SECURITY NOTIFICATION CENTER</Text>
          </View>
          {unread>0&&<TouchableOpacity onPress={()=>setAlerts(prev=>prev.map(a=>({...a,read:true})))} style={{backgroundColor:'rgba(74,159,255,0.12)',borderRadius:14,paddingHorizontal:12,paddingVertical:6,borderWidth:1,borderColor:C.border}}><Text style={{color:C.primary,fontSize:11,fontWeight:'700'}}>Clear {unread}</Text></TouchableOpacity>}
        </View>

        <View style={S.tabs}>
          {[{id:'alerts',label:'ALERTS'},{id:'settings',label:'SETTINGS'},{id:'panic',label:'🆘 PANIC'}].map(tab=>(
            <TouchableOpacity key={tab.id} onPress={()=>setActiveTab(tab.id)} style={[S.tab,activeTab===tab.id&&S.tabActive]}>
              <View style={{flexDirection:'row',alignItems:'center',gap:4}}>
                <Text style={[S.tabText,{color:activeTab===tab.id?tab.id==='panic'?C.danger:C.primary:C.textFaint}]}>{tab.label}</Text>
                {tab.id==='alerts'&&unread>0&&<View style={{backgroundColor:C.danger,borderRadius:8,minWidth:16,height:16,justifyContent:'center',alignItems:'center',paddingHorizontal:4}}><Text style={{color:'#fff',fontSize:8,fontWeight:'900'}}>{unread}</Text></View>}
              </View>
            </TouchableOpacity>
          ))}
        </View>

        <ScrollView contentContainerStyle={{paddingHorizontal:18,paddingBottom:110}} showsVerticalScrollIndicator={false}>
          {activeTab==='alerts'&&alerts.map((alert,i)=>(
            <TouchableOpacity key={i} onPress={()=>setAlerts(prev=>prev.map(a=>a.id===alert.id?{...a,read:true}:a))} style={[S.alertRow,{borderLeftColor:getSevColor(alert.severity),opacity:alert.read?0.55:1}]}>
              <View style={{flex:1}}>
                <View style={{flexDirection:'row',alignItems:'center',gap:8,marginBottom:4}}>
                  <View style={{backgroundColor:getSevColor(alert.severity)+'18',borderRadius:5,paddingHorizontal:5,paddingVertical:2,borderWidth:1,borderColor:getSevColor(alert.severity)}}><Text style={{color:getSevColor(alert.severity),fontSize:7,fontWeight:'800',letterSpacing:1}}>{alert.severity.toUpperCase()}</Text></View>
                  <Text style={{color:C.text,fontSize:12,fontWeight:'800'}}>{alert.type}</Text>
                  {!alert.read&&<View style={{width:6,height:6,borderRadius:3,backgroundColor:C.primary,marginLeft:'auto'}}/>}
                </View>
                <Text style={{color:C.textDim,fontSize:12,lineHeight:17}}>{alert.message}</Text>
                <Text style={{color:C.textFaint,fontSize:9,marginTop:6}}>{alert.time}</Text>
              </View>
            </TouchableOpacity>
          ))}

          {activeTab==='settings'&&categories.map((cat,ci)=>(
            <View key={ci} style={{marginBottom:20}}>
              <Text style={{color:C.textFaint,fontSize:9,fontWeight:'800',letterSpacing:2,marginBottom:10}}>{cat.toUpperCase()}</Text>
              {settings.filter(s=>s.cat===cat).map((s,i)=>(
                <View key={i} style={S.settingRow}>
                  <View style={{width:40,height:40,borderRadius:20,backgroundColor:'rgba(6,14,34,0.9)',justifyContent:'center',alignItems:'center',borderWidth:1,borderColor:'rgba(255,255,255,0.06)'}}><Text style={{fontSize:20}}>{s.icon}</Text></View>
                  <View style={{flex:1}}>
                    <Text style={{color:C.text,fontSize:13,fontWeight:'700'}}>{s.title}</Text>
                    <Text style={{color:C.textFaint,fontSize:10,marginTop:2}}>{s.desc}</Text>
                  </View>
                  <Switch value={s.enabled} onValueChange={()=>setSettings(prev=>prev.map(x=>x.id===s.id?{...x,enabled:!x.enabled}:x))} trackColor={{false:'rgba(255,255,255,0.06)',true:C.primary+'66'}} thumbColor={s.enabled?C.primary:'rgba(255,255,255,0.3)'}/>
                </View>
              ))}
            </View>
          ))}

          {activeTab==='panic'&&(
            <View style={{gap:16}}>
              <View style={{backgroundColor:'rgba(239,68,68,0.08)',borderRadius:16,padding:16,borderWidth:1,borderColor:'rgba(239,68,68,0.25)'}}>
                <Text style={{color:C.danger,fontSize:12,fontWeight:'800',marginBottom:6}}>🆘 EMERGENCY PANIC BUTTON</Text>
                <Text style={{color:C.textDim,fontSize:12,lineHeight:18}}>Tap to send an emergency alert to all trusted contacts instantly with your location.</Text>
              </View>
              <Animated.View style={{borderRadius:22,borderWidth:2,borderColor:panicBorderColor,overflow:'hidden'}}>
                <TouchableOpacity onPress={armPanic} activeOpacity={0.85}>
                  <LinearGradient colors={panicArmed?['rgba(127,29,29,0.9)','rgba(153,27,27,0.9)']:['rgba(26,10,10,0.9)','rgba(42,10,10,0.9)']} style={{padding:28,alignItems:'center',gap:8}}>
                    <Animated.Text style={{fontSize:52,transform:[{scale:panicAnim}]}}>🆘</Animated.Text>
                    <Text style={{color:C.danger,fontSize:17,fontWeight:'900',letterSpacing:2}}>{panicArmed?'SENDING IN '+panicCountdown+'...':'PANIC ALERT'}</Text>
                    <Text style={{color:C.textDim,fontSize:11}}>{panicArmed?'Tap again to cancel':'Tap to arm — auto-sends in 3 seconds'}</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </Animated.View>
              <Text style={{color:C.textFaint,fontSize:9,fontWeight:'800',letterSpacing:2}}>TRUSTED CONTACTS</Text>
              {PANIC_CONTACTS.map((c,i)=>(
                <View key={i} style={[S.settingRow,{borderColor:'rgba(239,68,68,0.15)'}]}>
                  <Text style={{fontSize:28}}>{c.emoji}</Text>
                  <View style={{flex:1}}>
                    <Text style={{color:C.text,fontSize:13,fontWeight:'700'}}>{c.name}</Text>
                    <Text style={{color:C.textFaint,fontSize:11,marginTop:2}}>{c.phone}</Text>
                  </View>
                  <View style={{backgroundColor:C.accent+'18',borderRadius:8,paddingHorizontal:8,paddingVertical:4,borderWidth:1,borderColor:C.accent}}><Text style={{color:C.accent,fontSize:9,fontWeight:'700'}}>ACTIVE</Text></View>
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      </Animated.View>

      <View style={S.navBar}>
        {NAV.map(item=>(
          <TouchableOpacity key={item.id} onPress={()=>handleNav(item)} style={[S.navItem,navTab===item.id&&S.navItemActive]}>
            <Text style={{fontSize:20,lineHeight:22}}>{item.icon}</Text>
            <Text style={[S.navLabel,{color:navTab===item.id?C.primary:C.textFaint}]}>{item.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

export default function NotificationsScreen() {
  return (<ErrorBoundary fallbackTitle="Notifications Error" fallbackMessage="Notifications had a problem."><NotificationsContent/></ErrorBoundary>);
}

const S = StyleSheet.create({
  container:{flex:1,backgroundColor:'#FFFFFF'},
  header:{flexDirection:'row',alignItems:'center',paddingHorizontal:18,paddingTop:50,paddingBottom:14,gap:10},
  title:{color:'#fff',fontSize:20,fontWeight:'900'},
  backBtn:{width:36,height:36,borderRadius:18,backgroundColor:'rgba(10,22,40,0.8)',justifyContent:'center',alignItems:'center',borderWidth:1,borderColor:'rgba(255,255,255,0.06)'},
  tabs:{flexDirection:'row',marginHorizontal:18,backgroundColor:'rgba(6,14,34,0.9)',borderRadius:14,padding:4,marginBottom:14},
  tab:{flex:1,paddingVertical:9,alignItems:'center',borderRadius:10},
  tabActive:{backgroundColor:'rgba(10,22,40,0.9)',borderWidth:1,borderColor:'rgba(74,159,255,0.15)'},
  tabText:{fontSize:10,fontWeight:'800',letterSpacing:0.5},
  alertRow:{backgroundColor:'rgba(10,22,40,0.8)',borderRadius:16,padding:14,marginBottom:8,borderWidth:1,borderColor:'rgba(255,255,255,0.06)',borderLeftWidth:3},
  settingRow:{flexDirection:'row',alignItems:'center',backgroundColor:'rgba(10,22,40,0.8)',borderRadius:16,padding:14,marginBottom:8,borderWidth:1,borderColor:'rgba(255,255,255,0.06)',gap:12},
  navBar:{position:'absolute',bottom:18,left:14,right:14,backgroundColor:'rgba(4,12,28,0.92)',borderRadius:28,borderWidth:1,borderColor:'rgba(74,159,255,0.12)',paddingVertical:10,paddingHorizontal:6,flexDirection:'row',justifyContent:'space-around',alignItems:'center'},
  navItem:{alignItems:'center',gap:4,paddingVertical:6,paddingHorizontal:12,borderRadius:20,borderWidth:1,borderColor:'transparent'},
  navItemActive:{backgroundColor:'rgba(74,159,255,0.12)',borderColor:'rgba(74,159,255,0.25)'},
  navLabel:{fontSize:9,letterSpacing:0.5,fontWeight:'600'},
});
