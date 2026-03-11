import { LinearGradient } from 'expo-linear-gradient';
import VaultFeatureSheet from '../components/VaultFeatureSheet';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Animated, Dimensions, Easing, FlatList, Modal,
  ScrollView, StyleSheet, Text, TextInput,
  TouchableOpacity, View,
} from 'react-native';

const { width: SW } = Dimensions.get('window');

// ─── Palette ────────────────────────────────────────────────────────────────
const C = {
  bg:       '#020B18',
  surface:  'rgba(8,20,42,0.92)',
  card:     'rgba(12,26,50,0.88)',
  border:   'rgba(74,159,255,0.13)',
  primary:  '#4A9FFF',
  violet:   '#7C3AED',
  accent:   '#10B981',
  danger:   '#EF4444',
  warning:  '#F59E0B',
  cyan:     '#00EEFF',
  text:     '#FFFFFF',
  textDim:  'rgba(255,255,255,0.52)',
  textFaint:'rgba(255,255,255,0.22)',
};

// ─── Mock conversations ─────────────────────────────────────────────────────
const CONVS = [
  { id:'1',  name:'Sophia Blake',    avatar:'SB', color:['#1D4ED8','#7C3AED'], last:'Voice message · 0:32',       time:'Now',    unread:3,  online:true,  typing:false, verified:true,  pinned:true,  reaction:'❤️', readReceipt:'read',   muted:false },
  { id:'2',  name:'{displayName}',     avatar:'AM', color:['#059669','#0EA5E9'], last:'Typing…',                    time:'1m',     unread:0,  online:true,  typing:true,  verified:true,  pinned:true,  reaction:null, readReceipt:'sent',   muted:false },
  { id:'3',  name:'Vault Team',      avatar:'VT', color:['#7C3AED','#EC4899'], last:'File: Q3_Report.pdf',        time:'8m',     unread:7,  online:false, typing:false, verified:true,  pinned:false, reaction:'👍', readReceipt:'read',   muted:false },
  { id:'4',  name:'Priya Sharma',    avatar:'PS', color:['#F59E0B','#EF4444'], last:'🔐 Encrypted note sent',     time:'42m',    unread:0,  online:true,  typing:false, verified:false, pinned:false, reaction:null, readReceipt:'read',   muted:false },
  { id:'5',  name:'Cipher Group',    avatar:'CG', color:['#0EA5E9','#10B981'], last:'Jordan: 🎙️ Voice message',   time:'1h',     unread:12, online:false, typing:false, verified:true,  pinned:false, reaction:'🔥', readReceipt:'sent',   muted:true  },
  { id:'6',  name:'Marcus Chen',     avatar:'MC', color:['#6366F1','#8B5CF6'], last:'👍 Reacted to your message', time:'2h',     unread:0,  online:false, typing:false, verified:false, pinned:false, reaction:null, readReceipt:'read',   muted:false },
  { id:'7',  name:'Ghost Protocol',  avatar:'GP', color:['#EF4444','#F97316'], last:'📎 breach_scan_log.zip',     time:'3h',     unread:1,  online:true,  typing:false, verified:true,  pinned:false, reaction:null, readReceipt:'delivered', muted:false },
  { id:'8',  name:'Luna Vasquez',    avatar:'LV', color:['#EC4899','#F43F5E'], last:'Seen · 3h ago',              time:'3h',     unread:0,  online:false, typing:false, verified:false, pinned:false, reaction:'😂', readReceipt:'read',   muted:false },
  { id:'9',  name:'Dev Ops Alpha',   avatar:'DO', color:['#14B8A6','#0EA5E9'], last:'Deploy keys updated ✓',      time:'5h',     unread:0,  online:false, typing:false, verified:true,  pinned:false, reaction:null, readReceipt:'read',   muted:true  },
  { id:'10', name:'Nadia Okonkwo',   avatar:'NO', color:['#F59E0B','#10B981'], last:'Call ended · 12 min',        time:'Yesterday', unread:0, online:false, typing:false, verified:false, pinned:false, reaction:null, readReceipt:'sent', muted:false },
];

// ─── Bottom Nav tabs ─────────────────────────────────────────────────────────
const TABS = [
  { id:'chats',   label:'Chats',   icon:'💬', badge:22 },
  { id:'status',  label:'Status',  icon:'⭕', badge:5  },
  { id:'calls',   label:'Calls',   icon:'📞', badge:2  },
  { id:'vault',   label:'Vault',   icon:'🗄️', badge:0  },
  { id:'alerts',  label:'Alerts',  icon:'🔔', badge:3  },
  { id:'profile', label:'Profile', icon:'👤', badge:0  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ReadIcon({ status }) {
  if (status === 'read')      return <Text style={{ fontSize:11, color:'#4A9FFF' }}>✓✓</Text>;
  if (status === 'delivered') return <Text style={{ fontSize:11, color:'rgba(255,255,255,0.3)' }}>✓✓</Text>;
  if (status === 'sent')      return <Text style={{ fontSize:11, color:'rgba(255,255,255,0.3)' }}>✓</Text>;
  return null;
}

// ─── ConvRow ──────────────────────────────────────────────────────────────────
function ConvRow({ item, onPress, index }) {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const fadeAnim  = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1, duration: 350, delay: index * 55, useNativeDriver: true,
    }).start();
  }, []);

  const press = () => {
    Animated.sequence([
      Animated.timing(scaleAnim, { toValue: 0.97, duration: 80, useNativeDriver: true }),
      Animated.timing(scaleAnim, { toValue: 1,    duration: 80, useNativeDriver: true }),
    ]).start(() => onPress(item));
  };

  return (
    <Animated.View style={{ opacity: fadeAnim, transform: [{ scale: scaleAnim }] }}>
      <TouchableOpacity onPress={press} activeOpacity={0.85} style={[S.convRow, item.pinned && S.pinnedRow]}>

        {/* Avatar */}
        <View style={S.avatarWrap}>
          <LinearGradient colors={item.color} style={S.avatar}>
            <Text style={S.avatarTxt}>{item.avatar}</Text>
          </LinearGradient>
          {item.online && <View style={S.onlineDot} />}
          {item.muted  && <View style={S.mutedBadge}><Text style={{ fontSize:7 }}>🔇</Text></View>}
        </View>

        {/* Content */}
        <View style={S.convContent}>
          <View style={S.convTop}>
            <View style={{ flexDirection:'row', alignItems:'center', gap:5, flex:1 }}>
              <Text style={S.convName} numberOfLines={1}>{item.name}</Text>
              {item.verified && <Text style={{ fontSize:11, color:'#4A9FFF' }}>✓</Text>}
              {item.pinned   && <Text style={{ fontSize:9,  color:C.textFaint }}>📌</Text>}
            </View>
            <View style={{ flexDirection:'row', alignItems:'center', gap:5 }}>
              <Text style={S.timeText}>{item.time}</Text>
            </View>
          </View>

          <View style={S.convBottom}>
            <View style={{ flex:1, flexDirection:'row', alignItems:'center', gap:5 }}>
              <ReadIcon status={item.readReceipt} />
              {item.typing ? (
                <TypingDots />
              ) : (
                <Text style={[S.lastMsg, item.unread > 0 && { color: C.text }]} numberOfLines={1}>
                  {item.last}
                </Text>
              )}
            </View>
            <View style={{ flexDirection:'row', alignItems:'center', gap:6 }}>
              {item.reaction && <Text style={{ fontSize:13 }}>{item.reaction}</Text>}
              {item.unread > 0 && (
                <View style={[S.badge, item.muted && { backgroundColor:'rgba(74,159,255,0.2)' }]}>
                  <Text style={S.badgeTxt}>{item.unread > 99 ? '99+' : item.unread}</Text>
                </View>
              )}
            </View>
          </View>
        </View>

      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Typing dots ──────────────────────────────────────────────────────────────
function TypingDots() {
  const d1 = useRef(new Animated.Value(0.3)).current;
  const d2 = useRef(new Animated.Value(0.3)).current;
  const d3 = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const dot = (a, delay) => Animated.loop(Animated.sequence([
      Animated.delay(delay),
      Animated.timing(a, { toValue:1,   duration:300, useNativeDriver:true }),
      Animated.timing(a, { toValue:0.3, duration:300, useNativeDriver:true }),
    ])).start();
    dot(d1,0); dot(d2,150); dot(d3,300);
  }, []);
  return (
    <View style={{ flexDirection:'row', alignItems:'center', gap:3 }}>
      <Text style={{ color:'#10B981', fontSize:11, fontWeight:'700' }}>typing</Text>
      {[d1,d2,d3].map((d,i) => (
        <Animated.View key={i} style={{ width:4, height:4, borderRadius:2, backgroundColor:'#10B981', opacity:d }} />
      ))}
    </View>
  );
}

// ─── VaultLinkModal ───────────────────────────────────────────────────────────
function VaultLinkModal({ visible, onClose }) {
  return <VaultFeatureSheet visible={visible} onClose={onClose} />;
}

// ─── DarkWebModal ─────────────────────────────────────────────────────────────
function DarkWebModal({ visible, onClose }) {
  const slideAnim = useRef(new Animated.Value(300)).current;
  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: visible ? 0 : 300, tension:65, friction:11, useNativeDriver:true,
    }).start();
  }, [visible]);

  const THREATS = [
    { type:'Email Breach',    status:'CLEAR',    icon:'✉️',  color:'#10B981' },
    { type:'Password Leaked', status:'CLEAR',    icon:'🔑',  color:'#10B981' },
    { type:'Phone Exposed',   status:'WARNING',  icon:'📱',  color:'#F59E0B' },
    { type:'VaultID Cloned',  status:'CLEAR',    icon:'⛓️',  color:'#10B981' },
    { type:'IP Fingerprint',  status:'CLEAR',    icon:'🌐',  color:'#10B981' },
  ];

  return (
    <Modal transparent visible={visible} onRequestClose={onClose} animationType="fade">
      <TouchableOpacity style={S.modalBg} activeOpacity={1} onPress={onClose} />
      <Animated.View style={[S.bottomSheet, {transform:[{translateY:slideAnim}], maxHeight:'72%'}]}>
        <LinearGradient colors={['#0A1628','#070F20']} style={StyleSheet.absoluteFillObject}/>
        <View style={S.sheetHandle}/>
        <View style={{flexDirection:'row',alignItems:'center',gap:10,marginBottom:18}}>
          <View style={{width:42,height:42,borderRadius:21,backgroundColor:'rgba(239,68,68,0.15)',borderWidth:1.5,borderColor:'rgba(239,68,68,0.4)',justifyContent:'center',alignItems:'center'}}>
            <Text style={{fontSize:20}}>🛡️</Text>
          </View>
          <View>
            <Text style={S.sheetTitle}>Dark Web Guard</Text>
            <Text style={{color:C.textFaint,fontSize:11}}>Last scan: 2 minutes ago</Text>
          </View>
          <View style={{marginLeft:'auto',backgroundColor:'rgba(245,158,11,0.15)',borderRadius:10,paddingHorizontal:10,paddingVertical:4,borderWidth:1,borderColor:'rgba(245,158,11,0.4)'}}>
            <Text style={{color:'#F59E0B',fontSize:10,fontWeight:'800'}}>1 WARNING</Text>
          </View>
        </View>

        {THREATS.map((t,i) => (
          <View key={i} style={[S.threatRow,{borderColor:t.color+'22'}]}>
            <Text style={{fontSize:18}}>{t.icon}</Text>
            <Text style={{color:'#fff',fontSize:13,fontWeight:'700',flex:1}}>{t.type}</Text>
            <View style={{backgroundColor:t.color+'18',borderRadius:8,paddingHorizontal:10,paddingVertical:3,borderWidth:1,borderColor:t.color+'50'}}>
              <Text style={{color:t.color,fontSize:10,fontWeight:'800'}}>{t.status}</Text>
            </View>
          </View>
        ))}

        <TouchableOpacity onPress={onClose} style={{marginTop:16}}>
          <LinearGradient colors={['#1D4ED8','#7C3AED']} style={{borderRadius:16,paddingVertical:14,alignItems:'center'}}>
            <Text style={{color:'#fff',fontSize:14,fontWeight:'900'}}>Run Full Scan</Text>
          </LinearGradient>
        </TouchableOpacity>
      </Animated.View>
    </Modal>
  );
}

// ─── MAIN SCREEN ──────────────────────────────────────────────────────────────
export default function ChatsScreen() {
  const router = useRouter();
  const [activeTab,    setActiveTab]    = useState('chats');
  const [searchQuery,  setSearchQuery]  = useState('');
  const [searchActive, setSearchActive] = useState(false);
  const [showLink,     setShowLink]     = useState(false);
  const [showDark,     setShowDark]     = useState(false);
  const [filter,       setFilter]       = useState('All');

  const headerAnim = useRef(new Animated.Value(0)).current;
  const searchAnim = useRef(new Animated.Value(0)).current;
  const tabAnim    = useRef(TABS.map(()=>new Animated.Value(1))).current;

  useEffect(() => {
    Animated.timing(headerAnim, { toValue:1, duration:500, useNativeDriver:true }).start();
  }, []);

  const toggleSearch = () => {
    const next = !searchActive;
    setSearchActive(next);
    Animated.spring(searchAnim, { toValue:next?1:0, tension:70, friction:12, useNativeDriver:false }).start();
    if (!next) setSearchQuery('');
  };

  const pressTab = (id, idx) => {
    setActiveTab(id);
    Animated.sequence([
      Animated.timing(tabAnim[idx], { toValue:0.88, duration:80, useNativeDriver:true }),
      Animated.spring(tabAnim[idx],  { toValue:1,    tension:80, friction:8,  useNativeDriver:true }),
    ]).start();
    if (id === 'profile') router.push('/profile');
    if (id === 'vault')   router.push('/filevault');
    if (id === 'alerts')  router.push('/notifications');
    if (id === 'calls')   router.push('/dashboard');
    if (id === 'status')  router.push('/status');
  };

  const FILTERS = ['All','Unread','Groups','Pinned','Archived'];
  const filtered = CONVS.filter(c => {
    const matchQ = searchQuery ? c.name.toLowerCase().includes(searchQuery.toLowerCase()) : true;
    const matchF =
      filter === 'All'      ? true :
      filter === 'Unread'   ? c.unread > 0 :
      filter === 'Pinned'   ? c.pinned :
      filter === 'Groups'   ? c.name.includes('Group')||c.name.includes('Team')||c.name.includes('Alpha')||c.name.includes('Protocol') :
      true;
    return matchQ && matchF;
  });

  const searchWidth = searchAnim.interpolate({ inputRange:[0,1], outputRange:['0%','100%'] });

  const totalUnread = TABS.reduce((s,t)=>s+(t.badge||0),0);

  return (
    <View style={S.root}>
      <LinearGradient colors={['#010812','#020B18','#030E1E']} style={StyleSheet.absoluteFillObject}/>

      {/* Ambient glows */}
      <View style={S.glowA}/>
      <View style={S.glowB}/>

      {/* ── HEADER ─────────────────────────────────────────────────────── */}
      <Animated.View style={[S.header, { opacity:headerAnim, transform:[{translateY:headerAnim.interpolate({inputRange:[0,1],outputRange:[-18,0]})}] }]}>
        <LinearGradient colors={['rgba(8,20,42,0.97)','rgba(6,14,32,0.88)']} style={StyleSheet.absoluteFillObject}/>
        <View style={S.headerInner}>

          {/* Left: logo + title */}
          <View style={{flexDirection:'row',alignItems:'center',gap:10}}>
            <LinearGradient colors={['#1D4ED8','#7C3AED']} style={S.logoIcon}>
              <Text style={{fontSize:16}}>🔐</Text>
            </LinearGradient>
            <View>
              <Text style={S.appTitle}>VaultChat</Text>
              <View style={{flexDirection:'row',alignItems:'center',gap:5}}>
                <View style={{width:5,height:5,borderRadius:2.5,backgroundColor:'#10B981'}}/>
                <Text style={{color:C.textFaint,fontSize:9,fontWeight:'700'}}>END-TO-END ENCRYPTED</Text>
              </View>
            </View>
          </View>

          {/* Right: action icons */}
          <View style={{flexDirection:'row',alignItems:'center',gap:8}}>
            {/* Search */}
            <TouchableOpacity onPress={toggleSearch} style={[S.iconBtn, searchActive&&{backgroundColor:'rgba(74,159,255,0.2)',borderColor:'rgba(74,159,255,0.5)'}]}>
              <Text style={{fontSize:15}}>{searchActive?'✕':'🔍'}</Text>
            </TouchableOpacity>

            {/* Vault Link / Delivery Code */}
            <TouchableOpacity onPress={()=>setShowLink(true)} style={S.iconBtn}>
              <Text style={{fontSize:15}}>🔗</Text>
              <View style={S.iconDot}/>
            </TouchableOpacity>

            {/* Dark Web Guard */}
            <TouchableOpacity onPress={()=>setShowDark(true)} style={[S.iconBtn,{borderColor:'rgba(245,158,11,0.35)'}]}>
              <Text style={{fontSize:15}}>🛡️</Text>
              <View style={[S.iconDot,{backgroundColor:'#F59E0B'}]}/>
            </TouchableOpacity>
          </View>
        </View>

        {/* Search bar */}
        {searchActive && (
          <Animated.View style={[S.searchBar, { width:searchWidth }]}>
            <Text style={{fontSize:14,color:C.textFaint,marginRight:8}}>🔍</Text>
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search conversations..."
              placeholderTextColor={C.textFaint}
              autoFocus
              style={{flex:1,color:'#fff',fontSize:14}}
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={()=>setSearchQuery('')}>
                <Text style={{color:C.textFaint,fontSize:13,paddingHorizontal:4}}>✕</Text>
              </TouchableOpacity>
            )}
          </Animated.View>
        )}
      </Animated.View>

      {/* ── FILTER PILLS ──────────────────────────────────────────────── */}
      <View style={S.filterWrap}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{gap:8,paddingHorizontal:20,paddingVertical:10}}>
          {FILTERS.map(f => (
            <TouchableOpacity key={f} onPress={()=>setFilter(f)} style={[S.filterPill, f===filter&&S.filterActive]}>
              <Text style={[S.filterTxt, f===filter&&{color:'#fff'}]}>{f}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* ── CONVERSATION LIST ─────────────────────────────────────────── */}
      <FlatList
        data={filtered}
        keyExtractor={i=>i.id}
        renderItem={({item,index})=>(
          <ConvRow item={item} index={index} onPress={()=>router.push('/chat')} />
        )}
        contentContainerStyle={{paddingTop:4,paddingBottom:120}}
        showsVerticalScrollIndicator={false}
        ItemSeparatorComponent={()=><View style={{height:1,marginLeft:82,backgroundColor:'rgba(255,255,255,0.04)'}}/>}
        ListEmptyComponent={(
          <View style={{alignItems:'center',paddingTop:60,gap:12}}>
            <Text style={{fontSize:42}}>🔍</Text>
            <Text style={{color:C.textDim,fontSize:15,fontWeight:'700'}}>No conversations found</Text>
            <Text style={{color:C.textFaint,fontSize:12}}>Try a different search term</Text>
          </View>
        )}
      />

      {/* Floating new chat button */}
      <TouchableOpacity style={S.fab} onPress={()=>router.push('/chat')}>
        <LinearGradient colors={['#1D4ED8','#7C3AED']} style={S.fabGrad}>
          <Text style={{color:'#fff',fontSize:22}}>✏️</Text>
        </LinearGradient>
      </TouchableOpacity>

      {/* ── BOTTOM NAV ────────────────────────────────────────────────── */}
      <View style={S.navWrap}>
        <LinearGradient colors={['rgba(4,12,28,0.0)','rgba(4,12,28,0.97)']} style={{position:'absolute',top:-32,left:0,right:0,height:32,pointerEvents:'none'}}/>
        <View style={S.navBar}>
          <LinearGradient colors={['rgba(8,20,42,0.98)','rgba(5,14,30,0.98)']} style={StyleSheet.absoluteFillObject}/>
          {TABS.map((tab,idx)=>{
            const active = activeTab===tab.id;
            return (
              <Animated.View key={tab.id} style={{flex:1,transform:[{scale:tabAnim[idx]}]}}>
                <TouchableOpacity onPress={()=>pressTab(tab.id,idx)} style={S.navTab}>
                  {active && (
                    <View style={S.navActiveBar}/>
                  )}
                  <View style={{position:'relative'}}>
                    <Text style={[S.navIcon, active&&{opacity:1}]}>{tab.icon}</Text>
                    {tab.badge > 0 && (
                      <View style={S.navBadge}>
                        <Text style={{color:'#fff',fontSize:7,fontWeight:'900'}}>{tab.badge>9?'9+':tab.badge}</Text>
                      </View>
                    )}
                  </View>
                  <Text style={[S.navLabel, active&&{color:C.primary,fontWeight:'800'}]}>{tab.label}</Text>
                </TouchableOpacity>
              </Animated.View>
            );
          })}
        </View>
      </View>

      {/* Modals */}
      <VaultLinkModal visible={showLink} onClose={()=>setShowLink(false)} />
      <DarkWebModal   visible={showDark} onClose={()=>setShowDark(false)} />
    </View>
  );
}

const S = StyleSheet.create({
  root:        { flex:1, backgroundColor:'#010812' },
  glowA:       { position:'absolute', top:-80,  alignSelf:'center', width:360, height:360, borderRadius:180, backgroundColor:'rgba(74,159,255,0.04)' },
  glowB:       { position:'absolute', bottom:60, right:-80, width:260, height:260, borderRadius:130, backgroundColor:'rgba(124,58,237,0.04)' },

  // Header
  header:      { paddingTop:52, paddingBottom:10, borderBottomWidth:1, borderBottomColor:'rgba(74,159,255,0.1)', overflow:'hidden' },
  headerInner: { flexDirection:'row', justifyContent:'space-between', alignItems:'center', paddingHorizontal:18, paddingBottom:10 },
  logoIcon:    { width:38, height:38, borderRadius:12, justifyContent:'center', alignItems:'center' },
  appTitle:    { color:'#fff', fontSize:18, fontWeight:'900', letterSpacing:-0.3 },
  iconBtn:     { width:36, height:36, borderRadius:12, backgroundColor:'rgba(10,22,40,0.85)', borderWidth:1, borderColor:'rgba(74,159,255,0.18)', justifyContent:'center', alignItems:'center', position:'relative' },
  iconDot:     { position:'absolute', top:5, right:5, width:7, height:7, borderRadius:3.5, backgroundColor:'#EF4444', borderWidth:1.5, borderColor:'#020B18' },
  searchBar:   { marginHorizontal:18, marginBottom:8, flexDirection:'row', alignItems:'center', backgroundColor:'rgba(10,22,40,0.9)', borderRadius:14, paddingHorizontal:14, paddingVertical:10, borderWidth:1.5, borderColor:'rgba(74,159,255,0.3)', overflow:'hidden' },

  // Filter
  filterWrap:  { borderBottomWidth:1, borderBottomColor:'rgba(255,255,255,0.04)' },
  filterPill:  { paddingHorizontal:14, paddingVertical:6, borderRadius:20, backgroundColor:'rgba(10,22,40,0.7)', borderWidth:1, borderColor:'rgba(255,255,255,0.08)' },
  filterActive:{ backgroundColor:'rgba(74,159,255,0.2)', borderColor:'rgba(74,159,255,0.5)' },
  filterTxt:   { color:'rgba(255,255,255,0.4)', fontSize:12, fontWeight:'700' },

  // Conversation rows
  convRow:     { flexDirection:'row', alignItems:'center', paddingHorizontal:18, paddingVertical:12, gap:13 },
  pinnedRow:   { backgroundColor:'rgba(74,159,255,0.03)' },
  avatarWrap:  { position:'relative' },
  avatar:      { width:52, height:52, borderRadius:26, justifyContent:'center', alignItems:'center' },
  avatarTxt:   { color:'#fff', fontSize:15, fontWeight:'900' },
  onlineDot:   { position:'absolute', bottom:1, right:1, width:13, height:13, borderRadius:6.5, backgroundColor:'#10B981', borderWidth:2.5, borderColor:'#020B18' },
  mutedBadge:  { position:'absolute', top:0, right:0, width:16, height:16, borderRadius:8, backgroundColor:'rgba(10,22,40,0.95)', justifyContent:'center', alignItems:'center' },
  convContent: { flex:1 },
  convTop:     { flexDirection:'row', alignItems:'center', marginBottom:5 },
  convName:    { color:'#fff', fontSize:15, fontWeight:'800', flex:1 },
  timeText:    { color:'rgba(255,255,255,0.28)', fontSize:11 },
  convBottom:  { flexDirection:'row', alignItems:'center' },
  lastMsg:     { color:'rgba(255,255,255,0.42)', fontSize:13 },
  badge:       { backgroundColor:'#4A9FFF', borderRadius:10, minWidth:20, height:20, paddingHorizontal:5, justifyContent:'center', alignItems:'center' },
  badgeTxt:    { color:'#fff', fontSize:10, fontWeight:'900' },

  // FAB
  fab:         { position:'absolute', bottom:100, right:22, width:56, height:56, borderRadius:28, shadowColor:'#4A9FFF', shadowOpacity:0.5, shadowRadius:12, elevation:12 },
  fabGrad:     { width:56, height:56, borderRadius:28, justifyContent:'center', alignItems:'center' },

  // Bottom nav
  navWrap:     { position:'absolute', bottom:0, left:0, right:0 },
  navBar:      { flexDirection:'row', paddingBottom:26, paddingTop:10, paddingHorizontal:6, borderTopWidth:1, borderTopColor:'rgba(74,159,255,0.12)', overflow:'hidden', borderTopLeftRadius:22, borderTopRightRadius:22 },
  navTab:      { flex:1, alignItems:'center', gap:3, position:'relative', paddingTop:4 },
  navActiveBar:{ position:'absolute', top:-10, width:28, height:3, borderRadius:2, backgroundColor:'#4A9FFF' },
  navIcon:     { fontSize:20, opacity:0.55 },
  navLabel:    { color:'rgba(255,255,255,0.38)', fontSize:9, fontWeight:'700' },
  navBadge:    { position:'absolute', top:-4, right:-8, minWidth:14, height:14, borderRadius:7, backgroundColor:'#EF4444', justifyContent:'center', alignItems:'center', paddingHorizontal:3, borderWidth:1.5, borderColor:'#020B18' },

  // Modals
  modalBg:     { ...StyleSheet.absoluteFillObject, backgroundColor:'rgba(0,0,0,0.6)' },
  bottomSheet: { position:'absolute', bottom:0, left:0, right:0, borderTopLeftRadius:28, borderTopRightRadius:28, padding:24, paddingBottom:40, borderWidth:1, borderColor:'rgba(74,159,255,0.15)', overflow:'hidden' },
  sheetHandle: { width:40, height:4, borderRadius:2, backgroundColor:'rgba(255,255,255,0.15)', alignSelf:'center', marginBottom:18 },
  sheetTitle:  { color:'#fff', fontSize:16, fontWeight:'900', marginBottom:16 },
  sheetOption: { flexDirection:'row', alignItems:'center', backgroundColor:'rgba(10,22,40,0.85)', borderRadius:16, padding:14, gap:12, marginBottom:10, borderWidth:1 },
  sheetIcon:   { width:44, height:44, borderRadius:12, justifyContent:'center', alignItems:'center', borderWidth:1 },
  generatedBox:{ backgroundColor:'rgba(16,185,129,0.08)', borderRadius:14, padding:14, borderWidth:1, borderColor:'rgba(16,185,129,0.25)', marginTop:6 },
  threatRow:   { flexDirection:'row', alignItems:'center', backgroundColor:'rgba(10,22,40,0.85)', borderRadius:14, padding:14, gap:12, marginBottom:8, borderWidth:1 },
});

