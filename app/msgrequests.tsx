
// app/msgrequests.tsx — Message Requests
//
// When someone NOT in your contacts messages you:
//   → Their crazzychat photo + name IS shown here
//   → So you can recognise them and decide Accept or Decline
//   → Accept  → moves to normal chat, they appear in chat list
//   → Decline → message deleted, sender not notified
//
// This uses 'request' context in getVisibleProfile()
// which correctly shows photo + name for unsaved senders

import { HEADER_TOP } from '../constants/layout';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { VaultContact, getCachedContacts } from '../lib/contactSync';
import {
  getVisibleProfile, isSavedContact, formatLastSeen,
} from '../lib/contactPrivacy';
import { AuroraBackground } from '../components/ui';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

// A message request = one unknown sender + their latest message
export type MessageRequest = {
  contact:     VaultContact;
  preview:     string;    // first message text
  receivedAt:  number;
  msgCount:    number;
};

function RequestCard({ req, allContacts, onAccept, onDecline }: {
  req:         MessageRequest;
  allContacts: VaultContact[];
  onAccept:    (r:MessageRequest) => void;
  onDecline:   (r:MessageRequest) => void;
}) {
  const { colors } = useTheme();
  const s = useS();
  const c       = req.contact;
  const saved   = isSavedContact(c.vaultId, allContacts);

  // REQUEST CONTEXT — shows photo + name even if not saved
  const profile = getVisibleProfile(c, saved, 'request');

  const slide = useRef(new Animated.Value(0)).current;
  useEffect(()=>{
    Animated.spring(slide,{toValue:1,tension:80,friction:12,useNativeDriver:true}).start();
  },[slide]);

  const initials = profile.displayName.split(' ')
    .map(w=>w[0]||'').join('').slice(0,2).toUpperCase()||'??';

  return (
    <Animated.View style={{
      opacity:slide,
      transform:[{translateY:Animated.multiply(Animated.subtract(new Animated.Value(1),slide),new Animated.Value(20))}],
    }}>
      <View style={s.card}>
        {/* Sender info — photo + name always shown in request context */}
        <View style={s.row}>
          <View style={s.avatar}>
            <Text style={s.avatarTxt}>{initials}</Text>
          </View>
          <View style={{flex:1}}>
            <Text style={s.name} numberOfLines={1}>{profile.displayName}</Text>
            <Text style={s.meta}>
              {req.msgCount} message{req.msgCount!==1?'s':''} · {formatLastSeen(req.receivedAt)}
            </Text>
          </View>
          <View style={s.tag}>
            <Text style={s.tagTxt}>NOT IN CONTACTS</Text>
          </View>
        </View>

        {/* Message preview */}
        <View style={s.preview}>
          <Text style={s.previewTxt} numberOfLines={3}>
            &quot;{req.preview}&quot;
          </Text>
        </View>

        {/* Privacy note */}
        <Text style={s.note}>
          This person is not in your contacts.{'\n'}
          Their status and last seen are hidden until you accept.
        </Text>

        {/* Action buttons */}
        <View style={{flexDirection:'row',gap:10}}>
          <TouchableOpacity
            onPress={()=>onDecline(req)}
            style={[s.btn, s.btnDecline]}>
            <Ionicons name="close" size={16} color={colors.danger} />
            <Text style={[s.btnTxt,{color:colors.danger}]}>Decline</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={()=>onAccept(req)}
            style={[s.btn, s.btnAccept, {flex:1}]}>
            <Ionicons name="chatbubble-ellipses-outline" size={16} color={colors.bubbleOutText} />
            <Text style={[s.btnTxt,{color:colors.bubbleOutText}]}>Accept &amp; Chat</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Animated.View>
  );
}

export default function MsgRequests() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const [requests, setRequests] = useState<MessageRequest[]>([]);
  const [allContacts, setAllContacts] = useState<VaultContact[]>([]);

  useEffect(()=>{
    loadRequests();
  },[]);

  const loadRequests = async () => {
    // Second copy of the 'vaultContacts' parse; contactSync owns that key and
    // now fails soft, so this one inherits the guard instead of repeating it.
    setAllContacts(await getCachedContacts());

    // Load pending requests. A corrupt blob threw out of an un-awaited effect
    // callback — an unhandled rejection, and the list stayed empty forever with
    // no way back. Empty-and-usable beats stuck.
    const reqRaw = await AsyncStorage.getItem('msgRequests');
    let reqs: MessageRequest[] = [];
    try { const p = reqRaw ? JSON.parse(reqRaw) : []; if (Array.isArray(p)) reqs = p; } catch {}
    setRequests(reqs);
  };

  const onAccept = async (req: MessageRequest) => {
    // Move to normal chat — contact now accepted
    const updated = requests.filter(r=>r.contact.vaultId !== req.contact.vaultId);
    setRequests(updated);
    await AsyncStorage.setItem('msgRequests', JSON.stringify(updated));

    // Navigate to chat
    router.push({
      pathname: '/chat',
      params: {
        contactId:   req.contact.vaultId,
        contactName: getVisibleProfile(req.contact, false, 'request').displayName,
        fromRequest: '1',
      },
    });
  };

  const onDecline = (req: MessageRequest) => {
    Alert.alert(
      'Decline Message',
      `Decline message from ${getVisibleProfile(req.contact, false, 'request').displayName}? Their message will be deleted.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Decline',
          style: 'destructive',
          onPress: async () => {
            const updated = requests.filter(r=>r.contact.vaultId !== req.contact.vaultId);
            setRequests(updated);
            await AsyncStorage.setItem('msgRequests', JSON.stringify(updated));
          },
        },
      ]
    );
  };

  return (
    <View style={s.screen}>
      <AuroraBackground />

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity accessibilityLabel="Go back" onPress={()=>router.back()} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{flex:1}}>
          <Text style={s.title}>Message Requests</Text>
          <Text style={s.sub}>{requests.length} PENDING REQUEST{requests.length!==1?'S':''}</Text>
        </View>
      </View>

      {/* Info banner */}
      <View style={s.banner}>
        <Ionicons name="information-circle-outline" size={18} color={colors.textDim} style={{marginTop:1}} />
        <Text style={s.bannerTxt}>
          These people messaged you but are not in your contacts.
          Their <Text style={s.bannerEm}>name and photo are shown</Text> so
          you can recognise them before deciding to accept or decline.
        </Text>
      </View>

      {requests.length === 0
        ? <View style={s.emptyWrap}>
            <Ionicons name="mail-open-outline" size={48} color={colors.textFaint} />
            <Text style={s.emptyTitle}>No pending requests</Text>
            <Text style={s.emptySub}>New requests will appear here</Text>
          </View>
        : <FlatList
            data={requests}
            keyExtractor={r=>r.contact.vaultId}
            renderItem={({item})=>
              <RequestCard req={item} allContacts={allContacts}
                onAccept={onAccept} onDecline={onDecline}/>}
            contentContainerStyle={{padding:16,gap:12,paddingBottom:80}}
          />}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  header:  { paddingTop:HEADER_TOP, paddingBottom:12, paddingHorizontal:18,
             flexDirection:'row', alignItems:'center', gap:12,
             borderBottomWidth:StyleSheet.hairlineWidth, borderBottomColor: c.hairline },
  backBtn: { width:40, height:40, borderRadius:20,
             justifyContent:'center', alignItems:'center' },
  title:   { color:c.text, fontSize:19, fontWeight:'900' },
  sub:     { color:c.textFaint, fontSize:9, fontWeight:'800',
             letterSpacing:1.5, marginTop:2 },

  banner:  { flexDirection:'row', alignItems:'flex-start', gap:10,
             margin:16, padding:14, borderRadius:14,
             backgroundColor: c.glassSoft, borderWidth:1, borderColor: c.glassStroke },
  bannerTxt:{ flex:1, color:c.textDim, fontSize:12, lineHeight:18 },
  bannerEm: { color:c.text, fontWeight:'800' },

  card:    { backgroundColor: c.glassSoft, borderRadius:20,
             padding:16, borderWidth:1, borderColor: c.glassStroke },
  row:     { flexDirection:'row', alignItems:'center', gap:14, marginBottom:14 },
  avatar:  { width:56, height:56, borderRadius:28,
             backgroundColor:c.surfaceSolid, borderWidth:1, borderColor: c.glassStroke,
             justifyContent:'center', alignItems:'center' },
  avatarTxt:{ color:c.textDim, fontSize:20, fontWeight:'900' },
  name:    { color:c.text, fontSize:16, fontWeight:'900' },
  meta:    { color:c.textDim, fontSize:11, marginTop:3 },
  tag:     { backgroundColor: c.glassSoft, borderRadius:10,
             paddingHorizontal:8, paddingVertical:4,
             borderWidth:1, borderColor: c.glassStroke },
  tagTxt:  { color:c.textDim, fontSize:9, fontWeight:'900' },

  preview: { backgroundColor: c.glassSoft, borderRadius:12, padding:12,
             marginBottom:14, borderWidth:1, borderColor: c.glassStroke },
  previewTxt:{ color:c.textDim, fontSize:12, fontStyle:'italic', lineHeight:18 },

  note:    { color:c.textFaint, fontSize:10, textAlign:'center',
             marginBottom:12, lineHeight:15 },

  btn:     { flexDirection:'row', alignItems:'center', justifyContent:'center', gap:6,
             paddingVertical:13, paddingHorizontal:18, borderRadius:14, borderWidth:1.5 },
  btnTxt:  { fontSize:13, fontWeight:'800' },
  btnDecline:{ backgroundColor:c.danger + '14', borderColor:c.danger + '4D' },
  btnAccept: { backgroundColor:c.primary, borderColor:c.primary },

  emptyWrap:{ flex:1, justifyContent:'center', alignItems:'center', gap:12 },
  emptyTitle:{ color:c.text, fontSize:16, fontWeight:'900' },
  emptySub: { color:c.textDim, fontSize:12 },
});
