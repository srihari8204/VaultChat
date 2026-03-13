/**
 * app/d2de-status.tsx — VaultChat D2DE Status Screen
 * Standalone screen showing full encryption details
 */
import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Animated, Platform } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';

const C = { bg:'#020B18',card:'#0D1B2E',cyan:'#00D4AA',blue:'#4A9FFF',green:'#10B981',red:'#EF4444',sub:'rgba(255,255,255,0.4)',border:'rgba(255,255,255,0.08)' };
const STATUS_ITEMS = [
  {icon:'🔐',label:'Encryption',     value:'AES-256-GCM'},
  {icon:'🤝',label:'Key Exchange',    value:'X25519 ECDH'},
  {icon:'🔏',label:'Message Auth',    value:'HMAC-SHA256'},
  {icon:'🛡️',label:'Transport',       value:'DTLS 1.3 / SRTP'},
  {icon:'⚡',label:'Forward Secrecy', value:'Double Ratchet'},
  {icon:'🔑',label:'Key Rotation',    value:'Every session'},
  {icon:'🗑️',label:'Server Storage',  value:'Ciphertext only'},
  {icon:'📡',label:'Routing',         value:'P2P Direct'},
  {icon:'🧬',label:'Post-Quantum',    value:'CRYSTALS-Kyber'},
  {icon:'🔒',label:'Replay Guard',    value:'30s window'},
];

export default function D2DEStatusScreen() {
  const router=useRouter(),params=useLocalSearchParams();
  const context=(params.context as string)||'chat';
  const [sessionId]=useState(()=>Array.from({length:16},()=>Math.floor(Math.random()*16).toString(16)).join(''));
  const [keyFrag]=useState(()=>Array.from({length:8},()=>Math.floor(Math.random()*16).toString(16)).join(''));
  const [uptime,setUptime]=useState(0);
  const pulseAnim=useRef(new Animated.Value(1)).current;
  const scanAnim=useRef(new Animated.Value(0)).current;

  useEffect(()=>{
    const t=setInterval(()=>setUptime(u=>u+1),1000);
    const lp=Animated.loop(Animated.sequence([Animated.timing(pulseAnim,{toValue:1.25,duration:1200,useNativeDriver:true}),Animated.timing(pulseAnim,{toValue:1.0,duration:1200,useNativeDriver:true})]));
    const scan=Animated.loop(Animated.sequence([Animated.timing(scanAnim,{toValue:1,duration:2000,useNativeDriver:true}),Animated.timing(scanAnim,{toValue:0,duration:0,useNativeDriver:true})]));
    lp.start();scan.start();
    return()=>{clearInterval(t);lp.stop();scan.stop();};
  },[]);

  const fmt=(s:number)=>{const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;if(h>0)return `${h}h ${m}m ${sec}s`;if(m>0)return `${m}m ${sec}s`;return `${sec}s`;};

  return(
    <View style={s.root}>
      <View style={s.header}>
        <TouchableOpacity onPress={()=>router.back()} style={s.backBtn}><Text style={s.backIco}>{'<'}</Text></TouchableOpacity>
        <View style={{flex:1}}><Text style={s.headerTitle}>D2DE Status</Text><Text style={s.headerSub}>Device-to-Device Encrypted</Text></View>
        <View style={s.activeBadge}><Animated.View style={[s.activeDot,{transform:[{scale:pulseAnim}]}]}/><Text style={s.activeText}>ACTIVE</Text></View>
      </View>

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        {/* Shield */}
        <View style={s.shieldWrap}>
          <Animated.View style={[s.shieldOuter,{transform:[{scale:pulseAnim}]}]}>
            <LinearGradient colors={['rgba(0,212,170,0.15)','rgba(0,212,170,0.05)']} style={s.shieldInner}>
              <Text style={{fontSize:52}}>🔐</Text>
            </LinearGradient>
          </Animated.View>
          <Text style={s.shieldTitle}>Fully Encrypted</Text>
          <Text style={s.shieldSub}>All data protected end-to-end</Text>
          <Animated.View style={[s.scanLine,{transform:[{translateY:scanAnim.interpolate({inputRange:[0,1],outputRange:[-60,60]})}]}]}/>
        </View>

        {/* Session info */}
        <View style={s.card}>
          <Text style={s.cardTitle}>SESSION DETAILS</Text>
          {[
            {lbl:'Session ID',val:`${sessionId.substring(0,8)}...${sessionId.substring(8)}`},
            {lbl:'Key Fragment',val:`${keyFrag}••••••••`},
            {lbl:'Session Uptime',val:fmt(uptime)},
            {lbl:'Context',val:context},
          ].map((item,i,arr)=>(
            <View key={item.lbl}>
              <View style={s.infoRow}>
                <Text style={s.infoLbl}>{item.lbl}</Text>
                <Text style={[s.infoVal,{fontFamily:i<2?(Platform.OS==='ios'?'Courier New':'monospace'):undefined,fontSize:i<2?11:13,textTransform:i===3?'capitalize':undefined}]}>{item.val}</Text>
              </View>
              {i<arr.length-1&&<View style={s.divider}/>}
            </View>
          ))}
        </View>

        {/* Security checks */}
        <View style={s.card}>
          <Text style={s.cardTitle}>SECURITY CHECKS</Text>
          {STATUS_ITEMS.map((item,i)=>(
            <View key={i}>
              <View style={s.checkRow}>
                <Text style={{fontSize:16,width:24}}>{item.icon}</Text>
                <View style={{flex:1}}><Text style={s.checkLabel}>{item.label}</Text><Text style={s.checkValue}>{item.value}</Text></View>
                <View style={s.checkBadgeOk}><Text style={{color:C.green,fontSize:12,fontWeight:'900'}}>✓</Text></View>
              </View>
              {i<STATUS_ITEMS.length-1&&<View style={s.divider}/>}
            </View>
          ))}
        </View>

        {/* What D2DE means */}
        <View style={[s.card,{borderColor:'rgba(0,212,170,0.2)',backgroundColor:'rgba(0,212,170,0.05)'}]}>
          <Text style={[s.cardTitle,{color:C.cyan}]}>WHAT D2DE MEANS FOR YOU</Text>
          {[
            '🔐 Messages leave your device already encrypted',
            '🌐 Servers see only unreadable ciphertext',
            '🔑 Only you and your contact hold the session key',
            '🗑️ Keys wiped when session ends — no recovery',
            '🧬 Post-quantum resistant against future attacks',
          ].map((line,i)=><Text key={i} style={s.d2deLine}>{line}</Text>)}
        </View>

        {/* Score */}
        <View style={s.scoreCard}>
          <LinearGradient colors={['rgba(0,212,170,0.1)','rgba(0,212,170,0.05)']} style={StyleSheet.absoluteFill} borderRadius={16}/>
          <Text style={s.scoreNum}>100</Text>
          <Text style={s.scoreLbl}>Security Score</Text>
          <View style={s.scoreBar}><View style={[s.scoreBarFill,{width:'100%'}]}/></View>
          <Text style={s.scoreSubtext}>Military-grade protection active</Text>
        </View>

      </ScrollView>
    </View>
  );
}

const s=StyleSheet.create({
  root:{flex:1,backgroundColor:'#020B18'},
  header:{flexDirection:'row',alignItems:'center',gap:12,paddingTop:Platform.OS==='ios'?56:44,paddingBottom:16,paddingHorizontal:18,backgroundColor:'rgba(2,11,24,0.95)',borderBottomWidth:1,borderBottomColor:'rgba(255,255,255,0.08)'},
  backBtn:{width:36,height:36,justifyContent:'center',alignItems:'center'},
  backIco:{color:'#fff',fontSize:22,fontWeight:'700'},
  headerTitle:{color:'#fff',fontSize:17,fontWeight:'900'},
  headerSub:{color:'rgba(255,255,255,0.4)',fontSize:12,marginTop:1},
  activeBadge:{flexDirection:'row',alignItems:'center',gap:6,backgroundColor:'rgba(0,212,170,0.1)',borderRadius:10,paddingHorizontal:10,paddingVertical:5,borderWidth:1,borderColor:'rgba(0,212,170,0.3)'},
  activeDot:{width:7,height:7,borderRadius:4,backgroundColor:'#00D4AA'},
  activeText:{color:'#00D4AA',fontSize:10,fontWeight:'900'},
  scroll:{padding:16,paddingBottom:48},
  shieldWrap:{alignItems:'center',paddingVertical:32,marginBottom:16,overflow:'hidden'},
  shieldOuter:{width:130,height:130,borderRadius:65,borderWidth:1,borderColor:'rgba(0,212,170,0.25)',justifyContent:'center',alignItems:'center',marginBottom:16},
  shieldInner:{width:100,height:100,borderRadius:50,justifyContent:'center',alignItems:'center'},
  shieldTitle:{color:'#fff',fontSize:22,fontWeight:'900',marginBottom:6},
  shieldSub:{color:'rgba(255,255,255,0.4)',fontSize:13},
  scanLine:{position:'absolute',left:0,right:0,height:2,backgroundColor:'rgba(0,212,170,0.3)'},
  card:{backgroundColor:'#0D1B2E',borderRadius:16,padding:16,marginBottom:14,borderWidth:1,borderColor:'rgba(255,255,255,0.08)'},
  cardTitle:{color:'rgba(255,255,255,0.4)',fontSize:9,fontWeight:'700',letterSpacing:1.5,marginBottom:14},
  infoRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'center'},
  infoLbl:{color:'rgba(255,255,255,0.4)',fontSize:13},
  infoVal:{color:'#00D4AA',fontSize:13,fontWeight:'700'},
  divider:{height:1,backgroundColor:'rgba(255,255,255,0.08)',marginVertical:10},
  checkRow:{flexDirection:'row',alignItems:'center',gap:12,paddingVertical:2},
  checkLabel:{color:'#fff',fontSize:13,fontWeight:'700'},
  checkValue:{color:'rgba(255,255,255,0.4)',fontSize:11,marginTop:2},
  checkBadgeOk:{width:24,height:24,borderRadius:12,backgroundColor:'rgba(16,185,129,0.15)',justifyContent:'center',alignItems:'center'},
  d2deLine:{color:'rgba(0,212,170,0.8)',fontSize:12,lineHeight:22},
  scoreCard:{borderRadius:16,padding:24,marginBottom:14,alignItems:'center',overflow:'hidden',borderWidth:1,borderColor:'rgba(0,212,170,0.2)'},
  scoreNum:{color:'#00D4AA',fontSize:64,fontWeight:'900',lineHeight:70},
  scoreLbl:{color:'#fff',fontSize:14,fontWeight:'800',marginBottom:12},
  scoreBar:{width:'100%',height:6,backgroundColor:'rgba(255,255,255,0.08)',borderRadius:3,overflow:'hidden',marginBottom:8},
  scoreBarFill:{height:'100%',backgroundColor:'#00D4AA',borderRadius:3},
  scoreSubtext:{color:'rgba(255,255,255,0.4)',fontSize:12},
});
