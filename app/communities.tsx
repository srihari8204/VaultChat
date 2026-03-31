import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Animated, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { ErrorBoundary } from '../components/ErrorBoundary';

const C = { bg:'#FFFFFF',surface:'rgba(10,22,40,0.85)',primary:'#4A9FFF',secondary:'#7C3AED',accent:'#10B981',danger:'#EF4444',warning:'#F59E0B',border:'rgba(74,159,255,0.15)',borderDim:'rgba(255,255,255,0.06)',text:'#FFFFFF',textDim:'rgba(255,255,255,0.5)',textFaint:'rgba(255,255,255,0.22)' };
const NAV = [{id:'chats',icon:'💬',label:'Chats',route:'/(tabs)/chats'},{id:'shield',icon:'🛡️',label:'Shield',route:'/dashboard'},{id:'community',icon:'🌐',label:'Community',route:'/communities'},{id:'vault',icon:'📦',label:'Vault',route:'/filevault'},{id:'alerts',icon:'🔔',label:'Alerts',route:'/notifications'}];
const ANON_EMOJIS=['🦊','🐺','🦁','🐯','🦋','🦅','🦉','🐉','🦄','🐬','🦈','🦜'];
const ANON_NAMES=['Shadow','Ghost','Cipher','Phantom','Echo','Nova','Viper','Storm','Raven','Falcon'];
const genAnon=()=>({emoji:ANON_EMOJIS[Math.floor(Math.random()*ANON_EMOJIS.length)],name:ANON_NAMES[Math.floor(Math.random()*ANON_NAMES.length)]+Math.floor(Math.random()*999)});
const genCode=()=>{ const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s=''; for(let i=0;i<8;i++){ if(i===4)s+='-'; s+=c[Math.floor(Math.random()*c.length)]; } return s; };
const AUTO_DELETE_OPTIONS=[{label:'Never',value:0},{label:'1 hour',value:1},{label:'6 hours',value:6},{label:'24 hours',value:24},{label:'7 days',value:168}];
const DEMO_COMMUNITIES=[
  {id:'1',name:'CryptoVault',anonName:'Shadow#441',emoji:'🔐',memberCount:847,isAdmin:false,inviteCode:'VAULT-2024',autoDeleteHours:24,topic:'Privacy and crypto discussion',createdAt:Date.now()-86400000*30,messages:[{id:'1',text:'Anyone using hardware wallets?',anonId:'Ghost#112',anonEmoji:'🦊',timestamp:Date.now()-3600000},{id:'2',text:'Ledger all the way. Never leave keys online.',anonId:'Nova#887',anonEmoji:'🦁',timestamp:Date.now()-3000000}]},
  {id:'2',name:'PrivacyFirst',anonName:'Phantom#772',emoji:'🛡️',memberCount:1203,isAdmin:true,inviteCode:'PRIV-8821',autoDeleteHours:6,topic:'Digital rights and surveillance',createdAt:Date.now()-86400000*14,messages:[{id:'1',text:'New surveillance law is dangerous',anonId:'Storm#445',anonEmoji:'🦅',timestamp:Date.now()-7200000}]},
];

function CommunitiesContent() {
  const router=useRouter();
  const [communities,setCommunities]=useState(DEMO_COMMUNITIES as any[]);
  const [activeComm,setActiveComm]=useState<any>(null);
  const [view,setView]=useState<'list'|'chat'>('list');
  const [input,setInput]=useState('');
  const [showCreate,setShowCreate]=useState(false);
  const [showJoin,setShowJoin]=useState(false);
  const [joinCode,setJoinCode]=useState('');
  const [createName,setCreateName]=useState('');
  const [createTopic,setCreateTopic]=useState('');
  const [createAutoDelete,setCreateAutoDelete]=useState(24);
  const [activeTab,setActiveTab]=useState('community');
  const fadeIn=useRef(new Animated.Value(0)).current;
  const myAnon=useRef(genAnon());

  useEffect(()=>{ Animated.timing(fadeIn,{toValue:1,duration:500,useNativeDriver:true}).start(); },[fadeIn]);

  const fmtTime=(ts:number)=>{ const d=Date.now()-ts; if(d<60000)return 'now'; if(d<3600000)return Math.floor(d/60000)+'m'; if(d<86400000)return Math.floor(d/3600000)+'h'; return Math.floor(d/86400000)+'d'; };

  const sendMessage=()=>{ if(!input.trim()||!activeComm)return; const msg={id:Date.now().toString(),text:input.trim(),anonId:myAnon.current.name,anonEmoji:myAnon.current.emoji,timestamp:Date.now()}; setCommunities(prev=>prev.map(c=>c.id===activeComm.id?{...c,messages:[...c.messages,msg]}:c)); setActiveComm((prev:any)=>prev?{...prev,messages:[...prev.messages,msg]}:null); setInput(''); };

  const createCommunity=()=>{ if(!createName.trim())return; const code=genCode(); const anon=genAnon(); const newComm={id:Date.now().toString(),name:createName.trim(),anonName:anon.name+'#'+Math.floor(Math.random()*999),emoji:['🌐','🔐','🛡️','⚡','🌊','🔥'][Math.floor(Math.random()*6)],memberCount:1,isAdmin:true,inviteCode:code,autoDeleteHours:createAutoDelete,topic:createTopic.trim()||'Private community',createdAt:Date.now(),messages:[]}; setCommunities(prev=>[newComm,...prev]); setShowCreate(false); setCreateName(''); setCreateTopic(''); Alert.alert('Community Created','Your invite code is: '+code+'. Share with trusted members only.'); };

  const joinCommunity=()=>{ if(joinCode.trim().length<6){ Alert.alert('Invalid Code','Please enter a valid invite code.'); return; } const anon=genAnon(); const newComm={id:Date.now().toString(),name:'Community #'+joinCode.slice(-4),anonName:anon.name+'#'+Math.floor(Math.random()*999),emoji:'🌐',memberCount:Math.floor(Math.random()*500)+10,isAdmin:false,inviteCode:joinCode.trim().toUpperCase(),autoDeleteHours:24,topic:'Joined community',createdAt:Date.now(),messages:[]}; setCommunities(prev=>[newComm,...prev]); setShowJoin(false); setJoinCode(''); Alert.alert('Joined','You joined as '+anon.emoji+' '+newComm.anonName); };

  const handleNav=(item:typeof NAV[0])=>{ setActiveTab(item.id); if(item.id!=='community')router.push(item.route as any); };

  if(view==='chat'&&activeComm) return (
    <View style={S.container}>
      <LinearGradient colors={['#FFFFFF','#040F20','#060F24']} style={StyleSheet.absoluteFillObject}/>
      <View style={S.chatHead}>
        <TouchableOpacity onPress={()=>setView('list')} style={S.backBtn}><Text style={{color:C.primary,fontSize:18}}>←</Text></TouchableOpacity>
        <Text style={{fontSize:24}}>{activeComm.emoji}</Text>
        <View style={{flex:1}}>
          <Text style={{color:C.text,fontSize:15,fontWeight:'900'}}>{activeComm.name}</Text>
          <Text style={{color:C.textFaint,fontSize:10}}>{activeComm.memberCount} anonymous members</Text>
        </View>
      </View>
      <View style={{backgroundColor:'rgba(124,58,237,0.1)',paddingHorizontal:16,paddingVertical:8,flexDirection:'row',alignItems:'center',gap:8,borderBottomWidth:1,borderBottomColor:'rgba(255,255,255,0.06)'}}>
        <Text style={{fontSize:12}}>👻</Text>
        <Text style={{color:C.secondary,fontSize:10,fontWeight:'700'}}>You are {myAnon.current.emoji} {myAnon.current.name} — identity hidden</Text>
        {activeComm.autoDeleteHours>0&&<View style={{marginLeft:'auto'}}><Text style={{color:C.warning,fontSize:9}}>⏱️ {activeComm.autoDeleteHours}h auto-delete</Text></View>}
      </View>
      <ScrollView style={{flex:1}} contentContainerStyle={{padding:16}}>
        {activeComm.messages.map((msg:any,i:number)=>{ const isMe=msg.anonId===myAnon.current.name; return (
          <View key={i} style={[{flexDirection:'row',marginBottom:12,gap:8},isMe&&{flexDirection:'row-reverse'}]}>
            <View style={{width:32,height:32,borderRadius:16,backgroundColor:'rgba(10,22,40,0.85)',justifyContent:'center',alignItems:'center',borderWidth:1,borderColor:'rgba(255,255,255,0.06)'}}><Text style={{fontSize:18}}>{msg.anonEmoji}</Text></View>
            <View style={{maxWidth:'70%'}}>
              {!isMe&&<Text style={{color:C.secondary,fontSize:9,fontWeight:'700',marginBottom:3}}>{msg.anonEmoji} {msg.anonId}</Text>}
              <View style={[{borderRadius:16,padding:10,borderWidth:1},isMe?{backgroundColor:'#1D4ED8',borderColor:'#2563EB'}:{backgroundColor:'rgba(10,22,40,0.85)',borderColor:'rgba(255,255,255,0.06)'}]}>
                <Text style={{color:C.text,fontSize:13}}>{msg.text}</Text>
                <Text style={{color:'rgba(255,255,255,0.3)',fontSize:8,textAlign:'right',marginTop:3}}>{fmtTime(msg.timestamp)}</Text>
              </View>
            </View>
          </View>
        ); })}
      </ScrollView>
      <View style={{flexDirection:'row',padding:12,borderTopWidth:1,borderTopColor:'rgba(255,255,255,0.06)',gap:8,alignItems:'center'}}>
        <TextInput value={input} onChangeText={setInput} placeholder={'Message as '+myAnon.current.emoji+' '+myAnon.current.name+'...'} placeholderTextColor={C.textFaint} style={{flex:1,backgroundColor:'rgba(10,22,40,0.85)',borderRadius:20,paddingHorizontal:16,paddingVertical:10,color:C.text,fontSize:13,borderWidth:1,borderColor:'rgba(255,255,255,0.06)'}} multiline/>
        <TouchableOpacity onPress={sendMessage}>
          <LinearGradient colors={input.trim()?[C.primary,C.secondary]:['rgba(10,22,40,0.8)','rgba(10,22,40,0.8)']} style={{width:42,height:42,borderRadius:21,justifyContent:'center',alignItems:'center'}}><Text style={{fontSize:18,color:'#fff'}}>→</Text></LinearGradient>
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <View style={S.container}>
      <LinearGradient colors={['#FFFFFF','#040F20','#060F24']} style={StyleSheet.absoluteFillObject}/>
      <Animated.View style={{flex:1,opacity:fadeIn}}>
        <View style={S.header}>
          <TouchableOpacity onPress={()=>router.back()} style={S.backBtn}><Text style={{color:C.primary,fontSize:18}}>←</Text></TouchableOpacity>
          <View style={{flex:1}}>
            <Text style={S.title}>🌐 Communities</Text>
            <Text style={{color:C.textFaint,fontSize:9,letterSpacing:2}}>ANONYMOUS AND ENCRYPTED</Text>
          </View>
          <TouchableOpacity onPress={()=>setShowJoin(true)} style={[S.iconBtn,{marginRight:6}]}><Text style={{fontSize:16}}>🔗</Text></TouchableOpacity>
          <TouchableOpacity onPress={()=>setShowCreate(true)} style={{backgroundColor:'#1D4ED8',borderRadius:20,width:40,height:40,justifyContent:'center',alignItems:'center'}}><Text style={{color:'#fff',fontSize:22,fontWeight:'900'}}>+</Text></TouchableOpacity>
        </View>

        <View style={{marginHorizontal:18,backgroundColor:'rgba(124,58,237,0.12)',borderRadius:16,padding:14,marginBottom:14,borderWidth:1,borderColor:'rgba(124,58,237,0.3)',flexDirection:'row',alignItems:'center',gap:12}}>
          <Text style={{fontSize:26}}>👻</Text>
          <View style={{flex:1}}>
            <Text style={{color:C.secondary,fontSize:13,fontWeight:'800'}}>You are completely anonymous</Text>
            <Text style={{color:C.textFaint,fontSize:11,marginTop:2}}>Real identity never revealed. New anon ID per community.</Text>
          </View>
        </View>

        <ScrollView contentContainerStyle={{paddingHorizontal:18,paddingBottom:110}}>
          {communities.map((comm:any,i:number)=>(
            <TouchableOpacity key={i} onPress={()=>{ setActiveComm(comm); setView('chat'); }} style={S.commRow}>
              <View style={{width:52,height:52,borderRadius:26,backgroundColor:'rgba(10,22,40,0.85)',justifyContent:'center',alignItems:'center',borderWidth:1.5,borderColor:C.border}}><Text style={{fontSize:26}}>{comm.emoji}</Text></View>
              <View style={{flex:1}}>
                <View style={{flexDirection:'row',alignItems:'center',gap:8}}>
                  <Text style={{color:C.text,fontSize:14,fontWeight:'800'}}>{comm.name}</Text>
                  {comm.isAdmin&&<View style={{backgroundColor:C.warning+'18',borderRadius:6,paddingHorizontal:5,paddingVertical:2,borderWidth:1,borderColor:C.warning}}><Text style={{color:C.warning,fontSize:8,fontWeight:'800'}}>ADMIN</Text></View>}
                </View>
                <Text style={{color:C.textFaint,fontSize:11,marginTop:2}}>{comm.topic}</Text>
                <View style={{flexDirection:'row',gap:10,marginTop:4}}>
                  <Text style={{color:C.primary,fontSize:10}}>👥 {comm.memberCount}</Text>
                  {comm.autoDeleteHours>0&&<Text style={{color:C.warning,fontSize:10}}>⏱️ {comm.autoDeleteHours}h</Text>}
                  <Text style={{color:C.accent,fontSize:10}}>🔐 Encrypted</Text>
                </View>
              </View>
              <Text style={{color:C.textFaint,fontSize:10}}>{comm.messages.length>0?fmtTime(comm.messages[comm.messages.length-1].timestamp):''}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </Animated.View>

      <Modal visible={showCreate} transparent animationType="slide">
        <TouchableOpacity style={{flex:1,backgroundColor:'rgba(0,0,0,0.6)'}} activeOpacity={1} onPress={()=>setShowCreate(false)}>
          <View style={{position:'absolute',bottom:0,left:0,right:0}}>
            <LinearGradient colors={['rgba(10,22,40,0.99)','rgba(6,14,34,0.99)']} style={{borderTopLeftRadius:28,borderTopRightRadius:28,padding:24,paddingBottom:44,borderWidth:1,borderColor:'rgba(74,159,255,0.12)'}}>
              <Text style={{color:C.text,fontSize:18,fontWeight:'900',marginBottom:20}}>Create Community</Text>
              <TextInput value={createName} onChangeText={setCreateName} placeholder="Community name..." placeholderTextColor={C.textFaint} style={S.modalInput}/>
              <TextInput value={createTopic} onChangeText={setCreateTopic} placeholder="Topic or description..." placeholderTextColor={C.textFaint} style={[S.modalInput,{marginTop:10}]}/>
              <View style={{flexDirection:'row',flexWrap:'wrap',gap:8,marginTop:12,marginBottom:16}}>
                {AUTO_DELETE_OPTIONS.map((o,i)=>(<TouchableOpacity key={i} onPress={()=>setCreateAutoDelete(o.value)} style={{backgroundColor:createAutoDelete===o.value?C.warning+'22':'rgba(6,14,34,0.9)',borderRadius:12,paddingHorizontal:14,paddingVertical:10,borderWidth:1.5,borderColor:createAutoDelete===o.value?C.warning:'rgba(255,255,255,0.06)'}}><Text style={{color:createAutoDelete===o.value?C.warning:C.text,fontSize:12,fontWeight:'700'}}>{o.label}</Text></TouchableOpacity>))}
              </View>
              <TouchableOpacity onPress={createCommunity}>
                <LinearGradient colors={[C.primary,C.secondary]} style={{borderRadius:16,paddingVertical:16,alignItems:'center'}}><Text style={{color:'#fff',fontSize:15,fontWeight:'900'}}>Create Anonymous Community</Text></LinearGradient>
              </TouchableOpacity>
            </LinearGradient>
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal visible={showJoin} transparent animationType="slide">
        <TouchableOpacity style={{flex:1,backgroundColor:'rgba(0,0,0,0.6)'}} activeOpacity={1} onPress={()=>setShowJoin(false)}>
          <View style={{position:'absolute',bottom:0,left:0,right:0}}>
            <LinearGradient colors={['rgba(10,22,40,0.99)','rgba(6,14,34,0.99)']} style={{borderTopLeftRadius:28,borderTopRightRadius:28,padding:24,paddingBottom:44,borderWidth:1,borderColor:'rgba(74,159,255,0.12)'}}>
              <Text style={{color:C.text,fontSize:18,fontWeight:'900',marginBottom:8}}>Join Community</Text>
              <Text style={{color:C.textFaint,fontSize:13,marginBottom:20}}>Enter the encrypted invite code to join anonymously</Text>
              <TextInput value={joinCode} onChangeText={setJoinCode} placeholder="XXXX-XXXX" placeholderTextColor={C.textFaint} style={[S.modalInput,{textAlign:'center',letterSpacing:4,fontSize:18,fontWeight:'800',color:C.primary}]} autoCapitalize="characters"/>
              <TouchableOpacity onPress={joinCommunity} style={{marginTop:16}}>
                <LinearGradient colors={[C.secondary,C.primary]} style={{borderRadius:16,paddingVertical:16,alignItems:'center'}}><Text style={{color:'#fff',fontSize:15,fontWeight:'900'}}>Join Anonymously</Text></LinearGradient>
              </TouchableOpacity>
            </LinearGradient>
          </View>
        </TouchableOpacity>
      </Modal>

      <View style={S.navBar}>
        {NAV.map(item=>(
          <TouchableOpacity key={item.id} onPress={()=>handleNav(item)} style={[S.navItem,activeTab===item.id&&S.navItemActive]}>
            <Text style={{fontSize:20,lineHeight:22}}>{item.icon}</Text>
            <Text style={[S.navLabel,{color:activeTab===item.id?C.primary:C.textFaint}]}>{item.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

export default function CommunitiesScreen() {
  return (<ErrorBoundary fallbackTitle="Communities Error" fallbackMessage="Communities had a problem."><CommunitiesContent/></ErrorBoundary>);
}

const S = StyleSheet.create({
  container:{flex:1,backgroundColor:'#FFFFFF'},
  header:{flexDirection:'row',alignItems:'center',paddingHorizontal:18,paddingTop:50,paddingBottom:16,gap:10},
  title:{color:'#fff',fontSize:20,fontWeight:'900'},
  backBtn:{width:36,height:36,borderRadius:18,backgroundColor:'rgba(10,22,40,0.8)',justifyContent:'center',alignItems:'center',borderWidth:1,borderColor:'rgba(255,255,255,0.06)'},
  iconBtn:{width:36,height:36,borderRadius:18,backgroundColor:'rgba(10,22,40,0.8)',justifyContent:'center',alignItems:'center',borderWidth:1,borderColor:'rgba(255,255,255,0.06)'},
  chatHead:{flexDirection:'row',alignItems:'center',paddingHorizontal:14,paddingTop:50,paddingBottom:12,borderBottomWidth:1,borderBottomColor:'rgba(255,255,255,0.06)',gap:10},
  commRow:{flexDirection:'row',alignItems:'center',backgroundColor:'rgba(10,22,40,0.8)',borderRadius:18,padding:14,marginBottom:10,borderWidth:1,borderColor:'rgba(255,255,255,0.06)',gap:12},
  modalInput:{backgroundColor:'rgba(6,14,34,0.9)',borderRadius:14,padding:16,color:'#fff',fontSize:14,borderWidth:1,borderColor:'rgba(255,255,255,0.08)'},
  navBar:{position:'absolute',bottom:18,left:14,right:14,backgroundColor:'rgba(4,12,28,0.92)',borderRadius:28,borderWidth:1,borderColor:'rgba(74,159,255,0.12)',paddingVertical:10,paddingHorizontal:6,flexDirection:'row',justifyContent:'space-around',alignItems:'center'},
  navItem:{alignItems:'center',gap:4,paddingVertical:6,paddingHorizontal:12,borderRadius:20,borderWidth:1,borderColor:'transparent'},
  navItemActive:{backgroundColor:'rgba(74,159,255,0.12)',borderColor:'rgba(74,159,255,0.25)'},
  navLabel:{fontSize:9,letterSpacing:0.5,fontWeight:'600'},
});
