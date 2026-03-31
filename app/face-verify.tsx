/**
 * app/face-verify.tsx
 * Face unlock using expo-camera + expo-local-authentication ONLY.
 * Zero vision-camera imports. Zero new packages.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { CameraView, useCameraPermissions } from 'expo-camera';
// expo-face-detector is deprecated (removed in SDK 51+)
// Face detection is handled via biometric prompt instead
import * as Haptics from 'expo-haptics';
import * as LocalAuthentication from 'expo-local-authentication';
import { router } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated, Dimensions, Platform, StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

const C = {
  bg:'#060E1E', panel:'#0D1F3C', cyan:'#4A9FFF',
  cyan2:'#00B4D8', green:'#00FF9D', coral:'#FF4D6D',
  white:'#FFFFFF', muted:'#7BA7C4', dark:'#030A14',
};
const { width: SW } = Dimensions.get('window');
const TOP = Platform.OS==='android'?(StatusBar.currentHeight??0):44;
const DETECT_FRAMES = 10;

const PHASE = {
  SCANNING:'SCANNING', BIOMETRIC:'BIOMETRIC',
  MATCH:'MATCH', NO_MATCH:'NO_MATCH', NOT_SET:'NOT_SET',
} as const;
type P = typeof PHASE[keyof typeof PHASE];

function Brackets({color,pulse}:{color:string;pulse:Animated.Value}) {
  const sz=SW*0.64;
  const corners=[
    {top:0,left:0,borderTopWidth:3,borderLeftWidth:3},
    {top:0,right:0,borderTopWidth:3,borderRightWidth:3},
    {bottom:0,left:0,borderBottomWidth:3,borderLeftWidth:3},
    {bottom:0,right:0,borderBottomWidth:3,borderRightWidth:3},
  ];
  return (
    <View style={{width:sz,height:sz*1.28,position:'relative'}}>
      {corners.map((c,i)=>(
        <Animated.View key={i} style={[{position:'absolute',width:34,height:34,borderColor:color,borderStyle:'solid',opacity:pulse},c]}/>
      ))}
    </View>
  );
}

export default function FaceVerifyScreen() {
  const [perm, reqPerm] = useCameraPermissions();
  const [phase, setPhase] = useState<P>(PHASE.SCANNING);
  const [fc, setFc] = useState(0);

  const fcRef  = useRef(0);
  const doneRef= useRef(false);
  const pulse  = useRef(new Animated.Value(1)).current;
  const resOp  = useRef(new Animated.Value(0)).current;
  const resSc  = useRef(new Animated.Value(0.85)).current;

  useEffect(()=>{
    AsyncStorage.getItem('vaultchat_faceid_enabled').then(v=>{
      if(!v) setPhase(PHASE.NOT_SET);
    });
    if(!perm?.granted) reqPerm();
  },[perm?.granted, reqPerm]);

  useEffect(()=>{
    if(phase!==PHASE.SCANNING) return;
    const lp=Animated.loop(Animated.sequence([
      Animated.timing(pulse,{toValue:0.3,duration:800,useNativeDriver:true}),
      Animated.timing(pulse,{toValue:1.0,duration:800,useNativeDriver:true}),
    ]));
    lp.start(); return ()=>lp.stop();
  },[phase, pulse]);

  // Simulate face scanning progress, then trigger biometric auth
  useEffect(()=>{
    if(phase!==PHASE.SCANNING||doneRef.current||!perm?.granted) return;
    const showResultInEffect=(matched:boolean)=>{
      setPhase(matched?PHASE.MATCH:PHASE.NO_MATCH);
      Animated.parallel([
        Animated.spring(resOp,{toValue:1,tension:50,friction:8,useNativeDriver:true}),
        Animated.spring(resSc,{toValue:1,tension:50,friction:8,useNativeDriver:true}),
      ]).start();
      if (Platform.OS !== 'web') Haptics.notificationAsync(matched
        ?Haptics.NotificationFeedbackType.Success
        :Haptics.NotificationFeedbackType.Error);
      if(matched) setTimeout(()=>router.replace('/(tabs)/chats' as any),1500);
    };
    const triggerBio=async()=>{
      if(Platform.OS==='web'){showResultInEffect(false);return;}
      setPhase(PHASE.BIOMETRIC);
      try {
        const res=await LocalAuthentication.authenticateAsync({
          promptMessage:'Unlock VaultChat',
          fallbackLabel:'Use PIN',
          cancelLabel:'Cancel',
          disableDeviceFallback:false,
        });
        showResultInEffect(res.success);
      } catch { showResultInEffect(false); }
    };
    const interval=setInterval(()=>{
      if(doneRef.current) return;
      fcRef.current+=1;
      setFc(fcRef.current);
      if(fcRef.current>=DETECT_FRAMES){
        doneRef.current=true;
        clearInterval(interval);
        triggerBio();
      }
    },300);
    return ()=>clearInterval(interval);
  },[phase,perm?.granted,resOp,resSc,router]);

  const retry=()=>{
    fcRef.current=0; doneRef.current=false;
    setFc(0); resOp.setValue(0); resSc.setValue(0.85);
    setPhase(PHASE.SCANNING);
  };

  if((phase===PHASE.SCANNING||phase===PHASE.BIOMETRIC)&&perm?.granted) {
    const pct=Math.min(fc/DETECT_FRAMES,1);
    return (
      <View style={{flex:1,backgroundColor:'#000'}}>
        <StatusBar barStyle="light-content" translucent backgroundColor="transparent"/>
        {phase===PHASE.SCANNING&&(
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="front"
          />
        )}
        <View style={{position:'absolute',top:0,left:0,right:0,height:160,backgroundColor:'rgba(6,14,30,0.70)'}} pointerEvents="none"/>
        <View style={{position:'absolute',top:TOP+10,left:0,right:0,alignItems:'center'}} pointerEvents="none">
          <Text style={{fontSize:10,letterSpacing:5,color:C.cyan,fontWeight:'500',marginBottom:4}}>V A U L T C H A T</Text>
          <Text style={{fontSize:22,fontWeight:'800',color:C.white}}>
            {phase===PHASE.BIOMETRIC?'Confirming…':'Face Unlock'}
          </Text>
        </View>
        {phase===PHASE.SCANNING&&(
          <View style={[StyleSheet.absoluteFill,{alignItems:'center',justifyContent:'center'}]} pointerEvents="none">
            <Brackets color={pct>0.5?C.cyan:C.cyan2} pulse={pulse}/>
          </View>
        )}
        {phase===PHASE.BIOMETRIC&&(
          <View style={{flex:1,alignItems:'center',justifyContent:'center'}}>
            <View style={{width:110,height:110,borderRadius:55,backgroundColor:C.panel,alignItems:'center',justifyContent:'center',borderWidth:2,borderColor:C.cyan}}>
              <Text style={{fontSize:52}}>🔒</Text>
            </View>
            <Text style={{color:C.muted,fontSize:14,marginTop:20,fontWeight:'600'}}>Confirm with biometrics…</Text>
          </View>
        )}
        {phase===PHASE.SCANNING&&(
          <View style={{position:'absolute',bottom:100,left:32,right:32}} pointerEvents="none">
            <View style={{height:5,backgroundColor:'#112233',borderRadius:3,overflow:'hidden',marginBottom:10}}>
              <View style={{height:'100%' as any,width:(`${Math.round(pct*100)}%`) as any,backgroundColor:C.cyan,borderRadius:3}}/>
            </View>
            <Text style={{fontSize:14,fontWeight:'600',color:C.white,textAlign:'center'}}>
              {fc===0?'Look at camera to unlock…':`Scanning ${Math.round(pct*100)}%`}
            </Text>
          </View>
        )}
      </View>
    );
  }

  if(phase===PHASE.MATCH) return (
    <View style={[s.root,{alignItems:'center',justifyContent:'center',paddingHorizontal:26}]}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg}/>
      <Animated.View style={[s.card,{borderColor:C.green,opacity:resOp,transform:[{scale:resSc}]}]}>
        <Text style={{fontSize:60,color:C.green,marginBottom:10}}>✓</Text>
        <Text style={{fontSize:26,fontWeight:'800',color:C.green,marginBottom:8}}>Unlocked</Text>
        <Text style={{fontSize:14,color:C.muted,textAlign:'center'}}>Opening VaultChat…</Text>
      </Animated.View>
    </View>
  );

  if(phase===PHASE.NO_MATCH) return (
    <View style={[s.root,{alignItems:'center',justifyContent:'center',paddingHorizontal:26}]}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg}/>
      <Animated.View style={[s.card,{borderColor:C.coral,opacity:resOp,transform:[{scale:resSc}]}]}>
        <Text style={{fontSize:60,color:C.coral,marginBottom:10}}>✕</Text>
        <Text style={{fontSize:26,fontWeight:'800',color:C.coral,marginBottom:8}}>Not Verified</Text>
        <Text style={{fontSize:14,color:C.muted,textAlign:'center'}}>Biometric check failed or cancelled.</Text>
      </Animated.View>
      <TouchableOpacity style={[s.btn,{marginTop:20}]} onPress={retry}>
        <Text style={s.btxt}>Try Again</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[s.btn,{backgroundColor:C.panel,marginTop:12}]}
        onPress={()=>router.replace('/pinentry' as any)}>
        <Text style={[s.btxt,{color:C.muted}]}>Use PIN Instead</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={[s.root,{alignItems:'center',justifyContent:'center',paddingHorizontal:26}]}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg}/>
      <Text style={{fontSize:26,fontWeight:'800',color:C.coral,textAlign:'center',marginBottom:12}}>Face ID Not Set Up</Text>
      <Text style={{fontSize:14,color:C.muted,textAlign:'center',marginBottom:32}}>Set up Face ID first.</Text>
      <TouchableOpacity style={s.btn} onPress={()=>router.replace('/facescan' as any)}>
        <Text style={s.btxt}>Set Up Face ID</Text>
      </TouchableOpacity>
    </View>
  );
}

const s=StyleSheet.create({
  root:{flex:1,backgroundColor:C.bg,paddingTop:TOP},
  card:{width:'100%',borderRadius:16,borderWidth:2,backgroundColor:C.panel,padding:28,alignItems:'center'},
  btn:{backgroundColor:C.cyan,paddingVertical:14,paddingHorizontal:32,borderRadius:12,width:'100%',alignItems:'center'},
  btxt:{fontSize:16,fontWeight:'700',color:C.dark},
});
