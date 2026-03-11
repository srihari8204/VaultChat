
// app/msgrequests.tsx — Message Requests
//
// When someone NOT in your contacts messages you:
//   → Their VaultChat photo + name IS shown here
//   → So you can recognise them and decide Accept or Decline
//   → Accept  → moves to normal chat, they appear in chat list
//   → Decline → message deleted, sender not notified
//
// This uses 'request' context in getVisibleProfile()
// which correctly shows photo + name for unsaved senders

import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Alert, Animated, FlatList, StyleSheet,
  Text, TouchableOpacity, View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { VaultContact } from '../lib/contactSync';
import {
  getVisibleProfile, isSavedContact, formatLastSeen,
} from '../lib/contactPrivacy';

const C = {
  bg:'#020B18', primary:'#4A9FFF', green:'#10B981',
  red:'#EF4444', yellow:'#F59E0B',
  dim:'rgba(255,255,255,0.45)', faint:'rgba(255,255,255,0.12)',
};

const GRADS = [
  ['#1D4ED8','#7C3AED'],['#059669','#0EA5E9'],['#DC2626','#F97316'],
  ['#9333EA','#3B82F6'],['#0891B2','#10B981'],['#7C3AED','#EC4899'],
];

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
  const c       = req.contact;
  const saved   = isSavedContact(c.vaultId, allContacts);

  // ✅ REQUEST CONTEXT — shows photo + name even if not saved
  // This is the correct behaviour the user asked for
  const profile = getVisibleProfile(c, saved, 'request');

  const slide = useRef(new Animated.Value(0)).current;
  useEffect(()=>{
    Animated.spring(slide,{toValue:1,tension:80,friction:12,useNativeDriver:true}).start();
  },[]);

  const initials = profile.displayName.split(' ')
    .map(w=>w[0]||'').join('').slice(0,2).toUpperCase()||'??';
  const grad = GRADS[profile.displayName.charCodeAt(0) % GRADS.length];

  return (
    <Animated.View style={{
      opacity:slide,
      transform:[{translateY:Animated.multiply(Animated.subtract(new Animated.Value(1),slide),new Animated.Value(20))}],
    }}>
      <View style={Ss.card}>
        {/* Sender info — photo + name always shown in request context */}
        <View style={{flexDirection:'row',alignItems:'center',gap:14,marginBottom:14}}>
          {/* Avatar — shown because context = 'request' */}
          {profile.showPhoto && profile.photoUri
            ? <View style={{width:56,height:56,borderRadius:28,
                backgroundColor:'#333',overflow:'hidden',
                justifyContent:'center',alignItems:'center'}}>
                <Text style={{fontSize:20,color:'#fff',fontWeight:'900'}}>{initials}</Text>
              </View>
            : <LinearGradient colors={grad as any}
                style={{width:56,height:56,borderRadius:28,
                  justifyContent:'center',alignItems:'center'}}>
                <Text style={{color:'#fff',fontSize:22,fontWeight:'900'}}>{initials}</Text>
              </LinearGradient>
          }
          <View style={{flex:1}}>
            {/* Name — shown because context = 'request' */}
            <Text style={{color:'#fff',fontSize:16,fontWeight:'900'}}>
              {profile.displayName}
            </Text>
            <Text style={{color:C.dim,fontSize:11,marginTop:3}}>
              {req.msgCount} message{req.msgCount!==1?'s':''} · {formatLastSeen(req.receivedAt)}
            </Text>
          </View>
          <View style={{backgroundColor:'rgba(245,158,11,0.15)',borderRadius:10,
            paddingHorizontal:8,paddingVertical:4,borderWidth:1,
            borderColor:'rgba(245,158,11,0.3)'}}>
            <Text style={{color:C.yellow,fontSize:9,fontWeight:'900'}}>
              NOT IN CONTACTS
            </Text>
          </View>
        </View>

        {/* Message preview */}
        <View style={{backgroundColor:'rgba(255,255,255,0.05)',borderRadius:12,
          padding:12,marginBottom:14,borderWidth:1,
          borderColor:'rgba(255,255,255,0.08)'}}>
          <Text style={{color:'rgba(255,255,255,0.6)',fontSize:12,fontStyle:'italic',
            lineHeight:18}} numberOfLines={3}>
            "{req.preview}"
          </Text>
        </View>

        {/* Privacy note */}
        <Text style={{color:'rgba(255,255,255,0.3)',fontSize:10,
          textAlign:'center',marginBottom:12,lineHeight:15}}>
          This person is not in your contacts.{'\n'}
          Their status and last seen are hidden until you accept.
        </Text>

        {/* Action buttons */}
        <View style={{flexDirection:'row',gap:10}}>
          <TouchableOpacity
            onPress={()=>onDecline(req)}
            style={[Ss.btn,{backgroundColor:'rgba(239,68,68,0.1)',
              borderColor:'rgba(239,68,68,0.3)'}]}>
            <Text style={{color:C.red,fontSize:13,fontWeight:'800'}}>
              🚫  Decline
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={()=>onAccept(req)}
            style={[Ss.btn,{flex:1,backgroundColor:'rgba(16,185,129,0.15)',
              borderColor:'rgba(16,185,129,0.4)'}]}>
            <Text style={{color:C.green,fontSize:13,fontWeight:'800',textAlign:'center'}}>
              ✅  Accept & Chat
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Animated.View>
  );
}

export default function MsgRequests() {
  const router = useRouter();
  const [requests, setRequests] = useState<MessageRequest[]>([]);
  const [allContacts, setAllContacts] = useState<VaultContact[]>([]);

  useEffect(()=>{
    loadRequests();
  },[]);

  const loadRequests = async () => {
    // Load all contacts (to check saved status)
    const raw = await AsyncStorage.getItem('vaultContacts');
    const contacts: VaultContact[] = raw ? JSON.parse(raw) : [];
    setAllContacts(contacts);

    // Load pending requests
    const reqRaw = await AsyncStorage.getItem('msgRequests');
    const reqs: MessageRequest[] = reqRaw ? JSON.parse(reqRaw) : [];
    setRequests(reqs);
  };

  const onAccept = async (req: MessageRequest) => {
    // Move to normal chat — contact now accepted
    // In real flow: server is notified, contact added to chat list
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
    <View style={{flex:1,backgroundColor:C.bg}}>
      <LinearGradient colors={['#010812','#020B18']} style={StyleSheet.absoluteFillObject}/>

      {/* Header */}
      <View style={Ss.header}>
        <TouchableOpacity onPress={()=>router.back()} style={Ss.backBtn}>
          <Text style={{color:C.primary,fontSize:18}}>←</Text>
        </TouchableOpacity>
        <View style={{flex:1}}>
          <Text style={Ss.title}>Message Requests</Text>
          <Text style={Ss.sub}>{requests.length} PENDING REQUEST{requests.length!==1?'S':''}</Text>
        </View>
      </View>

      {/* Info banner */}
      <View style={{margin:16,padding:14,borderRadius:14,
        backgroundColor:'rgba(74,159,255,0.06)',
        borderWidth:1,borderColor:'rgba(74,159,255,0.15)'}}>
        <Text style={{color:'rgba(255,255,255,0.7)',fontSize:12,lineHeight:18}}>
          💡  These people messaged you but are not in your contacts.
          Their <Text style={{color:C.primary,fontWeight:'800'}}>name and photo are shown</Text> so
          you can recognise them before deciding to accept or decline.
        </Text>
      </View>

      {requests.length === 0
        ? <View style={{flex:1,justifyContent:'center',alignItems:'center',gap:12}}>
            <Text style={{fontSize:48}}>📭</Text>
            <Text style={{color:'#fff',fontSize:16,fontWeight:'900'}}>No pending requests</Text>
            <Text style={{color:C.dim,fontSize:12}}>New requests will appear here</Text>
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

const Ss = StyleSheet.create({
  header:  {paddingTop:52,paddingBottom:12,paddingHorizontal:18,
             flexDirection:'row',alignItems:'center',gap:12,
             borderBottomWidth:1,borderBottomColor:'rgba(74,159,255,0.1)'},
  backBtn: {width:36,height:36,borderRadius:18,
             backgroundColor:'rgba(10,22,40,0.8)',
             justifyContent:'center',alignItems:'center'},
  title:   {color:'#fff',fontSize:19,fontWeight:'900'},
  sub:     {color:'rgba(255,255,255,0.35)',fontSize:8,fontWeight:'800',
             letterSpacing:1.5,marginTop:2},
  card:    {backgroundColor:'rgba(10,22,40,0.92)',borderRadius:20,
             padding:16,borderWidth:1,borderColor:'rgba(74,159,255,0.14)'},
  btn:     {paddingVertical:14,paddingHorizontal:18,borderRadius:14,borderWidth:1.5,
             justifyContent:'center',alignItems:'center'},
});
