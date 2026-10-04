import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState , useMemo} from 'react';
import { ActivityIndicator, Animated, Easing, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { AppText as Text } from '../components/ui/Text';
import { AuroraBackground } from '../components/ui/AuroraBackground';
import { brandAlpha, type Palette } from '../constants/theme';
import { SafetyNavBar } from '../components/SafetyNavBar';
import { useTheme } from '../lib/theme';
import { readCache, writeCache } from '../lib/localCache';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { getSecurityOverview, type SecurityOverview } from '../lib/security';
import { E2EE_ENABLED } from '../constants/flags';

/** `href` is the screen where the check is changed; null when nothing there can change it. */
type Check = { name: string; icon: React.ComponentProps<typeof Ionicons>['name']; ok: boolean; desc: string; href: Href | null };

function buildChecks(ov: SecurityOverview): Check[] {
  return [
    { name: 'End-to-End Encryption', icon: 'lock-closed-outline', ok: E2EE_ENABLED && ov.e2eeKeyPublished,
      desc: E2EE_ENABLED ? (ov.e2eeKeyPublished ? 'Keys published — direct chats are encrypted' : 'Open a chat to publish your keys') : 'Encrypted in transit (TLS)',
      href: E2EE_ENABLED && !ov.e2eeKeyPublished ? '/(tabs)/chats' : null },
    { name: 'Last Seen Hidden', icon: 'eye-off-outline', ok: ov.settings.lastSeenVisible === false,
      desc: ov.settings.lastSeenVisible === false ? 'Your last-seen is private' : 'Your last-seen is visible to contacts',
      href: '/last-seen-privacy' },
    { name: 'Read Receipts Off', icon: 'checkmark-done-outline', ok: ov.settings.readReceipts === false,
      desc: ov.settings.readReceipts === false ? 'Read receipts are off' : 'Read receipts are on',
      href: '/last-seen-privacy' },
    { name: 'Undiscoverable', icon: 'person-remove-outline', ok: ov.settings.discoverable === false,
      desc: ov.settings.discoverable === false ? "You're not discoverable by search" : "You're discoverable by phone/handle",
      href: '/last-seen-privacy' },
    { name: 'Blocked Contacts', icon: 'ban-outline', ok: true,
      desc: `${ov.blockedContacts} contact${ov.blockedContacts === 1 ? '' : 's'} blocked`,
      href: '/blocked' },
    { name: 'Active Sessions', icon: 'phone-portrait-outline', ok: ov.activeSessions <= 3,
      desc: `${ov.activeSessions} signed-in session${ov.activeSessions === 1 ? '' : 's'} · ${ov.linkedDevices} device${ov.linkedDevices === 1 ? '' : 's'}`,
      href: '/login-history' },
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
  const [overview, setOverview] = useState<SecurityOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fadeAnim  = useRef(new Animated.Value(0)).current;
  const radarAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // One refresh at a time: the refresh button stays tappable while loading.
  const inFlight = useRef(false);
  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
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
    finally { setLoading(false); inFlight.current = false; }
  }, []);

  // On every focus, not just mount: the check rows send you off to change a
  // setting, and coming back must show the score that change produced.
  useFocusEffect(useCallback(() => { load(); }, [load]));

  useEffect(() => {
    Animated.timing(fadeAnim,{toValue:1,duration:500,useNativeDriver:true}).start();
    // Keep the loop handles so leaving the screen stops them (same leak as
    // the one fixed in app/notifications.tsx).
    const radar = Animated.loop(Animated.timing(radarAnim,{toValue:1,duration:3500,easing:Easing.linear,useNativeDriver:true}));
    const pulse = Animated.loop(Animated.sequence([
      Animated.timing(pulseAnim,{toValue:1.04,duration:2500,easing:Easing.inOut(Easing.ease),useNativeDriver:true}),
      Animated.timing(pulseAnim,{toValue:1,duration:2500,easing:Easing.inOut(Easing.ease),useNativeDriver:true}),
    ]));
    radar.start(); pulse.start();
    return () => { radar.stop(); pulse.stop(); };
  }, [fadeAnim, pulseAnim, radarAnim]);

  const checks = overview ? buildChecks(overview) : [];
  const score = checks.length ? Math.round((checks.filter(c => c.ok).length / checks.length) * 100) : 0;
  const scoreColor = score >= 80 ? colors.success : score >= 50 ? colors.accent : colors.danger;
  const scoreWord = score >= 80 ? 'STRONG' : score >= 50 ? 'FAIR' : 'REVIEW';
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
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Refresh security overview" accessibilityState={{ disabled: loading, busy: loading }} disabled={loading} onPress={load} style={S.scanBtn}>
            {loading ? <ActivityIndicator size="small" color={colors.primary} /> : <Ionicons name="refresh-outline" size={22} color={colors.primary} />}
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={S.content} showsVerticalScrollIndicator={false}>
        <View style={S.scoreArea}>
          <Animated.View
            style={[S.scoreRing,{transform:[{scale:pulseAnim}]}]}
            accessible
            accessibilityRole="summary"
            accessibilityLabel={overview ? `Security score ${score} out of 100, ${scoreWord.toLowerCase()}` : 'Security score not loaded'}
          >
            <View style={S.radarBg}/>
            <Animated.View style={[S.radarSweep,{transform:[{rotate:radarDeg}]}]}/>
            <View style={[S.radarRing,{width:100,height:100,borderRadius:50}]}/>
            <View style={[S.radarRing,{width:68,height:68,borderRadius:34}]}/>
            <View style={S.scoreCenter}>
              <Text style={[S.scoreNum,{color:scoreColor}]}>{overview ? score : '—'}</Text>
              <Text style={S.scoreLabel}>Security score</Text>
              <View style={{flexDirection:'row',alignItems:'center',gap:4,marginTop:3}}>
                <View style={{width:6,height:6,borderRadius:3,backgroundColor:scoreColor}}/>
                <Text style={{color:scoreColor,fontSize:12,fontWeight:'700'}}>{scoreWord}</Text>
              </View>
            </View>
          </Animated.View>
        </View>

        <View style={S.statsRow}>
          {[
            {label:'Active sessions',value:overview?String(overview.activeSessions):'—',icon:'phone-portrait-outline' as const,color:colors.primary},
            {label:'Devices',value:overview?String(overview.linkedDevices):'—',icon:'laptop-outline' as const,color:colors.primary},
            {label:'Blocked',value:overview?String(overview.blockedContacts):'—',icon:'ban-outline' as const,color:colors.primary},
            {label:'Account age',value:overview?accountAge(overview.accountCreatedAt):'—',icon:'calendar-outline' as const,color:colors.primary},
          ].map((s)=>(
            <View key={s.label} style={S.statCard} accessible accessibilityLabel={`${s.label}: ${s.value}`}>
              <Ionicons name={s.icon} size={22} color={s.color} />
              <Text style={{color:colors.text,fontSize:20,fontWeight:'800'}}>{s.value}</Text>
              <Text style={{color:colors.textDim,fontSize:12,textAlign:'center',marginTop:1}}>{s.label}</Text>
            </View>
          ))}
        </View>

          {loading && <ActivityIndicator color={colors.primary} style={{marginTop:30}} />}
          {error && !loading && (
            <View style={{alignItems:'center',marginTop:24,gap:12}}>
              <Text style={{color:colors.danger,textAlign:'center',fontSize:13}}>{error}</Text>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Try loading the security overview again" onPress={load} style={S.retryBtn}>
                <Text style={{color:colors.primary,fontSize:14,fontWeight:'700'}}>Try again</Text>
              </TouchableOpacity>
            </View>
          )}
          {!loading && !error && checks.map((c)=>{
            const col = c.ok ? colors.success : colors.danger;
            const href = c.href;
            return (
              <TouchableOpacity
                key={c.name}
                style={S.moduleRow}
                disabled={!href}
                onPress={href ? () => router.push(href) : undefined}
                accessibilityRole={href ? 'link' : 'text'}
                accessibilityLabel={`${c.name}, ${c.ok ? 'OK' : 'needs review'}. ${c.desc}`}
                accessibilityHint={href ? 'Opens the screen where you can change this' : undefined}
              >
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
                {href && <Ionicons name="chevron-forward" size={18} color={colors.textDim} />}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </Animated.View>

      <SafetyNavBar current="shield" />
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
  retryBtn:{minHeight:44,paddingHorizontal:20,justifyContent:'center',backgroundColor:c.glassSoft,borderRadius:16,borderWidth:1,borderColor:c.glassStroke},
  scanBtn:{width:44,height:44,alignItems:'center',justifyContent:'center',backgroundColor:c.glassSoft,borderRadius:16,borderWidth:1,borderColor:c.glassStroke},
  scoreArea:{alignItems:'center',paddingVertical:14},
  scoreRing:{minWidth:180,minHeight:180,padding:20,borderRadius:90,borderWidth:2,borderColor:c.glassStroke,backgroundColor:c.glassSoft,justifyContent:'center',alignItems:'center',overflow:'hidden',position:'relative'},
  radarBg:{position:'absolute',top:0,left:0,right:0,bottom:0,backgroundColor:brandAlpha(0.04)},
  radarSweep:{position:'absolute',top:0,left:'50%',width:2,height:'50%',backgroundColor:brandAlpha(0.5),transformOrigin:'bottom center'},
  radarRing:{position:'absolute',borderWidth:1,borderColor:brandAlpha(0.15)},
  scoreCenter:{alignItems:'center',zIndex:2},
  scoreNum:{fontSize:40,fontWeight:'900',lineHeight:42},
  scoreLabel:{color:c.textDim,fontSize:12,marginTop:2},
  statsRow:{flexDirection:'row',flexWrap:'wrap',gap:10,marginBottom:18},
  statCard:{flexGrow:1,flexBasis:'45%',backgroundColor:c.glassSoft,borderRadius:20,padding:16,alignItems:'center',borderWidth:1,borderColor:c.glassStroke,gap:6},
  moduleRow:{flexDirection:'row',alignItems:'center',backgroundColor:c.glassSoft,borderRadius:20,padding:16,marginBottom:10,borderWidth:1,borderColor:c.glassStroke,gap:12},
  modIcon:{width:44,height:44,borderRadius:22,justifyContent:'center',alignItems:'center',borderWidth:1},
});
