import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState , useMemo} from 'react';
import { ActivityIndicator, Animated, Easing, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { getSecurityOverview, type SecurityOverview } from '../lib/security';
import { E2EE_ENABLED } from '../constants/flags';


const NAV = [
  {id:'chats',icon:'💬',label:'Chats',route:'/(tabs)/chats'},
  {id:'shield',icon:'🛡️',label:'Shield',route:'/dashboard'},
  {id:'community',icon:'🌐',label:'Community',route:'/communities'},
  {id:'vault',icon:'📦',label:'Vault',route:'/filevault'},
  {id:'alerts',icon:'🔔',label:'Alerts',route:'/notifications'},
];

type Check = { name: string; icon: string; ok: boolean; desc: string };

function buildChecks(ov: SecurityOverview): Check[] {
  return [
    { name: 'End-to-End Encryption', icon: '🔐', ok: E2EE_ENABLED && ov.e2eeKeyPublished,
      desc: E2EE_ENABLED ? (ov.e2eeKeyPublished ? 'Keys published — direct chats are encrypted' : 'Open a chat to publish your keys') : 'Encrypted in transit (TLS)' },
    { name: 'Last Seen Hidden', icon: '👁️', ok: ov.settings.lastSeenVisible === false,
      desc: ov.settings.lastSeenVisible === false ? 'Your last-seen is private' : 'Your last-seen is visible to contacts' },
    { name: 'Read Receipts Off', icon: '✓', ok: ov.settings.readReceipts === false,
      desc: ov.settings.readReceipts === false ? 'Read receipts are off' : 'Read receipts are on' },
    { name: 'Undiscoverable', icon: '🕵️', ok: ov.settings.discoverable === false,
      desc: ov.settings.discoverable === false ? "You're not discoverable by search" : "You're discoverable by phone/handle" },
    { name: 'Blocked Contacts', icon: '🚫', ok: true,
      desc: `${ov.blockedContacts} contact${ov.blockedContacts === 1 ? '' : 's'} blocked` },
    { name: 'Active Sessions', icon: '📱', ok: ov.activeSessions <= 3,
      desc: `${ov.activeSessions} signed-in session${ov.activeSessions === 1 ? '' : 's'} · ${ov.linkedDevices} device${ov.linkedDevices === 1 ? '' : 's'}` },
  ];
}

function accountAge(iso: string | null): string {
  if (!iso) return '—';
  const days = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
  if (days < 1) return 'today';
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

function DashboardContent() {
  const S = useS();
  const { colors } = useTheme();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState('shield');
  const [overview, setOverview] = useState<SecurityOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fadeAnim  = useRef(new Animated.Value(0)).current;
  const radarAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setOverview(await getSecurityOverview()); }
    catch (e: any) { setError(e?.message ?? 'Failed to load'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    Animated.timing(fadeAnim,{toValue:1,duration:500,useNativeDriver:true}).start();
    Animated.loop(Animated.timing(radarAnim,{toValue:1,duration:3500,easing:Easing.linear,useNativeDriver:true})).start();
    Animated.loop(Animated.sequence([
      Animated.timing(pulseAnim,{toValue:1.04,duration:2500,easing:Easing.inOut(Easing.ease),useNativeDriver:true}),
      Animated.timing(pulseAnim,{toValue:1,duration:2500,easing:Easing.inOut(Easing.ease),useNativeDriver:true}),
    ])).start();
  }, [load, fadeAnim, pulseAnim, radarAnim]);

  const handleNav = (item: typeof NAV[0]) => {
    setActiveTab(item.id);
    if (item.id !== 'shield') router.push(item.route as any);
  };

  const checks = overview ? buildChecks(overview) : [];
  const score = checks.length ? Math.round((checks.filter(c => c.ok).length / checks.length) * 100) : 0;
  const scoreColor = score >= 80 ? colors.accent : score >= 50 ? colors.accent : colors.danger;
  const radarDeg = radarAnim.interpolate({inputRange:[0,1],outputRange:['0deg','360deg']});

  return (
    <View style={S.container}>
      <LinearGradient colors={['#FFFFFF','#040F20','#060F24']} style={StyleSheet.absoluteFillObject}/>
      <View style={S.glowTop}/>

      <Animated.View style={[{flex:1},{ opacity:fadeAnim}]}>
        <View style={S.header}>
          <TouchableOpacity onPress={()=>router.back()} style={S.backBtn}><Ionicons name="arrow-back" size={24} color={colors.primary} /></TouchableOpacity>
          <View style={{flex:1}}>
            <Text style={S.title}>🛡️ Security Hub</Text>
            <Text style={{color:colors.textFaint,fontSize:9,letterSpacing:2}}>YOUR ACCOUNT SECURITY</Text>
          </View>
          <TouchableOpacity onPress={load} style={[S.scanBtn,loading&&{opacity:0.65}]}>
            <Text style={{color:colors.primary,fontSize:10,fontWeight:'800',letterSpacing:1}}>{loading?'…':'REFRESH'}</Text>
          </TouchableOpacity>
        </View>

        <View style={S.scoreArea}>
          <Animated.View style={[S.scoreRing,{transform:[{scale:pulseAnim}]}]}>
            <View style={S.radarBg}/>
            <Animated.View style={[S.radarSweep,{transform:[{rotate:radarDeg}]}]}/>
            <View style={[S.radarRing,{width:100,height:100,borderRadius:50}]}/>
            <View style={[S.radarRing,{width:68,height:68,borderRadius:34}]}/>
            <View style={S.scoreCenter}>
              <Text style={[S.scoreNum,{color:scoreColor}]}>{overview ? score : '—'}</Text>
              <Text style={S.scoreLabel}>SECURITY SCORE</Text>
              <View style={{flexDirection:'row',alignItems:'center',gap:4,marginTop:3}}>
                <View style={{width:6,height:6,borderRadius:3,backgroundColor:scoreColor}}/>
                <Text style={{color:scoreColor,fontSize:9,fontWeight:'700'}}>{score>=80?'STRONG':score>=50?'FAIR':'REVIEW'}</Text>
              </View>
            </View>
          </Animated.View>
        </View>

        <View style={S.statsRow}>
          {[
            {label:'Active Sessions',value:overview?String(overview.activeSessions):'—',icon:'📱',color:colors.primary},
            {label:'Devices',value:overview?String(overview.linkedDevices):'—',icon:'💻',color:colors.textDim},
            {label:'Blocked',value:overview?String(overview.blockedContacts):'—',icon:'🚫',color:colors.accent},
            {label:'Account Age',value:overview?accountAge(overview.accountCreatedAt):'—',icon:'🗓️',color:colors.accent},
          ].map((s,i)=>(
            <View key={i} style={S.statCard}>
              <Text style={{fontSize:16}}>{s.icon}</Text>
              <Text style={{color:s.color,fontSize:15,fontWeight:'900'}}>{s.value}</Text>
              <Text style={{color:colors.textFaint,fontSize:7,letterSpacing:0.5,textAlign:'center',marginTop:1}}>{s.label}</Text>
            </View>
          ))}
        </View>

        <ScrollView contentContainerStyle={{paddingHorizontal:18,paddingBottom:110,paddingTop:6}} showsVerticalScrollIndicator={false}>
          {loading && <ActivityIndicator color={colors.primary} style={{marginTop:30}} />}
          {error && !loading && <Text style={{color:colors.danger,textAlign:'center',marginTop:24,fontSize:13}}>{error}</Text>}
          {!loading && !error && checks.map((c,i)=>{
            const col = c.ok ? colors.accent : colors.accent;
            return (
              <View key={i} style={S.moduleRow}>
                <View style={[S.modIcon,{backgroundColor:col+'18',borderColor:col+'44'}]}>
                  <Text style={{fontSize:20}}>{c.icon}</Text>
                </View>
                <View style={{flex:1}}>
                  <View style={{flexDirection:'row',alignItems:'center',gap:8,marginBottom:4}}>
                    <Text style={{color:colors.text,fontSize:12,fontWeight:'700'}}>{c.name}</Text>
                    <View style={{backgroundColor:col+'18',borderRadius:5,paddingHorizontal:5,paddingVertical:2,borderWidth:1,borderColor:col}}>
                      <Text style={{color:col,fontSize:7,fontWeight:'800',letterSpacing:1}}>{c.ok?'OK':'REVIEW'}</Text>
                    </View>
                  </View>
                  <Text style={{color:colors.textFaint,fontSize:10}}>{c.desc}</Text>
                </View>
              </View>
            );
          })}
        </ScrollView>
      </Animated.View>

      <View style={S.navBar}>
        {NAV.map(item=>(
          <TouchableOpacity key={item.id} onPress={()=>handleNav(item)} style={[S.navItem,activeTab===item.id&&S.navItemActive]}>
            <Text style={{fontSize:20,lineHeight:22}}>{item.icon}</Text>
            <Text style={[S.navLabel,{color:activeTab===item.id?colors.primary:colors.textFaint}]}>{item.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function DashboardScreen() {
  const { colors } = useTheme();
  const S = useS();
  return (
    <ErrorBoundary fallbackTitle="Dashboard Error" fallbackMessage="Security dashboard had a problem.">
      <DashboardContent/>
    </ErrorBoundary>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container:{flex:1,backgroundColor:'#FFFFFF'},
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
  moduleRow:{flexDirection:'row',alignItems:'center',backgroundColor:'rgba(10,22,40,0.8)',borderRadius:16,padding:12,marginBottom:8,borderWidth:1,borderColor:'rgba(255,255,255,0.06)',gap:12},
  modIcon:{width:44,height:44,borderRadius:22,justifyContent:'center',alignItems:'center',borderWidth:1},
  navBar:{position:'absolute',bottom:18,left:14,right:14,backgroundColor:'rgba(4,12,28,0.92)',borderRadius:28,borderWidth:1,borderColor:'rgba(74,159,255,0.12)',paddingVertical:10,paddingHorizontal:6,flexDirection:'row',justifyContent:'space-around',alignItems:'center'},
  navItem:{alignItems:'center',gap:4,paddingVertical:6,paddingHorizontal:12,borderRadius:20,borderWidth:1,borderColor:'transparent'},
  navItemActive:{backgroundColor:'rgba(74,159,255,0.12)',borderColor:'rgba(74,159,255,0.25)'},
  navLabel:{fontSize:9,letterSpacing:0.5,fontWeight:'600'},
});
