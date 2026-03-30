
// app/contacts.tsx — Contacts screen (browse context)
// Unsaved contacts: grey circle, no name (their privacy)

import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, FlatList, RefreshControl,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import {
  formatLastSeen,
  getVisibleProfile, isSavedContact,
} from '../lib/contactPrivacy';
import {
  getCachedContacts,
  readPhoneContacts, syncContactsWithServer,
  VaultContact,
} from '../lib/contactSync';

import { SERVER_URL as SERVER } from '../constants/server';
const C = {
  bg:'#FFFFFF', primary:'#4A9FFF', accent:'#10B981',
  dim:'#6B7280', faint:'#D1D5DB',
  card:'#F9FAFB', border:'#E5E7EB',
};
const GRADS = [
  ['#1D4ED8','#7C3AED'],['#059669','#0EA5E9'],['#DC2626','#F97316'],
  ['#9333EA','#3B82F6'],['#0891B2','#10B981'],['#7C3AED','#EC4899'],
];

function Avatar({ name, uri, size=48, show }: {
  name:string; uri?:string; size?:number; show:boolean;
}) {
  if (!show) {
    return (
      <View style={{width:size,height:size,borderRadius:size/2,
        backgroundColor:'#F3F4F6',
        justifyContent:'center',alignItems:'center',
        borderWidth:1.5,borderColor:'#E5E7EB'}}>
        <Text style={{fontSize:20,color:'#9CA3AF'}}>?</Text>
      </View>
    );
  }
  const g = GRADS[name.charCodeAt(0) % GRADS.length];
  const initials = name.split(' ').map(w=>w[0]||'').join('').slice(0,2).toUpperCase()||'??';
  return (
    <LinearGradient colors={g as any}
      style={{width:size,height:size,borderRadius:size/2,
        justifyContent:'center',alignItems:'center'}}>
      <Text style={{color:'#1F2937',fontSize:size*0.35,fontWeight:'900'}}>{initials}</Text>
    </LinearGradient>
  );
}

function ContactRow({ c, all, onPress }: {
  c:VaultContact; all:VaultContact[]; onPress:(c:VaultContact)=>void;
}) {
  const saved   = isSavedContact(c.vaultId, all);
  // Browse context — unsaved contacts have hidden info
  const profile = getVisibleProfile(c, saved, 'browse');
  const fade    = useRef(new Animated.Value(0)).current;
  useEffect(()=>{
    Animated.timing(fade,{toValue:1,duration:280,useNativeDriver:true}).start();
  },[fade]);
  return (
    <Animated.View style={{opacity:fade}}>
      <TouchableOpacity onPress={()=>onPress(c)} style={Ss.row} activeOpacity={0.7}>
        <View>
          <Avatar name={profile.displayName} uri={profile.photoUri}
            show={profile.showPhoto} size={48}/>
          {profile.showOnline && profile.online && <View style={Ss.onlineDot}/>}
        </View>
        <View style={{flex:1,marginLeft:12}}>
          <Text style={Ss.name} numberOfLines={1}>{profile.displayName}</Text>
          {profile.showStatus && profile.status
            ? <Text style={Ss.sub} numberOfLines={1}>{profile.status}</Text>
            : profile.showLastSeen && profile.lastSeen
              ? <Text style={Ss.sub}>Last seen {formatLastSeen(profile.lastSeen)}</Text>
              : !c.isOnVault
                ? <Text style={[Ss.sub,{color:C.faint}]}>Not on VaultChat</Text>
                : null}
        </View>
        <View style={[Ss.badge,c.isOnVault
          ? {backgroundColor:'rgba(74,159,255,0.1)',borderColor:'rgba(74,159,255,0.3)'}
          : {backgroundColor:'rgba(16,185,129,0.1)',borderColor:'rgba(16,185,129,0.3)'}]}>
          <Text style={{
            color:c.isOnVault ? C.primary : C.accent,
            fontSize:10,fontWeight:'900'}}>
            {c.isOnVault ? 'CHAT' : 'INVITE'}
          </Text>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

export default function ContactsScreen() {
  const router = useRouter();
  const [contacts, setContacts] = useState<VaultContact[]>([]);
  const [filtered, setFiltered] = useState<VaultContact[]>([]);
  const [search,   setSearch]   = useState('');
  const [loading,  setLoading]  = useState(true);
  const [syncing,  setSyncing]  = useState(false);
  const [tab,      setTab]      = useState<'all'|'vault'|'invite'>('all');
  const [myId,     setMyId]     = useState('');
  const [, setReqCount] = useState(0);

  useEffect(()=>{
    const doSyncInEffect = async (id:string, show=true) => {
      if (show) setSyncing(true);
      try {
        const ph = await readPhoneContacts();
        const cs = await syncContactsWithServer(SERVER, id, ph);
        setContacts(cs); countReqs(cs);
      } catch { }
      finally { setSyncing(false); }
    };
    const init = async () => {
      const id = await AsyncStorage.getItem('vaultId')||'';
      setMyId(id);
      const cached = await getCachedContacts();
      if (cached.length) { setContacts(cached); countReqs(cached); }
      setLoading(false);
      doSyncInEffect(id, false);
    };
    init();
  },[]);
  useEffect(()=>{
    const applyFilter = () => {
      let list = contacts;
      if (search.trim()) {
        const q = search.toLowerCase();
        list = list.filter(c =>
          c.name.toLowerCase().includes(q) || c.phone.includes(q));
      }
      if (tab==='vault')  list = list.filter(c=>c.isOnVault);
      if (tab==='invite') list = list.filter(c=>!c.isOnVault);
      list = [...list].sort((a,b)=>{
        if (a.isOnVault !== b.isOnVault) return a.isOnVault ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setFiltered(list);
    };
    applyFilter();
  },[contacts,search,tab]);

  const doSync = async (id:string, show=true) => {
    if (show) setSyncing(true);
    try {
      const ph = await readPhoneContacts();
      const cs = await syncContactsWithServer(SERVER, id, ph);
      setContacts(cs); countReqs(cs);
    } catch { }
    finally { setSyncing(false); }
  };

  const countReqs = (list:VaultContact[]) => {
    // Requests from server come via socket — this counts locally cached ones
    setReqCount(0); // actual count managed by msgrequests screen
  };

  const onPress = (c:VaultContact) => {
    if (!c.isOnVault) return;
    const saved = isSavedContact(c.vaultId, contacts);
    const profile = getVisibleProfile(c, saved, 'browse');
    router.push({ pathname:'/chat',
      params:{ contactId:c.vaultId, contactName:profile.displayName }});
  };

  const vaultN = contacts.filter(c=>c.isOnVault).length;
  const TABS = [
    {k:'all',   l:`All (${contacts.length})`},
    {k:'vault', l:`VaultChat (${vaultN})`},
    {k:'invite',l:`Invite (${contacts.length-vaultN})`},
  ] as const;

  return (
    <View style={{flex:1,backgroundColor:C.bg}}>

      {/* Header */}
      <View style={Ss.header}>
        <TouchableOpacity onPress={()=>router.back()} style={Ss.backBtn}>
          <Text style={{color:C.primary,fontSize:18}}>←</Text>
        </TouchableOpacity>
        <View style={{flex:1}}>
          <Text style={Ss.title}>Contacts</Text>
          <Text style={Ss.sub}>{vaultN} ON VAULTCHAT · {contacts.length} TOTAL</Text>
        </View>
        <TouchableOpacity onPress={()=>doSync(myId,true)}
          style={[Ss.backBtn,{width:'auto',paddingHorizontal:12}]}>
          {syncing
            ? <ActivityIndicator size="small" color={C.primary}/>
            : <Text style={{color:C.primary,fontSize:12,fontWeight:'800'}}>Sync</Text>}
        </TouchableOpacity>
      </View>

      {/* Message Requests Banner */}
      <TouchableOpacity style={Ss.reqBanner}
        onPress={()=>router.push('/msgrequests')}>
        <Text style={{fontSize:20}}>📩</Text>
        <View style={{flex:1}}>
          <Text style={{color:'#1F2937',fontSize:13,fontWeight:'800'}}>
            Message Requests
          </Text>
          <Text style={{color:C.dim,fontSize:11,marginTop:1}}>
            People not in your contacts — tap to view
          </Text>
        </View>
        <Text style={{color:C.primary,fontSize:13,fontWeight:'800'}}>→</Text>
      </TouchableOpacity>

      {/* Search */}
      <View style={Ss.search}>
        <Text style={{color:C.dim,marginRight:8}}>🔍</Text>
        <TextInput style={{flex:1,color:'#1F2937',fontSize:14}}
          placeholder="Search contacts..."
          placeholderTextColor={C.faint}
          value={search} onChangeText={setSearch}/>
        {!!search && (
          <TouchableOpacity onPress={()=>setSearch('')}>
            <Text style={{color:C.dim}}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Tabs */}
      <View style={{flexDirection:'row',paddingHorizontal:16,gap:8,marginBottom:8}}>
        {TABS.map(t=>(
          <TouchableOpacity key={t.k} onPress={()=>setTab(t.k as any)}
            style={[Ss.pill,tab===t.k&&Ss.pillOn]}>
            <Text style={{color:tab===t.k?'#fff':C.dim,fontSize:11,fontWeight:'800'}}>
              {t.l}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading
        ? <View style={{flex:1,justifyContent:'center',alignItems:'center'}}>
            <ActivityIndicator color={C.primary} size="large"/>
          </View>
        : <FlatList
            data={filtered}
            keyExtractor={c=>c.vaultId||c.phone}
            renderItem={({item})=>
              <ContactRow c={item} all={contacts} onPress={onPress}/>}
            contentContainerStyle={{paddingHorizontal:16,paddingBottom:80}}
            refreshControl={
              <RefreshControl refreshing={syncing}
                onRefresh={()=>doSync(myId,true)} tintColor={C.primary}/>}
            ItemSeparatorComponent={()=>
              <View style={{height:1,backgroundColor:'#F1F3F4',marginLeft:76}}/>}
            ListEmptyComponent={
              <View style={{alignItems:'center',paddingTop:60,gap:10}}>
                <Text style={{fontSize:40}}>👥</Text>
                <Text style={{color:'#1F2937',fontSize:15,fontWeight:'800'}}>
                  {search?'No contacts found':'No contacts yet'}
                </Text>
                <Text style={{color:C.dim,fontSize:12,textAlign:'center',paddingHorizontal:32}}>
                  Pull down to sync your phone contacts
                </Text>
              </View>}
          />}
    
        {/* QR Code floating button */}
        <TouchableOpacity
          onPress={() => router.push('/qr-contact' as any)}
          style={{
            position: 'absolute', bottom: 24, right: 24,
            width: 56, height: 56, borderRadius: 28,
            backgroundColor: '#00D4AA', justifyContent: 'center',
            alignItems: 'center', elevation: 8,
            shadowColor: '#00D4AA', shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.4, shadowRadius: 8,
          }}
        >
          <Text style={{ fontSize: 24 }}>{"\uD83D\uDCF1"}</Text>
        </TouchableOpacity>
</View>
  );
}

const Ss = StyleSheet.create({
  header:  {paddingTop:52,paddingBottom:12,paddingHorizontal:18,
             flexDirection:'row',alignItems:'center',gap:12,
             borderBottomWidth:1,borderBottomColor:'#E5E7EB'},
  backBtn: {width:36,height:36,borderRadius:18,
             backgroundColor:'#F3F4F6',
             justifyContent:'center',alignItems:'center'},
  title:   {color:'#1F2937',fontSize:19,fontWeight:'900'},
  sub:     {color:'#9CA3AF',fontSize:8,fontWeight:'800',
             letterSpacing:1.5,marginTop:2},
  reqBanner:{flexDirection:'row',alignItems:'center',gap:12,
              margin:12,padding:14,borderRadius:16,
              backgroundColor:'#EFF6FF',
              borderWidth:1,borderColor:'#BFDBFE'},
  search:  {flexDirection:'row',alignItems:'center',
             marginHorizontal:16,marginBottom:10,
             backgroundColor:'#F3F4F6',
             borderRadius:14,paddingHorizontal:14,paddingVertical:10,
             borderWidth:1.5,borderColor:'#E5E7EB'},
  pill:    {paddingHorizontal:12,paddingVertical:6,borderRadius:20,
             backgroundColor:'#F3F4F6',
             borderWidth:1,borderColor:'#E5E7EB'},
  pillOn:  {backgroundColor:'#4A9FFF',
             borderColor:'#4A9FFF'},
  row:     {flexDirection:'row',alignItems:'center',paddingVertical:12,paddingHorizontal:4},
  name:    {color:'#1F2937',fontSize:15,fontWeight:'700'},
  onlineDot:{position:'absolute',bottom:0,right:0,width:12,height:12,
              borderRadius:6,backgroundColor:'#10B981',
              borderWidth:2,borderColor:'#FFFFFF'},
  badge:   {paddingHorizontal:10,paddingVertical:6,borderRadius:10,borderWidth:1},
});
