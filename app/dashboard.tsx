import { HEADER_TOP, SCREEN_BOTTOM } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState , useMemo} from 'react';
import { ActivityIndicator, Animated, Easing, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { AppText as Text } from '../components/ui/Text';
import { AuroraBackground } from '../components/ui/AuroraBackground';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { readCache, writeCache } from '../lib/localCache';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { getSecurityOverview, type SecurityOverview } from '../lib/security';
import { E2EE_ENABLED } from '../constants/flags';


const NAV = [
  {id:'chats',icon:'chatbubbles-outline',label:'Chats',route:'/(tabs)/chats'},
  {id:'shield',icon:'shield-checkmark-outline',label:'Shield',route:'/dashboard'},
  {id:'community',icon:'people-outline',label:'Community',route:'/communities'},
  {id:'vault',icon:'file-tray-full-outline',label:'Vault',route:'/filevault'},
  {id:'alerts',icon:'notifications-outline',label:'Alerts',route:'/notifications'},
] as const;

type Check = { name: string; icon: React.ComponentProps<typeof Ionicons>['name']; ok: boolean; desc: string };

function buildChecks(ov: SecurityOverview): Check[] {
  return [
    { name: 'End-to-End Encryption', icon: 'lock-closed-outline', ok: E2EE_ENABLED && ov.e2eeKeyPublished,
      desc: E2EE_ENABLED ? (ov.e2eeKeyPublished ? 'Keys published — direct chats are encrypted' : 'Open a chat to publish your keys') : 'Encrypted in transit (TLS)' },
    { name: 'Last Seen Hidden', icon: 'eye-off-outline', ok: ov.settings.lastSeenVisible === false,
      desc: ov.settings.lastSeenVisible === false ? 'Your last-seen is private' : 'Your last-seen is visible to contacts' },
    { name: 'Read Receipts Off', icon: 'checkmark-done-outline', ok: ov.settings.readReceipts === false,
      desc: ov.settings.readReceipts === false ? 'Read receipts are off' : 'Read receipts are on' },
    { name: 'Undiscoverable', icon: 'person-remove-outline', ok: ov.settings.discoverable === false,
      desc: ov.settings.discoverable === false ? "You're not discoverable by search" : "You're discoverable by phone/handle" },
    { name: 'Blocked Contacts', icon: 'ban-outline', ok: true,
      desc: `${ov.blockedContacts} contact${ov.blockedContacts === 1 ? '' : 's'} blocked` },
    // `ov.linkedDevices` is deliberately NOT shown here or in the stats row.
    //
    // The server counts rows in `devices` (user.go:332) and those are PUSH
    // REGISTRATIONS, not devices: one phone with a stale Expo token alongside a
    // fresh one reads as "2 devices", and a reinstall adds another. So the number
    // was wrong in the direction that alarms people — on a security screen, which
    // is the worst place to be wrong — and there is no device-management UI for it
    // to lead to anyway.
    //
    // Sessions ARE real: refresh_tokens with revoked_at IS NULL and expires_at in
    // the future, and /user/sessions can revoke them one at a time or all at once.
    // Show a device count again when per-device identity exists and means
    // something (openspec: global-device-support / docs/LINKED_DEVICES_PLAN.md).
    { name: 'Active Sessions', icon: 'phone-portrait-outline', ok: ov.activeSessions <= 3,
      desc: `${ov.activeSessions} signed-in session${ov.activeSessions === 1 ? '' : 's'}` },
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
    setError(null);
    // Local-first: paint last-known security overview instantly, then refresh.
    const cached = await readCache<SecurityOverview>('dashboard');
    if (cached) { setOverview(cached); setLoading(false); }
    else setLoading(true);
    try {
      const fresh = await getSecurityOverview();
      setOverview(fresh);
      writeCache('dashboard', fresh);
    }
    catch (e: any) { if (!cached) setError(e?.message ?? 'Failed to load'); }
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

  const handleNav = (item: (typeof NAV)[number]) => {
    setActiveTab(item.id);
    if (item.id !== 'shield') router.push(item.route as any);
  };

  const checks = overview ? buildChecks(overview) : [];
  const score = checks.length ? Math.round((checks.filter(c => c.ok).length / checks.length) * 100) : 0;
  const scoreColor = score >= 80 ? colors.accent : score >= 50 ? colors.accent : colors.danger;
  const radarDeg = radarAnim.interpolate({inputRange:[0,1],outputRange:['0deg','360deg']});

  return (
    <View style={S.container}>
      <AuroraBackground variant="profile" />

      <Animated.View style={[{flex:1},{ opacity:fadeAnim}]}>
        <View style={S.header}>
          <TouchableOpacity hitSlop={4} accessibilityRole="button" accessibilityLabel="Back" onPress={()=>router.back()} style={S.backBtn}><Ionicons name="arrow-back" size={24} color={colors.primary} /></TouchableOpacity>
          <View style={{flex:1}}>
            <Text variant="h2" style={S.title}>Security Hub</Text>
            <Text style={{color:colors.textDim,fontSize:12}}>Your account security</Text>
          </View>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Refresh security overview" onPress={load} style={[S.scanBtn,loading&&{opacity:0.65}]}>
            <Ionicons name="refresh-outline" size={22} color={colors.primary} />
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={S.content} showsVerticalScrollIndicator={false}>
        <View style={S.scoreArea}>
          <Animated.View style={[S.scoreRing,{transform:[{scale:pulseAnim}]}]}>
            <View style={S.radarBg}/>
            <Animated.View style={[S.radarSweep,{transform:[{rotate:radarDeg}]}]}/>
            <View style={[S.radarRing,{width:100,height:100,borderRadius:50}]}/>
            <View style={[S.radarRing,{width:68,height:68,borderRadius:34}]}/>
            <View style={S.scoreCenter}>
              <Text style={[S.scoreNum,{color:scoreColor}]}>{overview ? score : '—'}</Text>
              <Text style={S.scoreLabel}>Security score</Text>
              <View style={{flexDirection:'row',alignItems:'center',gap:4,marginTop:3}}>
                <View style={{width:6,height:6,borderRadius:3,backgroundColor:scoreColor}}/>
                <Text style={{color:scoreColor,fontSize:12,fontWeight:'700'}}>{score>=80?'STRONG':score>=50?'FAIR':'REVIEW'}</Text>
              </View>
            </View>
          </Animated.View>
        </View>

        <View style={S.statsRow}>
          {[
            {label:'Active sessions',value:overview?String(overview.activeSessions):'—',icon:'phone-portrait-outline' as const,color:colors.primary},
            // No 'Devices' tile — see the note in securityChecks() above: the count
            // is push registrations, not devices. Three tiles wrap 2+1 and flexGrow
            // fills the last row, so removing it does not break the grid.
            {label:'Blocked',value:overview?String(overview.blockedContacts):'—',icon:'ban-outline' as const,color:colors.primary},
            {label:'Account age',value:overview?accountAge(overview.accountCreatedAt):'—',icon:'calendar-outline' as const,color:colors.primary},
          ].map((s,i)=>(
            <View key={i} style={S.statCard}>
              <Ionicons name={s.icon} size={22} color={s.color} />
              <Text style={{color:colors.text,fontSize:20,fontWeight:'800'}}>{s.value}</Text>
              <Text style={{color:colors.textDim,fontSize:12,textAlign:'center',marginTop:1}}>{s.label}</Text>
            </View>
          ))}
        </View>

          {loading && <ActivityIndicator color={colors.primary} style={{marginTop:30}} />}
          {error && !loading && <Text style={{color:colors.danger,textAlign:'center',marginTop:24,fontSize:13}}>{error}</Text>}
          {!loading && !error && checks.map((c,i)=>{
            const col = c.ok ? colors.accent : colors.accent;
            return (
              <View key={i} style={S.moduleRow}>
                <View style={[S.modIcon,{backgroundColor:col+'18',borderColor:col+'44'}]}>
                  <Ionicons name={c.icon} size={22} color={col} />
                </View>
                <View style={{flex:1}}>
                  <View style={{flexDirection:'row',flexWrap:'wrap',alignItems:'center',gap:8,marginBottom:4}}>
                    <Text style={{color:colors.text,fontSize:15,fontWeight:'700',flexShrink:1}}>{c.name}</Text>
                    <View style={{backgroundColor:col+'18',borderRadius:5,paddingHorizontal:5,paddingVertical:2,borderWidth:1,borderColor:col}}>
                      <Text style={{color:col,fontSize:11,fontWeight:'800'}}>{c.ok?'OK':'REVIEW'}</Text>
                    </View>
                  </View>
                  <Text style={{color:colors.textDim,fontSize:13,lineHeight:19}}>{c.desc}</Text>
                </View>
              </View>
            );
          })}
        </ScrollView>
      </Animated.View>

      <View style={S.navBar}>
        {NAV.map(item=>(
          <TouchableOpacity key={item.id} accessibilityRole="button" accessibilityLabel={item.label} accessibilityState={{selected:activeTab===item.id}} onPress={()=>handleNav(item)} style={[S.navItem,activeTab===item.id&&S.navItemActive]}>
            <Ionicons name={item.icon} size={22} color={activeTab===item.id?colors.primary:colors.textDim} />
            <Text style={[S.navLabel,{color:activeTab===item.id?colors.primary:colors.textDim}]}>{item.label}</Text>
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
  return (
    <ErrorBoundary fallbackTitle="Dashboard Error" fallbackMessage="Security dashboard had a problem.">
      <DashboardContent/>
    </ErrorBoundary>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container:{flex:1,backgroundColor:c.bg},
  content:{paddingHorizontal:18,paddingBottom:24},
  header:{flexDirection:'row',alignItems:'center',paddingHorizontal:18,paddingTop:HEADER_TOP,paddingBottom:14,gap:10},
  title:{color:c.text,fontSize:20,fontWeight:'800'},
  backBtn:{width:44,height:44,borderRadius:16,backgroundColor:c.glassSoft,justifyContent:'center',alignItems:'center',borderWidth:1,borderColor:c.glassStroke},
  scanBtn:{width:44,height:44,alignItems:'center',justifyContent:'center',backgroundColor:c.glassSoft,borderRadius:16,borderWidth:1,borderColor:c.glassStroke},
  scoreArea:{alignItems:'center',paddingVertical:14},
  scoreRing:{minWidth:180,minHeight:180,padding:20,borderRadius:90,borderWidth:2,borderColor:c.glassStroke,backgroundColor:c.glassSoft,justifyContent:'center',alignItems:'center',overflow:'hidden',position:'relative'},
  radarBg:{position:'absolute',top:0,left:0,right:0,bottom:0,backgroundColor:'rgba(74,159,255,0.04)'},
  radarSweep:{position:'absolute',top:0,left:'50%',width:2,height:'50%',backgroundColor:'rgba(74,159,255,0.5)',transformOrigin:'bottom center'},
  radarRing:{position:'absolute',borderWidth:1,borderColor:'rgba(74,159,255,0.15)'},
  scoreCenter:{alignItems:'center',zIndex:2},
  scoreNum:{color:'#4A9FFF',fontSize:40,fontWeight:'900',lineHeight:42},
  scoreLabel:{color:c.textDim,fontSize:12,marginTop:2},
  statsRow:{flexDirection:'row',flexWrap:'wrap',gap:10,marginBottom:18},
  statCard:{flexGrow:1,flexBasis:'45%',backgroundColor:c.glassSoft,borderRadius:20,padding:16,alignItems:'center',borderWidth:1,borderColor:c.glassStroke,gap:6},
  moduleRow:{flexDirection:'row',alignItems:'center',backgroundColor:c.glassSoft,borderRadius:20,padding:16,marginBottom:10,borderWidth:1,borderColor:c.glassStroke,gap:12},
  modIcon:{width:44,height:44,borderRadius:22,justifyContent:'center',alignItems:'center',borderWidth:1},
  navBar:{marginHorizontal:14,marginBottom:SCREEN_BOTTOM,backgroundColor:c.glass,borderRadius:24,borderWidth:1,borderColor:c.glassStroke,paddingVertical:8,paddingHorizontal:4,flexDirection:'row',alignItems:'stretch'},
  navItem:{flex:1,minWidth:0,alignItems:'center',justifyContent:'center',gap:4,paddingVertical:6,paddingHorizontal:2,borderRadius:18,borderWidth:1,borderColor:'transparent'},
  navItemActive:{backgroundColor:c.glassSoft,borderColor:c.glassStroke},
  navLabel:{fontSize:11,fontWeight:'600',textAlign:'center'},
});
