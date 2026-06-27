import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState , useMemo} from 'react';
import { Alert, Animated, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { ErrorBoundary } from '../components/ErrorBoundary';

const NAV = [{id:'chats',icon:'💬',label:'Chats',route:'/(tabs)/chats'},{id:'shield',icon:'🛡️',label:'Shield',route:'/dashboard'},{id:'community',icon:'🌐',label:'Community',route:'/communities'},{id:'vault',icon:'📦',label:'Vault',route:'/filevault'},{id:'alerts',icon:'🔔',label:'Alerts',route:'/notifications'}];

const TRUST_LEVELS=[{level:'Untrusted',min:0,max:20,color:'#EF4444',icon:'⛔'},{level:'Low',min:21,max:40,color:'#F59E0B',icon:'⚠️'},{level:'Moderate',min:41,max:60,color:'#4A9FFF',icon:'🔵'},{level:'High',min:61,max:80,color:'#22C55E',icon:'✅'},{level:'Verified',min:81,max:100,color:'#A78BFA',icon:'💎'}];
const getLevel=(score:number)=>TRUST_LEVELS.find(l=>score>=l.min&&score<=l.max)||TRUST_LEVELS[0];
// Personal trust notes — YOUR own assessment of contacts, stored on this device.
// No "blockchain" (there isn't one). Starts empty; persisted locally.
const STORAGE_KEY = 'vc_trustnotes';
const DEMO_ENTRIES: any[] = [];

function TrustScoreContent() {
  const S = useS();
  const { colors } = useTheme();
  const router=useRouter();
  const [entries,setEntries]=useState(DEMO_ENTRIES.map(e=>({...e})));
  const [selected,setSelected]=useState<any>(null);
  const [showDetail,setShowDetail]=useState(false);
  const [showAdd,setShowAdd]=useState(false);
  const [newName,setNewName]=useState('');
  const [newScore,setNewScore]=useState('50');
  const [newNotes,setNewNotes]=useState('');
  const [filter,setFilter]=useState<'all'|'verified'|'unverified'>('all');
  const [navTab,setNavTab]=useState('shield');
  const fadeIn=useRef(new Animated.Value(0)).current;
  const scoreAnim=useRef(new Animated.Value(0)).current;

  useEffect(()=>{ Animated.timing(fadeIn,{toValue:1,duration:500,useNativeDriver:true}).start(); },[fadeIn]);
  useEffect(()=>{ (async()=>{ try{ const raw=await AsyncStorage.getItem(STORAGE_KEY); if(raw){ const d=JSON.parse(raw); if(Array.isArray(d))setEntries(d); } }catch{} })(); },[]);
  useEffect(()=>{ AsyncStorage.setItem(STORAGE_KEY,JSON.stringify(entries)).catch(()=>{}); },[entries]);
  useEffect(()=>{ if(selected){ scoreAnim.setValue(0); Animated.timing(scoreAnim,{toValue:selected.score,duration:900,useNativeDriver:false}).start(); } },[selected, scoreAnim]);

  const markTrusted=(entry:any)=>{ const updated={...entry,verified:true,lastVerified:'Just now'}; setSelected(updated); setEntries(prev=>prev.map(e=>e.id===entry.id?updated:e)); };
  const adjustScore=(entry:any,delta:number)=>{ const ns=Math.max(0,Math.min(100,entry.score+delta)); const lvl=getLevel(ns); const updated={...entry,score:ns,level:lvl.level}; setSelected(updated); setEntries(prev=>prev.map(e=>e.id===entry.id?updated:e)); };
  const deleteEntry=(entry:any)=>{ Alert.alert('Remove Contact','Remove '+entry.contactName+' from TrustScore?',[{text:'Cancel',style:'cancel'},{text:'Remove',style:'destructive',onPress:()=>{ setEntries(prev=>prev.filter(e=>e.id!==entry.id)); setShowDetail(false); }}]); };
  const addEntry=()=>{ if(!newName.trim())return; const score=Math.max(0,Math.min(100,parseInt(newScore)||50)); const lvl=getLevel(score); const entry={id:Date.now().toString(),contactName:newName.trim(),emoji:'👤',score,level:lvl.level,interactions:0,lastVerified:'Never',notes:newNotes.trim(),verified:false}; setEntries(prev=>[entry,...prev]); setShowAdd(false); setNewName(''); setNewScore('50'); setNewNotes(''); };
  const handleNav=(item:typeof NAV[0])=>{ setNavTab(item.id); if(item.id!=='shield')router.push(item.route as any); };

  const filtered=entries.filter(e=>filter==='all'?true:filter==='verified'?e.verified:!e.verified);
  const avg=entries.length?Math.round(entries.reduce((a,e)=>a+e.score,0)/entries.length):0;

  return (
    <View style={S.container}>
      <LinearGradient colors={['#FFFFFF','#040F20','#060F24']} style={StyleSheet.absoluteFillObject}/>
      <Animated.View style={{flex:1,opacity:fadeIn}}>
        <View style={S.header}>
          <TouchableOpacity onPress={()=>router.back()} style={S.backBtn}><Ionicons name="arrow-back" size={24} color={colors.primary} /></TouchableOpacity>
          <View style={{flex:1}}>
            <Text style={S.title}>⛓️ TrustScore</Text>
            <Text style={{color:colors.textFaint,fontSize:9,letterSpacing:2}}>YOUR PRIVATE TRUST NOTES</Text>
          </View>
          <TouchableOpacity onPress={()=>setShowAdd(true)} style={{backgroundColor:'#1D4ED8',borderRadius:20,width:40,height:40,justifyContent:'center',alignItems:'center'}}><Ionicons name="add" size={24} color="#fff" /></TouchableOpacity>
        </View>

        <View style={{flexDirection:'row',paddingHorizontal:18,gap:8,marginBottom:14}}>
          {[{label:'Avg Score',value:avg.toString(),icon:'⭐',color:colors.primary},{label:'Verified',value:entries.filter(e=>e.verified).length.toString(),icon:'💎',color:'#A78BFA'},{label:'Total',value:entries.length.toString(),icon:'👥',color:colors.accent}].map((s,i)=>(
            <View key={i} style={{flex:1,backgroundColor:'rgba(10,22,40,0.8)',borderRadius:14,padding:12,alignItems:'center',borderWidth:1,borderColor:'rgba(255,255,255,0.06)',gap:3}}>
              <Text style={{fontSize:18}}>{s.icon}</Text>
              <Text style={{color:s.color,fontSize:18,fontWeight:'900'}}>{s.value}</Text>
              <Text style={{color:colors.textFaint,fontSize:8,letterSpacing:1}}>{s.label.toUpperCase()}</Text>
            </View>
          ))}
        </View>

        <View style={{flexDirection:'row',marginHorizontal:18,backgroundColor:'rgba(6,14,34,0.9)',borderRadius:14,padding:4,marginBottom:14}}>
          {(['all','verified','unverified'] as const).map(f=>(
            <TouchableOpacity key={f} onPress={()=>setFilter(f)} style={[{flex:1,paddingVertical:8,alignItems:'center',borderRadius:10},filter===f&&{backgroundColor:'rgba(10,22,40,0.9)',borderWidth:1,borderColor:'rgba(74,159,255,0.15)'}]}>
              <Text style={{color:filter===f?colors.primary:colors.textFaint,fontSize:10,fontWeight:'800',letterSpacing:1}}>{f.toUpperCase()}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <ScrollView contentContainerStyle={{paddingHorizontal:18,paddingBottom:110}} showsVerticalScrollIndicator={false}>
          {filtered.map((entry,i)=>{ const lvl=getLevel(entry.score); return (
            <TouchableOpacity key={i} onPress={()=>{ setSelected(entry); setShowDetail(true); }} style={S.entryRow}>
              <View style={{width:50,height:50,borderRadius:25,backgroundColor:lvl.color+'18',borderWidth:2,borderColor:lvl.color+'55',justifyContent:'center',alignItems:'center'}}><Text style={{fontSize:26}}>{entry.emoji}</Text></View>
              <View style={{flex:1}}>
                <View style={{flexDirection:'row',alignItems:'center',gap:8,marginBottom:4}}>
                  <Text style={{color:colors.text,fontSize:14,fontWeight:'800'}}>{entry.contactName}</Text>
                  {entry.verified&&<Text style={{fontSize:12}}>💎</Text>}
                </View>
                <View style={{height:5,backgroundColor:'rgba(255,255,255,0.06)',borderRadius:3,overflow:'hidden',marginBottom:4}}>
                  <View style={{width:(entry.score+'%') as any,height:5,backgroundColor:lvl.color,borderRadius:3}}/>
                </View>
                <Text style={{color:colors.textFaint,fontSize:10}}>{entry.interactions} interactions · {entry.lastVerified}</Text>
              </View>
              <View style={{alignItems:'flex-end',gap:4}}>
                <Text style={{color:lvl.color,fontSize:22,fontWeight:'900'}}>{entry.score}</Text>
                <View style={{backgroundColor:lvl.color+'18',borderRadius:7,paddingHorizontal:6,paddingVertical:2,borderWidth:1,borderColor:lvl.color+'44'}}><Text style={{color:lvl.color,fontSize:8,fontWeight:'800'}}>{lvl.level.toUpperCase()}</Text></View>
              </View>
            </TouchableOpacity>
          ); })}
          {entries.length===0 && (
            <View style={{alignItems:'center',marginTop:50}}>
              <Text style={{fontSize:42}}>🤝</Text>
              <Text style={{color:colors.textDim,fontSize:14,fontWeight:'800',marginTop:12}}>No trust notes yet</Text>
              <Text style={{color:colors.textFaint,fontSize:12,textAlign:'center',marginTop:6,paddingHorizontal:36,lineHeight:18}}>Tap + to record your own trust assessment of a contact. Saved privately on this device.</Text>
            </View>
          )}
        </ScrollView>
      </Animated.View>

      <Modal visible={showDetail&&!!selected} transparent animationType="slide">
        <TouchableOpacity style={{flex:1,backgroundColor:'rgba(0,0,0,0.7)'}} activeOpacity={1} onPress={()=>setShowDetail(false)}>
          <View style={{position:'absolute',bottom:0,left:0,right:0}}>
            <LinearGradient colors={['rgba(10,22,40,0.99)','rgba(6,14,34,0.99)']} style={{borderTopLeftRadius:28,borderTopRightRadius:28,padding:24,paddingBottom:44,borderWidth:1,borderColor:'rgba(74,159,255,0.12)'}}>
              {selected&&(()=>{ const lvl=getLevel(selected.score); return (
                <>
                  <View style={{flexDirection:'row',alignItems:'center',gap:14,marginBottom:20}}>
                    <View style={{width:60,height:60,borderRadius:30,backgroundColor:lvl.color+'18',borderWidth:2,borderColor:lvl.color,justifyContent:'center',alignItems:'center'}}><Text style={{fontSize:32}}>{selected.emoji}</Text></View>
                    <View style={{flex:1}}>
                      <Text style={{color:colors.text,fontSize:18,fontWeight:'900'}}>{selected.contactName}</Text>
                      <Text style={{color:lvl.color,fontSize:12,fontWeight:'700',marginTop:2}}>{lvl.icon} {lvl.level}</Text>
                    </View>
                    <Text style={{color:lvl.color,fontSize:36,fontWeight:'900'}}>{selected.score}</Text>
                  </View>
                  <View style={{flexDirection:'row',gap:8,marginBottom:16,justifyContent:'center'}}>
                    {[-10,-5,5,10].map(d=>(
                      <TouchableOpacity key={d} onPress={()=>adjustScore(selected,d)} style={{backgroundColor:d<0?colors.danger+'18':colors.accent+'18',borderRadius:12,paddingHorizontal:14,paddingVertical:10,borderWidth:1,borderColor:d<0?colors.danger:colors.accent}}>
                        <Text style={{color:d<0?colors.danger:colors.accent,fontSize:13,fontWeight:'800'}}>{d>0?'+':''}{d}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  {selected.notes?<Text style={{color:colors.textDim,fontSize:12,marginBottom:14,fontStyle:'italic'}}>&quot;{selected.notes}&quot;</Text>:null}
                  {null}
                  <View style={{flexDirection:'row',gap:8}}>
                    {!selected.verified&&<TouchableOpacity onPress={()=>markTrusted(selected)} style={{flex:1}}><LinearGradient colors={['#A78BFA','#7C3AED']} style={{borderRadius:14,paddingVertical:13,alignItems:'center'}}><Text style={{color:'#fff',fontSize:13,fontWeight:'800'}}>⛓️ Mark as Trusted</Text></LinearGradient></TouchableOpacity>}
                    <TouchableOpacity onPress={()=>deleteEntry(selected)} style={{backgroundColor:'rgba(239,68,68,0.1)',borderRadius:14,paddingVertical:13,paddingHorizontal:16,borderWidth:1,borderColor:colors.danger+'44'}}><Text style={{color:colors.danger,fontSize:13,fontWeight:'800'}}>Remove</Text></TouchableOpacity>
                  </View>
                </>
              ); })()}
            </LinearGradient>
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal visible={showAdd} transparent animationType="slide">
        <TouchableOpacity style={{flex:1,backgroundColor:'rgba(0,0,0,0.6)'}} activeOpacity={1} onPress={()=>setShowAdd(false)}>
          <View style={{position:'absolute',bottom:0,left:0,right:0}}>
            <LinearGradient colors={['rgba(10,22,40,0.99)','rgba(6,14,34,0.99)']} style={{borderTopLeftRadius:28,borderTopRightRadius:28,padding:24,paddingBottom:44,borderWidth:1,borderColor:'rgba(74,159,255,0.12)'}}>
              <Text style={{color:colors.text,fontSize:18,fontWeight:'900',marginBottom:20}}>Add Trust Entry</Text>
              <TextInput value={newName} onChangeText={setNewName} placeholder="Contact name..." placeholderTextColor={colors.textFaint} style={[S.input,{marginBottom:10}]}/>
              <TextInput value={newNotes} onChangeText={setNewNotes} placeholder="Notes (optional)..." placeholderTextColor={colors.textFaint} style={[S.input,{marginBottom:12}]}/>
              <Text style={{color:colors.textFaint,fontSize:11,marginBottom:8}}>Initial Score: {newScore}</Text>
              <View style={{flexDirection:'row',gap:8,marginBottom:16,flexWrap:'wrap'}}>
                {['0','20','40','60','80','100'].map(v=>(
                  <TouchableOpacity key={v} onPress={()=>setNewScore(v)} style={{backgroundColor:newScore===v?colors.primary+'22':'rgba(6,14,34,0.9)',borderRadius:10,paddingHorizontal:14,paddingVertical:8,borderWidth:1,borderColor:newScore===v?colors.primary:'rgba(255,255,255,0.08)'}}>
                    <Text style={{color:newScore===v?colors.primary:colors.textDim,fontSize:13,fontWeight:'700'}}>{v}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TouchableOpacity onPress={addEntry}>
                <LinearGradient colors={[colors.primary,colors.textDim]} style={{borderRadius:16,paddingVertical:14,alignItems:'center'}}><Text style={{color:'#fff',fontSize:15,fontWeight:'900'}}>Add to TrustScore</Text></LinearGradient>
              </TouchableOpacity>
            </LinearGradient>
          </View>
        </TouchableOpacity>
      </Modal>

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

export default function TrustScoreScreen() {
  const { colors } = useTheme();
  const S = useS();
  return (<ErrorBoundary fallbackTitle="TrustScore Error" fallbackMessage="TrustScore had a problem."><TrustScoreContent/></ErrorBoundary>);
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container:{flex:1,backgroundColor:'#FFFFFF'},
  header:{flexDirection:'row',alignItems:'center',paddingHorizontal:18,paddingTop:50,paddingBottom:16,gap:10},
  title:{color:'#fff',fontSize:20,fontWeight:'900'},
  backBtn:{width:36,height:36,borderRadius:18,backgroundColor:'rgba(10,22,40,0.8)',justifyContent:'center',alignItems:'center',borderWidth:1,borderColor:'rgba(255,255,255,0.06)'},
  entryRow:{flexDirection:'row',alignItems:'center',backgroundColor:'rgba(10,22,40,0.8)',borderRadius:18,padding:14,marginBottom:8,borderWidth:1,borderColor:'rgba(255,255,255,0.06)',gap:12},
  input:{backgroundColor:'rgba(6,14,34,0.9)',borderRadius:14,padding:15,color:'#fff',fontSize:14,borderWidth:1,borderColor:'rgba(255,255,255,0.08)'},
  navBar:{position:'absolute',bottom:18,left:14,right:14,backgroundColor:'rgba(4,12,28,0.92)',borderRadius:28,borderWidth:1,borderColor:'rgba(74,159,255,0.12)',paddingVertical:10,paddingHorizontal:6,flexDirection:'row',justifyContent:'space-around',alignItems:'center'},
  navItem:{alignItems:'center',gap:4,paddingVertical:6,paddingHorizontal:12,borderRadius:20,borderWidth:1,borderColor:'transparent'},
  navItemActive:{backgroundColor:'rgba(74,159,255,0.12)',borderColor:'rgba(74,159,255,0.25)'},
  navLabel:{fontSize:9,letterSpacing:0.5,fontWeight:'600'},
});
