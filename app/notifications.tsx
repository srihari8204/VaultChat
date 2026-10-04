import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState, useCallback , useMemo } from 'react';
import { Alert, Animated, Easing, ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Switch, TouchableOpacity, View } from 'react-native';
import { brandAlpha, type Palette } from '../constants/theme';
import { SafetyNavBar } from '../components/SafetyNavBar';
import { useTheme } from '../lib/theme';
import { AppText as Text, AuroraBackground } from '../components/ui';
import { readCache, writeCache } from '../lib/localCache';
import * as Location from 'expo-location';
import { ErrorBoundary } from '../components/ErrorBoundary';
import {
  sendSOS, listSOSHistory, listTrustedContacts, getSettings,
  type SOSHistoryItem, type TrustedContact, type UserSettings,
} from '../lib/chatService';
import {
  NOTIF_PREVIEW_OPTIONS, getNotifPreview, setNotifPreview,
  getRemoteLinkPreviews, setRemoteLinkPreviews, type NotifPreview,
} from '../lib/privacyPrefs';


type TabId = 'alerts' | 'settings' | 'panic';
const TABS: { id: TabId; label: string }[] = [
  { id: 'alerts', label: 'SOS HISTORY' }, { id: 'settings', label: 'PRIVACY' }, { id: 'panic', label: 'PANIC' },
];

// Text on a solid danger fill (the armed panic button). The palette has no
// on-danger token; white passes on both themes' danger red at this size.
const ON_DANGER = '#FFFFFF';


function fmtTime(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

function NotificationsContent() {
  const S = useS();
  const { colors } = useTheme();
  const router=useRouter();
  const [activeTab,setActiveTab]=useState<TabId>('alerts');
  const [sos,setSos]=useState<SOSHistoryItem[]>([]);
  // SOS history that could not be fetched (and was not cached) is an error,
  // not "no alerts sent yet".
  const [sosFailed,setSosFailed]=useState(false);
  const [sosRefreshing,setSosRefreshing]=useState(false);
  const [contacts,setContacts]=useState<TrustedContact[]>([]);
  const [settings,setSettings]=useState<UserSettings|null>(null);
  // Load failures are not "none": a failed contacts fetch must not tell the
  // user to add contacts (or block the panic button), and a failed settings
  // fetch must not leave the privacy tab blank.
  const [contactsFailed,setContactsFailed]=useState(false);
  const [settingsRetrying,setSettingsRetrying]=useState(false);
  const [loading,setLoading]=useState(true);
  const [panicArmed,setPanicArmed]=useState(false);
  const [panicCountdown,setPanicCountdown]=useState(0);
  const [sending,setSending]=useState(false);
  const fadeIn=useRef(new Animated.Value(0)).current;
  const panicAnim=useRef(new Animated.Value(1)).current;
  const glowAnim=useRef(new Animated.Value(0)).current;

  // Device-local privacy prefs (lib/privacyPrefs) — these are real controls,
  // read by lib/messageNotifications.ts and components/LinkPreview.tsx.
  const [notifPreview, setNotifPreviewState] = useState<NotifPreview>('name');
  const [remoteLinks, setRemoteLinksState] = useState(false);

  const loadSos = useCallback(async () => {
    try { setSos(await listSOSHistory()); setSosFailed(false); }
    catch { return false; }
    return true;
  }, []);
  const refreshSos = useCallback(async () => {
    setSosRefreshing(true);
    const ok = await loadSos();
    setSosRefreshing(false);
    if (!ok) Alert.alert('Could not refresh', 'Check your connection and try again.');
  }, [loadSos]);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const [n, l] = await Promise.all([getNotifPreview(), getRemoteLinkPreviews()]);
      if (cancel) return;
      setNotifPreviewState(n); setRemoteLinksState(l);
    })();
    return () => { cancel = true; };
  }, []);

  useEffect(()=>{
    let cancel = false;
    type AlertsCache = { sos: SOSHistoryItem[]; contacts: TrustedContact[]; settings: UserSettings | null };
    (async () => {
      // Local-first: paint last-known SOS history / contacts / privacy settings, then refresh.
      const cached = await readCache<AlertsCache>('alerts');
      if (!cancel && cached) {
        setSos(cached.sos); setContacts(cached.contacts); setSettings(cached.settings);
        setLoading(false);
      }
      try {
        const [h, c, s] = await Promise.all([
          listSOSHistory().catch(() => null),
          listTrustedContacts().catch(() => null),
          getSettings().catch(() => null),
        ]);
        if (cancel) return;
        // Fall back to cached values for any piece that failed, so a partial
        // network failure never blanks a section we already showed.
        const sosV = h ?? cached?.sos ?? [];
        const contactsV = c ?? cached?.contacts ?? [];
        const settingsV = s ?? cached?.settings ?? null;
        setSos(sosV); setContacts(contactsV); setSettings(settingsV);
        setContactsFailed(c === null && !cached?.contacts);
        setSosFailed(h === null && !cached?.sos);
        writeCache('alerts', { sos: sosV, contacts: contactsV, settings: settingsV });
      } finally { if (!cancel) setLoading(false); }
    })();
    Animated.timing(fadeIn,{toValue:1,duration:500,useNativeDriver:true}).start();
    // CAPTURE THE LOOP SO IT CAN BE STOPPED (2026-09-17). The handle was
    // discarded, and the cleanup only flipped the unrelated `cancel` flag
    // belonging to the async loader above. useNativeDriver is false here (it
    // animates a colour), so it runs on the JS thread: opening this screen ONCE
    // made every later screen pay a 60fps JS tax for the rest of the process.
    // Invisible while you are on the screen - it only bites after you leave.
    const glow = Animated.loop(Animated.sequence([
      Animated.timing(glowAnim,{toValue:1,duration:1800,easing:Easing.inOut(Easing.ease),useNativeDriver:false}),
      Animated.timing(glowAnim,{toValue:0,duration:1800,easing:Easing.inOut(Easing.ease),useNativeDriver:false}),
    ]));
    glow.start();
    return () => { cancel = true; glow.stop(); };
  },[fadeIn, glowAnim]);

  const fireSOS = useCallback(async () => {
    setSending(true);
    try {
      let lat: number | null = null, lng: number | null = null;
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          lat = pos.coords.latitude; lng = pos.coords.longitude;
        }
      } catch {}
      const r = await sendSOS(lat, lng, false);
      Alert.alert('Emergency alert sent', `Notified ${r.contactsNotified} trusted contact${r.contactsNotified === 1 ? '' : 's'}${lat != null ? ' with your location' : ' (location unavailable)'}.`);
      loadSos();
    } catch (e: any) {
      Alert.alert('Could not send alert', e?.message ?? 'Please try again.');
    } finally {
      setSending(false);
    }
  }, [loadSos]);

  useEffect(()=>{
    if(panicCountdown<=0)return;
    if(panicCountdown===1){ setPanicCountdown(0); setPanicArmed(false); fireSOS(); return; }
    const t=setTimeout(()=>setPanicCountdown(c=>c-1),1000);
    return()=>clearTimeout(t);
  },[panicCountdown, fireSOS]);

  const armPanic=()=>{
    if(sending) return;
    if(panicArmed){ setPanicArmed(false); setPanicCountdown(0); return; }
    // Only block when we KNOW there are none. If the list failed to load, the
    // server still knows who to alert, and an SOS must not wait on a refetch.
    if(contacts.length === 0 && !contactsFailed){
      Alert.alert('No trusted contacts', 'Add at least one trusted contact before using the panic button.', [
        { text: 'Not now', style: 'cancel' },
        { text: 'Add contacts', onPress: () => router.push('/trusted-contacts') },
      ]);
      return;
    }
    setPanicArmed(true); setPanicCountdown(3);
    Animated.sequence([Animated.timing(panicAnim,{toValue:0.94,duration:100,useNativeDriver:true}),Animated.timing(panicAnim,{toValue:1,duration:300,useNativeDriver:true})]).start();
  };

  const retrySettings = async () => {
    if (settingsRetrying) return;
    setSettingsRetrying(true);
    try { setSettings(await getSettings()); }
    catch { Alert.alert('Could not load', 'Check your connection and try again.'); }
    finally { setSettingsRetrying(false); }
  };

  const panicBorderColor=glowAnim.interpolate({inputRange:[0,1],outputRange:[colors.danger+'4D',colors.danger+'CC']});

  return (
    <View style={S.container}>
      <AuroraBackground />
      <Animated.View style={{flex:1,opacity:fadeIn}}>
        <View style={S.header}>
          <TouchableOpacity hitSlop={4} accessibilityRole="button" accessibilityLabel="Back" onPress={()=>router.back()} style={S.backBtn}><Ionicons name="arrow-back" size={20} color={colors.primary} /></TouchableOpacity>
          <View style={{flex:1}}>
            <Text style={S.title}>Alerts & Safety</Text>
            <Text style={{color:colors.textFaint,fontSize:11,letterSpacing:1.5}}>EMERGENCY & PRIVACY CENTER</Text>
          </View>
        </View>

        <View style={S.tabs} accessibilityRole="tablist">
          {TABS.map(tab=>(
            <TouchableOpacity key={tab.id} onPress={()=>setActiveTab(tab.id)} style={[S.tab,activeTab===tab.id&&S.tabActive]} accessibilityRole="tab" accessibilityState={{ selected: activeTab === tab.id }}>
              <Text style={[S.tabText,{color:activeTab===tab.id?(tab.id==='panic'?colors.danger:colors.primary):colors.textFaint}]}>{tab.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <ScrollView
          contentContainerStyle={{paddingHorizontal:18,paddingBottom:24}}
          showsVerticalScrollIndicator={false}
          refreshControl={activeTab==='alerts' && !loading ? <RefreshControl refreshing={sosRefreshing} onRefresh={refreshSos} tintColor={colors.primary} colors={[colors.primary]} /> : undefined}
        >
          {loading && <ActivityIndicator color={colors.primary} style={{marginTop:30}}/>}

          {!loading && activeTab==='alerts' && sosFailed && sos.length===0 && (
            <View style={{alignItems:'center',marginTop:36,gap:12}}>
              <Text style={{color:colors.textDim,textAlign:'center',fontSize:13}}>Your SOS history could not be loaded.</Text>
              <TouchableOpacity onPress={refreshSos} disabled={sosRefreshing} style={[S.settingRow,{paddingHorizontal:20,minHeight:44}]} accessibilityRole="button" accessibilityLabel="Try loading SOS history again" accessibilityState={{ busy: sosRefreshing, disabled: sosRefreshing }}>
                {sosRefreshing ? <ActivityIndicator color={colors.primary}/> : <Text style={{color:colors.primary,fontSize:14,fontWeight:'700'}}>Try again</Text>}
              </TouchableOpacity>
            </View>
          )}

          {!loading && activeTab==='alerts' && !(sosFailed && sos.length===0) && (sos.length===0
            ? <Text style={{color:colors.textFaint,textAlign:'center',marginTop:36,fontSize:13}}>No emergency alerts sent yet.{'\n'}Your SOS history will appear here.</Text>
            : sos.map((a)=>{
                const col = a.type==='emergency' ? colors.danger : colors.accent;
                return (
                  <View key={a.id} style={[S.alertRow,{borderLeftColor:col}]}>
                    <View style={{flex:1}}>
                      <View style={{flexDirection:'row',alignItems:'center',gap:8,marginBottom:4}}>
                        <View style={{backgroundColor:col+'18',borderRadius:5,paddingHorizontal:5,paddingVertical:2,borderWidth:1,borderColor:col}}><Text style={{color:col,fontSize:11,fontWeight:'800',letterSpacing:1}}>{a.type==='emergency'?'EMERGENCY':'TEST'}</Text></View>
                        <Text style={{color:colors.text,fontSize:12,fontWeight:'800'}}>SOS alert sent</Text>
                      </View>
                      <Text style={{color:colors.textDim,fontSize:12,lineHeight:17}}>Notified {a.contactsNotified} trusted contact{a.contactsNotified===1?'':'s'}{a.latitude!=null?' with your location':''}.</Text>
                      <Text style={{color:colors.textFaint,fontSize:11,marginTop:6}}>{fmtTime(a.createdAt)}</Text>
                    </View>
                  </View>
                );
              }))}

          {!loading && activeTab==='settings' && !settings && (
            <View style={{alignItems:'center',marginTop:36,gap:12}}>
              <Text style={{color:colors.textDim,textAlign:'center',fontSize:13}}>Your privacy settings could not be loaded.</Text>
              <TouchableOpacity onPress={retrySettings} disabled={settingsRetrying} style={[S.settingRow,{paddingHorizontal:20,minHeight:44}]} accessibilityRole="button" accessibilityLabel="Try loading privacy settings again" accessibilityState={{ busy: settingsRetrying, disabled: settingsRetrying }}>
                {settingsRetrying ? <ActivityIndicator color={colors.primary}/> : <Text style={{color:colors.primary,fontSize:14,fontWeight:'700'}}>Try again</Text>}
              </TouchableOpacity>
            </View>
          )}

          {!loading && activeTab==='settings' && settings && (
            <View style={{marginTop:4}}>
              <Text accessibilityRole="header" style={{color:colors.textFaint,fontSize:11,fontWeight:'800',letterSpacing:1.5,marginBottom:10}}>PRIVACY</Text>
              {/* One owner per privacy setting: these four live on Last seen &
                  privacy (app/last-seen-privacy.tsx); this row only links there. */}
              <TouchableOpacity
                style={[S.settingRow,{minHeight:44}]}
                onPress={()=>router.push('/last-seen-privacy' as any)}
                accessibilityRole="button"
                accessibilityLabel="Privacy: last seen, read receipts, profile photo and discoverability"
                accessibilityHint="Opens your privacy settings"
              >
                <View style={S.settingIcon}><Ionicons name="eye-outline" size={20} color={colors.primary} /></View>
                <View style={{flex:1}}>
                  <Text numberOfLines={1} style={{color:colors.text,fontSize:13,fontWeight:'700'}}>Last seen & privacy</Text>
                  <Text style={{color:colors.textFaint,fontSize:12,marginTop:2}}>Last seen, read receipts, profile photo, discoverability</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
              </TouchableOpacity>

              {/* Notification preview. There is no "show message text" option:
                  the push carries no text to show — see lib/privacyPrefs.ts. */}
              <Text accessibilityRole="header" style={{color:colors.textFaint,fontSize:11,fontWeight:'800',letterSpacing:1.5,marginTop:18,marginBottom:10}}>NOTIFICATION PREVIEW</Text>
              <View accessibilityRole="radiogroup" accessibilityLabel="Notification preview">
              {NOTIF_PREVIEW_OPTIONS.map((o)=>{
                const on = notifPreview === o.value;
                return (
                  <TouchableOpacity
                    key={o.value}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    style={[S.settingRow, on && {borderColor:colors.primary}]}
                    onPress={()=>{ setNotifPreviewState(o.value); setNotifPreview(o.value); }}
                  >
                    <View style={{flex:1}}>
                      <Text numberOfLines={1} style={{color:colors.text,fontSize:13,fontWeight:'700'}}>{o.title}</Text>
                      <Text style={{color:colors.textFaint,fontSize:12,marginTop:2}}>{o.desc}</Text>
                    </View>
                    {on && <Ionicons name="checkmark-circle" size={20} color={colors.primary} />}
                  </TouchableOpacity>
                );
              })}
              </View>
              <Text style={{color:colors.textFaint,fontSize:12,lineHeight:17,marginTop:2}}>
                Message text never appears in the tray on any setting — notifications are delivered without it.
              </Text>

              {/* Recipient-side link previews. OFF = the server never learns a
                  URL that arrived inside an encrypted message. */}
              <Text accessibilityRole="header" style={{color:colors.textFaint,fontSize:11,fontWeight:'800',letterSpacing:1.5,marginTop:18,marginBottom:10}}>LINK PREVIEWS</Text>
              <View style={S.settingRow}>
                <View style={S.settingIcon}><Ionicons name="link-outline" size={20} color={colors.primary} /></View>
                <View style={{flex:1}}>
                  <Text numberOfLines={1} style={{color:colors.text,fontSize:13,fontWeight:'700'}}>Fetch previews for received links</Text>
                  <Text style={{color:colors.textFaint,fontSize:12,marginTop:2}}>Off: crazzychat&apos;s server never sees links people send you. Previews the sender attached still show.</Text>
                </View>
                <Switch value={remoteLinks} onValueChange={(v)=>{ setRemoteLinksState(v); setRemoteLinkPreviews(v); }} trackColor={{false:colors.border,true:colors.primary}} thumbColor={colors.card} accessibilityLabel="Fetch previews for received links"/>
              </View>
            </View>
          )}

          {!loading && activeTab==='panic' && (
            <View style={{gap:16}}>
              <View style={{backgroundColor:colors.danger+'14',borderRadius:16,padding:16,borderWidth:1,borderColor:colors.danger+'40'}}>
                <Text style={{color:colors.danger,fontSize:12,fontWeight:'800',marginBottom:6}}>EMERGENCY PANIC BUTTON</Text>
                <Text style={{color:colors.textDim,fontSize:12,lineHeight:18}}>Sends an emergency alert with your current location to your trusted contacts.</Text>
              </View>
              <Animated.View style={{borderRadius:22,borderWidth:2,borderColor:panicBorderColor,overflow:'hidden'}}>
                <TouchableOpacity onPress={armPanic} activeOpacity={0.85} disabled={sending} accessibilityRole="button" accessibilityLabel={sending ? 'Sending emergency alert' : panicArmed ? `Panic alert armed, sending in ${panicCountdown} seconds. Tap to cancel` : 'Panic alert. Tap to arm, sends after 3 seconds'} accessibilityState={{ busy: sending, disabled: sending }} accessibilityLiveRegion="polite">
                  <LinearGradient colors={panicArmed?[colors.danger,colors.danger]:[colors.glass,colors.glassSoft]} style={{padding:28,alignItems:'center',gap:8}}>
                    <Animated.View style={{transform:[{scale:panicAnim}]}}><Ionicons name="warning-outline" size={52} color={colors.danger} /></Animated.View>
                    <Text style={{color:panicArmed?ON_DANGER:colors.danger,fontSize:17,fontWeight:'900',letterSpacing:2}}>{sending?'SENDING…':panicArmed?'SENDING IN '+panicCountdown+'...':'PANIC ALERT'}</Text>
                    <Text style={{color:panicArmed?ON_DANGER:colors.textDim,fontSize:12}}>{panicArmed?'Tap again to cancel':'Tap to arm — auto-sends in 3 seconds'}</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </Animated.View>
              <Text accessibilityRole="header" style={{color:colors.textFaint,fontSize:11,fontWeight:'800',letterSpacing:1.5}}>TRUSTED CONTACTS{contactsFailed ? '' : ` (${contacts.length})`}</Text>
              {contactsFailed
                ? <Text style={{color:colors.textDim,fontSize:12}}>Your trusted contacts could not be loaded. The panic button still alerts everyone you have added.</Text>
                : contacts.length===0
                ? <TouchableOpacity onPress={()=>router.push('/trusted-contacts')} accessibilityRole="link" accessibilityLabel="Add trusted contacts">
                    <Text style={{color:colors.textFaint,fontSize:12}}>No trusted contacts yet. <Text style={{color:colors.primary,fontWeight:'700'}}>Add trusted contacts</Text> so they’re alerted in an emergency.</Text>
                  </TouchableOpacity>
                : contacts.map((c)=>(
                    <View key={c.userId} style={[S.settingRow,{borderColor:colors.danger+'26'}]}>
                      <Ionicons name="people-circle-outline" size={30} color={colors.danger} />
                      <View style={{flex:1}}>
                        <Text numberOfLines={1} style={{color:colors.text,fontSize:13,fontWeight:'700'}}>{c.name || c.vaultId || 'Contact'}</Text>
                        {c.vaultId && <Text style={{color:colors.textFaint,fontSize:11,marginTop:2}}>@{c.vaultId}</Text>}
                      </View>
                      <View style={{backgroundColor:(c.online?colors.accent:colors.textFaint)+'18',borderRadius:8,paddingHorizontal:8,paddingVertical:4,borderWidth:1,borderColor:c.online?colors.accent:colors.textFaint}}><Text style={{color:c.online?colors.accent:colors.textFaint,fontSize:11,fontWeight:'700'}}>{c.online?'ONLINE':'OFFLINE'}</Text></View>
                    </View>
                  ))}
            </View>
          )}
        </ScrollView>
      </Animated.View>

      <SafetyNavBar current="alerts" />
    </View>
  );
}

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function NotificationsScreen() {
  return (<ErrorBoundary fallbackTitle="Notifications Error" fallbackMessage="Notifications had a problem."><NotificationsContent/></ErrorBoundary>);
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container:{flex:1,backgroundColor: 'transparent'},
  header:{flexDirection:'row',alignItems:'center',paddingHorizontal:18,paddingTop:HEADER_TOP,paddingBottom:14,gap:10},
  title:{color:c.text,fontSize:20,fontWeight:'900'},
  backBtn:{width:44,height:44,borderRadius:22,backgroundColor:c.glass,justifyContent:'center',alignItems:'center',borderWidth:1,borderColor:c.glassStroke},
  tabs:{flexDirection:'row',marginHorizontal:18,backgroundColor:c.glass,borderRadius:14,padding:4,marginBottom:14,borderWidth:1,borderColor:c.glassStroke},
  tab:{flex:1,minHeight:44,paddingVertical:9,alignItems:'center',justifyContent:'center',borderRadius:10},
  tabActive:{backgroundColor:brandAlpha(0.12),borderWidth:1,borderColor:c.primary},
  tabText:{fontSize:12,fontWeight:'800',letterSpacing:0.5},
  alertRow:{backgroundColor:c.glass,borderRadius:16,padding:14,marginBottom:8,borderWidth:1,borderColor:c.glassStroke,borderLeftWidth:3},
  settingRow:{flexDirection:'row',alignItems:'center',backgroundColor:c.glass,borderRadius:16,padding:14,marginBottom:8,borderWidth:1,borderColor:c.glassStroke,gap:12},
  settingIcon:{width:40,height:40,borderRadius:20,backgroundColor:c.glassSoft,justifyContent:'center',alignItems:'center',borderWidth:1,borderColor:c.glassStroke},
});
