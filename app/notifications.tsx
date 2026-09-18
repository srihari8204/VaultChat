import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState, useCallback , useMemo} from 'react';
import { Alert, Animated, Easing, ActivityIndicator, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
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

const NAV = [{id:'chats',icon:'💬',label:'Chats',route:'/(tabs)/chats'},{id:'shield',icon:'🛡️',label:'Shield',route:'/dashboard'},{id:'community',icon:'🌐',label:'Community',route:'/communities'},{id:'vault',icon:'📦',label:'Vault',route:'/filevault'},{id:'alerts',icon:'🔔',label:'Alerts',route:'/notifications'}];

const SETTING_DEFS: { key: keyof UserSettings; title: string; desc: string; icon: string }[] = [
  { key:'discoverable',        title:'Discoverable',  desc:'Let others find you by phone or handle', icon:'🔍' },
  { key:'lastSeenVisible',     title:'Last Seen',     desc:'Show your last-seen time to contacts',   icon:'👁️' },
  { key:'readReceipts',        title:'Read Receipts', desc:'Send read receipts in your chats',       icon:'✓' },
  { key:'profilePhotoVisible', title:'Profile Photo', desc:'Show your profile photo to others',      icon:'🖼️' },
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
    if(contacts.length === 0){ Alert.alert('No trusted contacts', 'Add at least one trusted contact before using the panic button.'); return; }
    setPanicArmed(true); setPanicCountdown(3);
    Animated.sequence([Animated.timing(panicAnim,{toValue:0.94,duration:100,useNativeDriver:true}),Animated.timing(panicAnim,{toValue:1,duration:300,useNativeDriver:true})]).start();
  };

  const toggleSetting = async (key: keyof UserSettings) => {
    if (!settings) return;
    const next = { ...settings, [key]: !settings[key] };
    setSettings(next); // optimistic
    try { await updateSettings({ [key]: next[key] } as Partial<UserSettings>); }
    catch { setSettings(settings); Alert.alert('Could not save', 'Setting was not updated.'); }
  };

  const handleNav=(item:typeof NAV[0])=>{ setNavTab(item.id); if(item.id!=='alerts')router.push(item.route as any); };
  const panicBorderColor=glowAnim.interpolate({inputRange:[0,1],outputRange:['rgba(239,68,68,0.3)','rgba(239,68,68,0.8)']});

  return (
    <View style={S.container}>
      <LinearGradient colors={['#FFFFFF','#040F20','#060F24']} style={StyleSheet.absoluteFillObject}/>
      <Animated.View style={{flex:1,opacity:fadeIn}}>
        <View style={S.header}>
          <TouchableOpacity hitSlop={4} accessibilityRole="button" accessibilityLabel="Back" onPress={()=>router.back()} style={S.backBtn}><Ionicons name="arrow-back" size={20} color={colors.primary} /></TouchableOpacity>
          <View style={{flex:1}}>
            <Text style={S.title}>🔔 Alerts & Safety</Text>
            <Text style={{color:colors.textFaint,fontSize:9,letterSpacing:2}}>EMERGENCY & PRIVACY CENTER</Text>
          </View>
        </View>

        <View style={S.tabs}>
          {[{id:'alerts',label:'SOS HISTORY'},{id:'settings',label:'PRIVACY'},{id:'panic',label:'🆘 PANIC'}].map(tab=>(
            <TouchableOpacity key={tab.id} onPress={()=>setActiveTab(tab.id as any)} style={[S.tab,activeTab===tab.id&&S.tabActive]}>
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

          {!loading && activeTab==='settings' && settings && (
            <View style={{marginTop:4}}>
              <Text style={{color:colors.textFaint,fontSize:9,fontWeight:'800',letterSpacing:2,marginBottom:10}}>PRIVACY</Text>
              {SETTING_DEFS.map((d)=>(
                <View key={d.key} style={S.settingRow}>
                  <View style={{width:40,height:40,borderRadius:20,backgroundColor:'rgba(6,14,34,0.9)',justifyContent:'center',alignItems:'center',borderWidth:1,borderColor:'rgba(255,255,255,0.06)'}}><Text style={{fontSize:20}}>{d.icon}</Text></View>
                  <View style={{flex:1}}>
                    <Text numberOfLines={1} style={{color:colors.text,fontSize:13,fontWeight:'700'}}>{d.title}</Text>
                    <Text style={{color:colors.textFaint,fontSize:10,marginTop:2}}>{d.desc}</Text>
                  </View>
                  <Switch value={!!settings[d.key]} onValueChange={()=>toggleSetting(d.key)} trackColor={{false:'rgba(255,255,255,0.06)',true:colors.primary+'66'}} thumbColor={settings[d.key]?colors.primary:'rgba(255,255,255,0.3)'}/>
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
                <View style={{width:40,height:40,borderRadius:20,backgroundColor:'rgba(6,14,34,0.9)',justifyContent:'center',alignItems:'center',borderWidth:1,borderColor:'rgba(255,255,255,0.06)'}}><Text style={{fontSize:20}}>🔗</Text></View>
                <View style={{flex:1}}>
                  <Text numberOfLines={1} style={{color:colors.text,fontSize:13,fontWeight:'700'}}>Fetch previews for received links</Text>
                  <Text style={{color:colors.textFaint,fontSize:10,marginTop:2}}>Off: crazzychat&apos;s server never sees links people send you. Previews the sender attached still show.</Text>
                </View>
                <Switch value={remoteLinks} onValueChange={(v)=>{ setRemoteLinksState(v); setRemoteLinkPreviews(v); }} trackColor={{false:'rgba(255,255,255,0.06)',true:colors.primary+'66'}} thumbColor={remoteLinks?colors.primary:'rgba(255,255,255,0.3)'}/>
              </View>
            </View>
          )}

          {!loading && activeTab==='panic' && (
            <View style={{gap:16}}>
              <View style={{backgroundColor:'rgba(239,68,68,0.08)',borderRadius:16,padding:16,borderWidth:1,borderColor:'rgba(239,68,68,0.25)'}}>
                <Text style={{color:colors.danger,fontSize:12,fontWeight:'800',marginBottom:6}}>🆘 EMERGENCY PANIC BUTTON</Text>
                <Text style={{color:colors.textDim,fontSize:12,lineHeight:18}}>Sends an emergency alert with your current location to your trusted contacts.</Text>
              </View>
              <Animated.View style={{borderRadius:22,borderWidth:2,borderColor:panicBorderColor,overflow:'hidden'}}>
                <TouchableOpacity onPress={armPanic} activeOpacity={0.85} disabled={sending}>
                  <LinearGradient colors={panicArmed?['rgba(127,29,29,0.9)','rgba(153,27,27,0.9)']:['rgba(26,10,10,0.9)','rgba(42,10,10,0.9)']} style={{padding:28,alignItems:'center',gap:8}}>
                    <Animated.Text style={{fontSize:52,transform:[{scale:panicAnim}]}}>🆘</Animated.Text>
                    <Text style={{color:colors.danger,fontSize:17,fontWeight:'900',letterSpacing:2}}>{sending?'SENDING…':panicArmed?'SENDING IN '+panicCountdown+'...':'PANIC ALERT'}</Text>
                    <Text style={{color:colors.textDim,fontSize:11}}>{panicArmed?'Tap again to cancel':'Tap to arm — auto-sends in 3 seconds'}</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </Animated.View>
              <Text style={{color:colors.textFaint,fontSize:9,fontWeight:'800',letterSpacing:2}}>TRUSTED CONTACTS ({contacts.length})</Text>
              {contacts.length===0
                ? <Text style={{color:colors.textFaint,fontSize:12}}>No trusted contacts yet. Add them from a contact’s profile so they’re alerted in an emergency.</Text>
                : contacts.map((c)=>(
                    <View key={c.userId} style={[S.settingRow,{borderColor:'rgba(239,68,68,0.15)'}]}>
                      <Text style={{fontSize:28}}>🛟</Text>
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
          <TouchableOpacity key={item.id} onPress={()=>handleNav(item)} style={[S.navItem,navTab===item.id&&S.navItemActive]}>
            <Text style={{fontSize:20,lineHeight:22}}>{item.icon}</Text>
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
  const { colors } = useTheme();
  const S = useS();
  return (<ErrorBoundary fallbackTitle="Notifications Error" fallbackMessage="Notifications had a problem."><NotificationsContent/></ErrorBoundary>);
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container:{flex:1,backgroundColor: c.glassSoft},
  header:{flexDirection:'row',alignItems:'center',paddingHorizontal:18,paddingTop:HEADER_TOP,paddingBottom:14,gap:10},
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
