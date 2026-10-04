import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState, useCallback , useMemo, type ComponentProps } from 'react';
import { Alert, Animated, Easing, ActivityIndicator, ScrollView, StyleSheet, Switch, TouchableOpacity, View } from 'react-native';
import { brandAlpha, type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { AppText as Text, AuroraBackground } from '../components/ui';
import { readCache, writeCache } from '../lib/localCache';
import * as Location from 'expo-location';
import { ErrorBoundary } from '../components/ErrorBoundary';
import {
  sendSOS, listSOSHistory, listTrustedContacts, getSettings, updateSettings,
  type SOSHistoryItem, type TrustedContact, type UserSettings,
} from '../lib/chatService';
import {
  NOTIF_PREVIEW_OPTIONS, getNotifPreview, setNotifPreview,
  getRemoteLinkPreviews, setRemoteLinkPreviews, type NotifPreview,
} from '../lib/privacyPrefs';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

const NAV: { id: string; icon: IoniconName; label: string; route: string }[] = [
  { id: 'chats', icon: 'chatbubble-ellipses-outline', label: 'Chats', route: '/(tabs)/chats' },
  { id: 'shield', icon: 'shield-checkmark-outline', label: 'Shield', route: '/dashboard' },
  { id: 'community', icon: 'people-outline', label: 'Community', route: '/communities' },
  { id: 'vault', icon: 'file-tray-full-outline', label: 'Vault', route: '/filevault' },
  { id: 'alerts', icon: 'notifications-outline', label: 'Alerts', route: '/notifications' },
];

const SETTING_DEFS: { key: keyof UserSettings; title: string; desc: string; icon: IoniconName }[] = [
  { key:'discoverable',        title:'Discoverable',  desc:'Let others find you by phone or handle', icon:'search-outline' },
  { key:'lastSeenVisible',     title:'Last Seen',     desc:'Show your last-seen time to contacts',   icon:'eye-outline' },
  { key:'readReceipts',        title:'Read Receipts', desc:'Send read receipts in your chats',       icon:'checkmark-done-outline' },
  { key:'profilePhotoVisible', title:'Profile Photo', desc:'Show your profile photo to others',      icon:'person-circle-outline' },
];

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
  const [activeTab,setActiveTab]=useState<'alerts'|'settings'|'panic'>('alerts');
  const [navTab,setNavTab]=useState('alerts');
  const [sos,setSos]=useState<SOSHistoryItem[]>([]);
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

  const loadSos = useCallback(async () => { try { setSos(await listSOSHistory()); } catch {} }, []);

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
        { text: 'Add contacts', onPress: () => router.push('/trusted-contacts' as any) },
      ]);
      return;
    }
    setPanicArmed(true); setPanicCountdown(3);
    Animated.sequence([Animated.timing(panicAnim,{toValue:0.94,duration:100,useNativeDriver:true}),Animated.timing(panicAnim,{toValue:1,duration:300,useNativeDriver:true})]).start();
  };

  const toggleSetting = async (key: keyof UserSettings) => {
    if (!settings) return;
    const next = { ...settings, [key]: !settings[key] };
    setSettings(next); // optimistic
    try { await updateSettings({ [key]: next[key] } as Partial<UserSettings>); }
    // Revert only this key, so a concurrent toggle that did save is kept.
    catch { setSettings(cur => cur ? { ...cur, [key]: settings[key] } : cur); Alert.alert('Could not save', 'Setting was not updated.'); }
  };

  const retrySettings = async () => {
    if (settingsRetrying) return;
    setSettingsRetrying(true);
    try { setSettings(await getSettings()); }
    catch { Alert.alert('Could not load', 'Check your connection and try again.'); }
    finally { setSettingsRetrying(false); }
  };

  const handleNav=(item:typeof NAV[0])=>{ setNavTab(item.id); if(item.id!=='alerts')router.push(item.route as any); };
  const panicBorderColor=glowAnim.interpolate({inputRange:[0,1],outputRange:['rgba(239,68,68,0.3)','rgba(239,68,68,0.8)']});

  return (
    <View style={S.container}>
      <AuroraBackground />
      <Animated.View style={{flex:1,opacity:fadeIn}}>
        <View style={S.header}>
          <TouchableOpacity hitSlop={4} accessibilityRole="button" accessibilityLabel="Back" onPress={()=>router.back()} style={S.backBtn}><Ionicons name="arrow-back" size={20} color={colors.primary} /></TouchableOpacity>
          <View style={{flex:1}}>
            <Text style={S.title}>Alerts & Safety</Text>
            <Text style={{color:colors.textFaint,fontSize:9,letterSpacing:2}}>EMERGENCY & PRIVACY CENTER</Text>
          </View>
        </View>

        <View style={S.tabs}>
          {[{id:'alerts',label:'SOS HISTORY'},{id:'settings',label:'PRIVACY'},{id:'panic',label:'PANIC'}].map(tab=>(
            <TouchableOpacity key={tab.id} onPress={()=>setActiveTab(tab.id as any)} style={[S.tab,activeTab===tab.id&&S.tabActive]} accessibilityRole="tab" accessibilityState={{ selected: activeTab === tab.id }}>
              <Text style={[S.tabText,{color:activeTab===tab.id?(tab.id==='panic'?colors.danger:colors.primary):colors.textFaint}]}>{tab.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <ScrollView contentContainerStyle={{paddingHorizontal:18,paddingBottom:110}} showsVerticalScrollIndicator={false}>
          {loading && <ActivityIndicator color={colors.primary} style={{marginTop:30}}/>}

          {!loading && activeTab==='alerts' && (sos.length===0
            ? <Text style={{color:colors.textFaint,textAlign:'center',marginTop:36,fontSize:13}}>No emergency alerts sent yet.{'\n'}Your SOS history will appear here.</Text>
            : sos.map((a)=>{
                const col = a.type==='emergency' ? colors.danger : colors.accent;
                return (
                  <View key={a.id} style={[S.alertRow,{borderLeftColor:col}]}>
                    <View style={{flex:1}}>
                      <View style={{flexDirection:'row',alignItems:'center',gap:8,marginBottom:4}}>
                        <View style={{backgroundColor:col+'18',borderRadius:5,paddingHorizontal:5,paddingVertical:2,borderWidth:1,borderColor:col}}><Text style={{color:col,fontSize:7,fontWeight:'800',letterSpacing:1}}>{a.type==='emergency'?'EMERGENCY':'TEST'}</Text></View>
                        <Text style={{color:colors.text,fontSize:12,fontWeight:'800'}}>SOS alert sent</Text>
                      </View>
                      <Text style={{color:colors.textDim,fontSize:12,lineHeight:17}}>Notified {a.contactsNotified} trusted contact{a.contactsNotified===1?'':'s'}{a.latitude!=null?' with your location':''}.</Text>
                      <Text style={{color:colors.textFaint,fontSize:9,marginTop:6}}>{fmtTime(a.createdAt)}</Text>
                    </View>
                  </View>
                );
              }))}

          {!loading && activeTab==='settings' && !settings && (
            <View style={{alignItems:'center',marginTop:36,gap:12}}>
              <Text style={{color:colors.textDim,textAlign:'center',fontSize:13}}>Your privacy settings could not be loaded.</Text>
              <TouchableOpacity onPress={retrySettings} disabled={settingsRetrying} style={[S.settingRow,{paddingHorizontal:20,minHeight:44}]} accessibilityRole="button" accessibilityLabel="Try loading privacy settings again" accessibilityState={{ busy: settingsRetrying }}>
                {settingsRetrying ? <ActivityIndicator color={colors.primary}/> : <Text style={{color:colors.primary,fontSize:14,fontWeight:'700'}}>Try again</Text>}
              </TouchableOpacity>
            </View>
          )}

          {!loading && activeTab==='settings' && settings && (
            <View style={{marginTop:4}}>
              <Text style={{color:colors.textFaint,fontSize:9,fontWeight:'800',letterSpacing:2,marginBottom:10}}>PRIVACY</Text>
              {SETTING_DEFS.map((d)=>(
                <View key={d.key} style={S.settingRow}>
                  <View style={S.settingIcon}><Ionicons name={d.icon} size={20} color={colors.primary} /></View>
                  <View style={{flex:1}}>
                    <Text numberOfLines={1} style={{color:colors.text,fontSize:13,fontWeight:'700'}}>{d.title}</Text>
                    <Text style={{color:colors.textFaint,fontSize:10,marginTop:2}}>{d.desc}</Text>
                  </View>
                  <Switch value={!!settings[d.key]} onValueChange={()=>toggleSetting(d.key)} trackColor={{false:colors.border,true:colors.primary}} thumbColor={colors.card} accessibilityLabel={d.title}/>
                </View>
              ))}

              {/* Notification preview. There is no "show message text" option:
                  the push carries no text to show — see lib/privacyPrefs.ts. */}
              <Text style={{color:colors.textFaint,fontSize:9,fontWeight:'800',letterSpacing:2,marginTop:18,marginBottom:10}}>NOTIFICATION PREVIEW</Text>
              {NOTIF_PREVIEW_OPTIONS.map((o)=>{
                const on = notifPreview === o.value;
                return (
                  <TouchableOpacity
                    key={o.value}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    style={[S.settingRow, on && {borderColor:colors.primary}]}
                    onPress={()=>{ setNotifPreviewState(o.value); setNotifPreview(o.value); }}
                  >
                    <View style={{flex:1}}>
                      <Text numberOfLines={1} style={{color:colors.text,fontSize:13,fontWeight:'700'}}>{o.title}</Text>
                      <Text style={{color:colors.textFaint,fontSize:10,marginTop:2}}>{o.desc}</Text>
                    </View>
                    {on && <Ionicons name="checkmark-circle" size={20} color={colors.primary} />}
                  </TouchableOpacity>
                );
              })}
              <Text style={{color:colors.textFaint,fontSize:10,lineHeight:15,marginTop:2}}>
                Message text never appears in the tray on any setting — notifications are delivered without it.
              </Text>

              {/* Recipient-side link previews. OFF = the server never learns a
                  URL that arrived inside an encrypted message. */}
              <Text style={{color:colors.textFaint,fontSize:9,fontWeight:'800',letterSpacing:2,marginTop:18,marginBottom:10}}>LINK PREVIEWS</Text>
              <View style={S.settingRow}>
                <View style={S.settingIcon}><Ionicons name="link-outline" size={20} color={colors.primary} /></View>
                <View style={{flex:1}}>
                  <Text numberOfLines={1} style={{color:colors.text,fontSize:13,fontWeight:'700'}}>Fetch previews for received links</Text>
                  <Text style={{color:colors.textFaint,fontSize:10,marginTop:2}}>Off: crazzychat&apos;s server never sees links people send you. Previews the sender attached still show.</Text>
                </View>
                <Switch value={remoteLinks} onValueChange={(v)=>{ setRemoteLinksState(v); setRemoteLinkPreviews(v); }} trackColor={{false:colors.border,true:colors.primary}} thumbColor={colors.card} accessibilityLabel="Fetch previews for received links"/>
              </View>
            </View>
          )}

          {!loading && activeTab==='panic' && (
            <View style={{gap:16}}>
              <View style={{backgroundColor:'rgba(239,68,68,0.08)',borderRadius:16,padding:16,borderWidth:1,borderColor:'rgba(239,68,68,0.25)'}}>
                <Text style={{color:colors.danger,fontSize:12,fontWeight:'800',marginBottom:6}}>EMERGENCY PANIC BUTTON</Text>
                <Text style={{color:colors.textDim,fontSize:12,lineHeight:18}}>Sends an emergency alert with your current location to your trusted contacts.</Text>
              </View>
              <Animated.View style={{borderRadius:22,borderWidth:2,borderColor:panicBorderColor,overflow:'hidden'}}>
                <TouchableOpacity onPress={armPanic} activeOpacity={0.85} disabled={sending} accessibilityRole="button" accessibilityLabel={sending ? 'Sending emergency alert' : panicArmed ? `Panic alert armed, sending in ${panicCountdown} seconds. Tap to cancel` : 'Panic alert. Tap to arm, sends after 3 seconds'} accessibilityState={{ busy: sending, disabled: sending }} accessibilityLiveRegion="polite">
                  <LinearGradient colors={panicArmed?[colors.danger,colors.danger]:[colors.glass,colors.glassSoft]} style={{padding:28,alignItems:'center',gap:8}}>
                    <Animated.View style={{transform:[{scale:panicAnim}]}}><Ionicons name="warning-outline" size={52} color={colors.danger} /></Animated.View>
                    <Text style={{color:panicArmed?'#FFFFFF':colors.danger,fontSize:17,fontWeight:'900',letterSpacing:2}}>{sending?'SENDING…':panicArmed?'SENDING IN '+panicCountdown+'...':'PANIC ALERT'}</Text>
                    <Text style={{color:panicArmed?'#FFFFFF':colors.textDim,fontSize:11}}>{panicArmed?'Tap again to cancel':'Tap to arm — auto-sends in 3 seconds'}</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </Animated.View>
              <Text style={{color:colors.textFaint,fontSize:9,fontWeight:'800',letterSpacing:2}}>TRUSTED CONTACTS{contactsFailed ? '' : ` (${contacts.length})`}</Text>
              {contactsFailed
                ? <Text style={{color:colors.textDim,fontSize:12}}>Your trusted contacts could not be loaded. The panic button still alerts everyone you have added.</Text>
                : contacts.length===0
                ? <TouchableOpacity onPress={()=>router.push('/trusted-contacts' as any)} accessibilityRole="link" accessibilityLabel="Add trusted contacts">
                    <Text style={{color:colors.textFaint,fontSize:12}}>No trusted contacts yet. <Text style={{color:colors.primary,fontWeight:'700'}}>Add trusted contacts</Text> so they’re alerted in an emergency.</Text>
                  </TouchableOpacity>
                : contacts.map((c)=>(
                    <View key={c.userId} style={[S.settingRow,{borderColor:'rgba(239,68,68,0.15)'}]}>
                      <Ionicons name="people-circle-outline" size={30} color={colors.danger} />
                      <View style={{flex:1}}>
                        <Text numberOfLines={1} style={{color:colors.text,fontSize:13,fontWeight:'700'}}>{c.name || c.vaultId || 'Contact'}</Text>
                        {c.vaultId && <Text style={{color:colors.textFaint,fontSize:11,marginTop:2}}>@{c.vaultId}</Text>}
                      </View>
                      <View style={{backgroundColor:(c.online?colors.accent:colors.textFaint)+'18',borderRadius:8,paddingHorizontal:8,paddingVertical:4,borderWidth:1,borderColor:c.online?colors.accent:colors.textFaint}}><Text style={{color:c.online?colors.accent:colors.textFaint,fontSize:9,fontWeight:'700'}}>{c.online?'ONLINE':'OFFLINE'}</Text></View>
                    </View>
                  ))}
            </View>
          )}
        </ScrollView>
      </Animated.View>

      <View style={S.navBar}>
        {NAV.map(item=>(
          <TouchableOpacity key={item.id} onPress={()=>handleNav(item)} style={[S.navItem,navTab===item.id&&S.navItemActive]} accessibilityRole="button" accessibilityState={{ selected: navTab === item.id }}>
            <Ionicons name={item.icon} size={20} color={navTab===item.id?colors.primary:colors.textFaint} />
            <Text style={[S.navLabel,{color:navTab===item.id?colors.primary:colors.textFaint}]}>{item.label}</Text>
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

export default function NotificationsScreen() {
  return (<ErrorBoundary fallbackTitle="Notifications Error" fallbackMessage="Notifications had a problem."><NotificationsContent/></ErrorBoundary>);
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container:{flex:1,backgroundColor: 'transparent'},
  header:{flexDirection:'row',alignItems:'center',paddingHorizontal:18,paddingTop:HEADER_TOP,paddingBottom:14,gap:10},
  title:{color:c.text,fontSize:20,fontWeight:'900'},
  backBtn:{width:36,height:36,borderRadius:18,backgroundColor:c.glass,justifyContent:'center',alignItems:'center',borderWidth:1,borderColor:c.glassStroke},
  tabs:{flexDirection:'row',marginHorizontal:18,backgroundColor:c.glass,borderRadius:14,padding:4,marginBottom:14,borderWidth:1,borderColor:c.glassStroke},
  tab:{flex:1,paddingVertical:9,alignItems:'center',borderRadius:10},
  tabActive:{backgroundColor:brandAlpha(0.12),borderWidth:1,borderColor:c.primary},
  tabText:{fontSize:10,fontWeight:'800',letterSpacing:0.5},
  alertRow:{backgroundColor:c.glass,borderRadius:16,padding:14,marginBottom:8,borderWidth:1,borderColor:c.glassStroke,borderLeftWidth:3},
  settingRow:{flexDirection:'row',alignItems:'center',backgroundColor:c.glass,borderRadius:16,padding:14,marginBottom:8,borderWidth:1,borderColor:c.glassStroke,gap:12},
  settingIcon:{width:40,height:40,borderRadius:20,backgroundColor:c.glassSoft,justifyContent:'center',alignItems:'center',borderWidth:1,borderColor:c.glassStroke},
  navBar:{position:'absolute',bottom:18,left:14,right:14,backgroundColor:c.glass,borderRadius:28,borderWidth:1,borderColor:c.glassStroke,paddingVertical:10,paddingHorizontal:6,flexDirection:'row',justifyContent:'space-around',alignItems:'center'},
  navItem:{alignItems:'center',gap:4,paddingVertical:6,paddingHorizontal:12,borderRadius:20,borderWidth:1,borderColor:'transparent'},
  navItemActive:{backgroundColor:brandAlpha(0.12),borderColor:c.primary},
  navLabel:{fontSize:9,letterSpacing:0.5,fontWeight:'600'},
});
