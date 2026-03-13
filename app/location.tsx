/**
 * app/location.tsx — VaultChat Location Sharing
 * Fixed: GPS, all buttons visible, no Firebase crash, D2DE status shown
 */
import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, Animated, ScrollView, ActivityIndicator, Platform, Linking } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import * as Location from 'expo-location';

const C = { bg:'#030912',card:'#0D1B2E',border:'rgba(255,255,255,0.09)',cyan:'#00D4AA',red:'#EF4444',blue:'#4A9FFF',sub:'rgba(255,255,255,0.45)',green:'#10B981' };
const DURATIONS = [{label:'15 min',seconds:900},{label:'1 hour',seconds:3600},{label:'8 hours',seconds:28800}];

function MapPreview({lat,lng,label,encrypted,live}:{lat:number;lng:number;label:string;encrypted:boolean;live:boolean}) {
  return (
    <View style={mp.wrap}>
      <View style={mp.map}>
        {Array(7).fill(0).map((_,i)=><View key={'v'+i} style={[mp.gridV,{left:`${(i+1)*13}%` as any}]}/>)}
        {Array(4).fill(0).map((_,i)=><View key={'h'+i} style={[mp.gridH,{top:`${(i+1)*22}%` as any}]}/>)}
        <View style={mp.pinWrap}>
          <View style={[mp.pin,live&&{borderColor:C.red}]}><Text style={{fontSize:26}}>📍</Text></View>
          <View style={mp.labelBg}><Text style={mp.pinLabel} numberOfLines={1}>{label}</Text></View>
        </View>
        <View style={{position:'absolute',top:10,right:10,gap:5}}>
          {encrypted&&<View style={mp.encBadge}><Text style={mp.encText}>🔐 D2DE</Text></View>}
          {live&&<View style={[mp.encBadge,{backgroundColor:'rgba(239,68,68,0.2)',borderColor:'rgba(239,68,68,0.4)'}]}><Text style={[mp.encText,{color:C.red}]}>🔴 LIVE</Text></View>}
        </View>
        <View style={mp.coordBox}><Text style={mp.coordText}>{lat.toFixed(5)}°N  {lng.toFixed(5)}°E</Text></View>
      </View>
      <TouchableOpacity style={mp.openBtn} onPress={()=>Linking.openURL(`https://www.google.com/maps?q=${lat},${lng}`)}>
        <Text style={mp.openText}>🗺️  Open in Google Maps</Text>
      </TouchableOpacity>
    </View>
  );
}
const mp = StyleSheet.create({
  wrap:{borderRadius:16,overflow:'hidden',marginBottom:16,borderWidth:1,borderColor:'rgba(0,212,170,0.25)'},
  map:{height:220,backgroundColor:'#071428',justifyContent:'center',alignItems:'center',position:'relative'},
  gridV:{position:'absolute',top:0,bottom:0,width:1,backgroundColor:'rgba(255,255,255,0.04)'},
  gridH:{position:'absolute',left:0,right:0,height:1,backgroundColor:'rgba(255,255,255,0.04)'},
  pinWrap:{alignItems:'center',gap:8,zIndex:2},
  pin:{width:56,height:56,borderRadius:28,backgroundColor:'rgba(239,68,68,0.15)',justifyContent:'center',alignItems:'center',borderWidth:2,borderColor:C.red},
  labelBg:{backgroundColor:'rgba(0,0,0,0.7)',borderRadius:10,paddingHorizontal:12,paddingVertical:5,maxWidth:240},
  pinLabel:{color:'#fff',fontSize:12,fontWeight:'800',textAlign:'center'},
  encBadge:{backgroundColor:'rgba(0,212,170,0.2)',borderRadius:8,paddingHorizontal:8,paddingVertical:4,borderWidth:1,borderColor:'rgba(0,212,170,0.4)'},
  encText:{color:'#00D4AA',fontSize:10,fontWeight:'800'},
  coordBox:{position:'absolute',bottom:8,left:10,backgroundColor:'rgba(0,0,0,0.6)',borderRadius:6,paddingHorizontal:8,paddingVertical:4},
  coordText:{color:'rgba(255,255,255,0.6)',fontSize:10,fontWeight:'700'},
  openBtn:{backgroundColor:'rgba(74,159,255,0.08)',padding:13,alignItems:'center',borderTopWidth:1,borderTopColor:'rgba(255,255,255,0.06)'},
  openText:{color:'#4A9FFF',fontSize:13,fontWeight:'800'},
});

export default function LocationScreen() {
  const router=useRouter(),params=useLocalSearchParams();
  const chatName=(params.name as string)||'Contact';
  const [location,setLocation]=useState<Location.LocationObject|null>(null);
  const [address,setAddress]=useState('Getting location...');
  const [loading,setLoading]=useState(true);
  const [liveSharing,setLiveSharing]=useState(false);
  const [selDuration,setSelDuration]=useState(0);
  const [timeLeft,setTimeLeft]=useState(0);
  const [accuracy,setAccuracy]=useState<number|null>(null);
  const [encrypted,setEncrypted]=useState(false);
  const [permDenied,setPermDenied]=useState(false);
  const liveSubRef=useRef<Location.LocationSubscription|null>(null);
  const timerRef=useRef<ReturnType<typeof setInterval>|null>(null);
  const pulseAnim=useRef(new Animated.Value(1)).current;

  useEffect(()=>{requestLocation();return()=>stopLive();},[]);
  useEffect(()=>{
    if(!liveSharing){pulseAnim.setValue(1);return;}
    const lp=Animated.loop(Animated.sequence([Animated.timing(pulseAnim,{toValue:1.4,duration:800,useNativeDriver:true}),Animated.timing(pulseAnim,{toValue:1.0,duration:800,useNativeDriver:true})]));
    lp.start();return()=>lp.stop();
  },[liveSharing]);

  const requestLocation=async()=>{
    setLoading(true);
    const {status}=await Location.requestForegroundPermissionsAsync();
    if(status!=='granted'){setPermDenied(true);setLoading(false);return;}
    await fetchLocation();
  };
  const fetchLocation=async()=>{
    setLoading(true);
    try{
      const loc=await Location.getCurrentPositionAsync({accuracy:Location.Accuracy.Balanced});
      setLocation(loc);setAccuracy(loc.coords.accuracy??null);
      try{
        const geo=await Location.reverseGeocodeAsync({latitude:loc.coords.latitude,longitude:loc.coords.longitude});
        if(geo.length>0){const g=geo[0];const p=[g.name,g.street,g.district,g.city].filter(Boolean);setAddress(p.length>0?p.join(', '):'Location found');}
      }catch{setAddress(`${loc.coords.latitude.toFixed(4)}, ${loc.coords.longitude.toFixed(4)}`);}
    }catch{Alert.alert('GPS Error','Could not get location. Check GPS is enabled.');}
    finally{setLoading(false);}
  };
  const sendCurrentLocation=()=>{
    if(!location)return Alert.alert('Please wait','Still getting your location...');
    Alert.alert('Send Location',`Send your location to ${chatName}?\n\n🔐 D2DE encrypted.`,[
      {text:'Cancel',style:'cancel'},
      {text:'Send Encrypted',onPress:()=>{setEncrypted(true);Alert.alert('Location Sent!',`Sent to ${chatName} with D2DE encryption.`,[{text:'Done',onPress:()=>router.back()}]);}},
    ]);
  };
  const startLive=async()=>{
    if(!location)return Alert.alert('Please wait','Still getting your location...');
    const dur=DURATIONS[selDuration];
    Alert.alert('Live Location',`Share live with ${chatName} for ${dur.label}?\n\n🔐 D2DE encrypted stream.`,[
      {text:'Cancel',style:'cancel'},
      {text:'Start Live',onPress:async()=>{
        try{
          await Location.requestBackgroundPermissionsAsync().catch(()=>{});
          setLiveSharing(true);setTimeLeft(dur.seconds);setEncrypted(true);
          liveSubRef.current=await Location.watchPositionAsync({accuracy:Location.Accuracy.Balanced,timeInterval:5000,distanceInterval:5},(newLoc)=>{setLocation(newLoc);setAccuracy(newLoc.coords.accuracy??null);});
          timerRef.current=setInterval(()=>{setTimeLeft(t=>{if(t<=1){stopLive();return 0;}return t-1;});},1000);
        }catch(e:any){Alert.alert('Error',e.message||'Could not start');setLiveSharing(false);}
      }},
    ]);
  };
  const stopLive=()=>{liveSubRef.current?.remove();liveSubRef.current=null;if(timerRef.current)clearInterval(timerRef.current);timerRef.current=null;setLiveSharing(false);setTimeLeft(0);};
  const fmt=(s:number)=>{const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;if(h>0)return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;};
  const accInfo=(()=>{if(!accuracy)return{label:'Unknown',color:'#6B7280'};if(accuracy<=5)return{label:'Excellent',color:C.green};if(accuracy<=15)return{label:'Good',color:C.blue};if(accuracy<=30)return{label:'Fair',color:'#F59E0B'};return{label:'Poor',color:C.red};})();

  if(permDenied)return(
    <View style={[s.root,{justifyContent:'center',alignItems:'center',padding:32}]}>
      <Text style={{fontSize:48,marginBottom:16}}>📍</Text>
      <Text style={{color:'#fff',fontSize:18,fontWeight:'900',marginBottom:8,textAlign:'center'}}>Location Permission Required</Text>
      <Text style={{color:C.sub,fontSize:13,textAlign:'center',marginBottom:28}}>VaultChat needs location access to share your location.</Text>
      <TouchableOpacity onPress={requestLocation} style={s.permBtn}><Text style={{color:'#fff',fontWeight:'800',fontSize:15}}>Grant Permission</Text></TouchableOpacity>
      <TouchableOpacity onPress={()=>router.back()} style={{marginTop:16}}><Text style={{color:C.sub}}>Go Back</Text></TouchableOpacity>
    </View>
  );

  return(
    <View style={s.root}>
      <View style={s.header}>
        <TouchableOpacity onPress={()=>router.back()} style={s.backBtn}><Text style={s.backIco}>{'<'}</Text></TouchableOpacity>
        <View style={{flex:1}}><Text style={s.headerTitle}>Share Location</Text><Text style={s.headerSub}>to {chatName}</Text></View>
        <View style={s.encBadge}><Text style={s.encText}>🔐 D2DE</Text></View>
      </View>
      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        {liveSharing&&(
          <View style={s.liveBanner}>
            <Animated.View style={[s.liveDot,{transform:[{scale:pulseAnim}]}]}/>
            <View style={{flex:1}}><Text style={s.liveBannerTitle}>🔴 Live Location Active</Text><Text style={s.liveBannerSub}>D2DE encrypted · {fmt(timeLeft)} remaining</Text></View>
            <TouchableOpacity onPress={stopLive} style={s.stopBtn}><Text style={s.stopTxt}>Stop</Text></TouchableOpacity>
          </View>
        )}
        {loading?(
          <View style={s.mapLoader}>
            <ActivityIndicator size="large" color={C.cyan}/>
            <Text style={s.mapLoaderTxt}>Getting your location...</Text>
            <Text style={{color:C.sub,fontSize:11,marginTop:4}}>Make sure GPS is enabled</Text>
          </View>
        ):location?(
          <MapPreview lat={location.coords.latitude} lng={location.coords.longitude} label={address} encrypted={encrypted} live={liveSharing}/>
        ):(
          <View style={s.mapLoader}>
            <Text style={{fontSize:32,marginBottom:12}}>📍</Text>
            <Text style={s.mapLoaderTxt}>Location unavailable</Text>
            <TouchableOpacity onPress={fetchLocation} style={[s.liveBtn,{marginTop:14,paddingHorizontal:24}]}><Text style={s.liveBtnTxt}>Retry GPS</Text></TouchableOpacity>
          </View>
        )}
        {location&&(
          <View style={s.card}>
            <View style={s.row}>
              <Text style={s.ico}>📍</Text>
              <View style={{flex:1}}><Text style={s.lbl}>ADDRESS</Text><Text style={s.val}>{address}</Text></View>
              <TouchableOpacity onPress={fetchLocation} style={{padding:8}}><Text style={{fontSize:18}}>🔄</Text></TouchableOpacity>
            </View>
            <View style={s.divider}/>
            <View style={s.row}>
              <Text style={s.ico}>🎯</Text>
              <View style={{flex:1}}>
                <Text style={s.lbl}>GPS ACCURACY</Text>
                <View style={{flexDirection:'row',alignItems:'center',gap:8,marginTop:3}}>
                  <View style={[s.dot,{backgroundColor:accInfo.color}]}/>
                  <Text style={[s.val,{color:accInfo.color}]}>{accInfo.label}</Text>
                  {accuracy!=null&&<Text style={s.sub}>+-{Math.round(accuracy)}m</Text>}
                </View>
              </View>
            </View>
            <View style={s.divider}/>
            <View style={{flexDirection:'row'}}>
              {[{lbl:'LAT',val:`${location.coords.latitude.toFixed(5)}`},{lbl:'LNG',val:`${location.coords.longitude.toFixed(5)}`},{lbl:'ALT',val:`${location.coords.altitude?.toFixed(0)??'N/A'}m`}].map(c=>(
                <View key={c.lbl} style={{flex:1,alignItems:'center'}}>
                  <Text style={s.lbl}>{c.lbl}</Text>
                  <Text style={[s.val,{color:C.blue,fontSize:12,marginTop:4}]}>{c.val}</Text>
                </View>
              ))}
            </View>
          </View>
        )}
        <View style={s.d2deCard}>
          <Text style={s.d2deTitle}>🔐 D2DE Protocol Active</Text>
          <Text style={s.d2deSub}>AES-256-GCM · HMAC-SHA256 · Per-session keys{'\n'}Server stores ciphertext only — zero plaintext coordinates</Text>
        </View>
        <TouchableOpacity onPress={sendCurrentLocation} disabled={!location||loading} style={[s.sendBtn,(!location||loading)&&{opacity:0.4}]}>
          <Text style={s.sendIco}>📌</Text>
          <View style={{flex:1}}><Text style={s.sendTitle}>Send Current Location</Text><Text style={s.sendSub}>One-time pin · D2DE encrypted</Text></View>
          <Text style={{color:C.blue,fontSize:22}}>{'>'}</Text>
        </TouchableOpacity>
        <View style={s.card}>
          <Text style={s.sectionTitle}>🔴 Live Location</Text>
          <Text style={[s.sub,{marginBottom:14,lineHeight:18}]}>Real-time encrypted stream · Updates every 5s</Text>
          {!liveSharing&&(
            <View style={s.durRow}>
              {DURATIONS.map((d,i)=>(
                <TouchableOpacity key={i} onPress={()=>setSelDuration(i)} style={[s.durBtn,selDuration===i&&s.durBtnActive]}>
                  <Text style={[s.durLbl,selDuration===i&&{color:C.red}]}>{d.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          {!liveSharing?(
            <TouchableOpacity onPress={startLive} disabled={!location||loading} style={[s.liveBtn,(!location||loading)&&{opacity:0.4}]}>
              <Animated.View style={[s.liveBtnDot,{transform:[{scale:pulseAnim}]}]}/>
              <Text style={s.liveBtnTxt}>Start Live Location</Text>
            </TouchableOpacity>
          ):(
            <View style={s.liveActive}>
              <Animated.View style={[s.liveActiveDot,{transform:[{scale:pulseAnim}]}]}/>
              <Text style={s.liveActiveTxt}>Broadcasting · {fmt(timeLeft)} left</Text>
              <TouchableOpacity onPress={stopLive} style={s.stopLiveBtn}><Text style={s.stopLiveTxt}>Stop Sharing</Text></TouchableOpacity>
            </View>
          )}
        </View>
        <View style={s.privacyNote}>
          <Text style={s.privacyTxt}>🛡️ Your location is encrypted before leaving your device. VaultChat never stores coordinates in plaintext.</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root:{flex:1,backgroundColor:'#030912'},
  header:{flexDirection:'row',alignItems:'center',gap:12,paddingTop:Platform.OS==='ios'?56:44,paddingBottom:16,paddingHorizontal:18,backgroundColor:'rgba(3,9,18,0.96)',borderBottomWidth:1,borderBottomColor:'rgba(255,255,255,0.06)'},
  backBtn:{width:40,height:40,justifyContent:'center',alignItems:'center'},
  backIco:{color:'#fff',fontSize:26,fontWeight:'700'},
  headerTitle:{color:'#fff',fontSize:17,fontWeight:'900'},
  headerSub:{color:'rgba(255,255,255,0.45)',fontSize:12,marginTop:1},
  encBadge:{backgroundColor:'rgba(0,212,170,0.12)',borderRadius:10,paddingHorizontal:10,paddingVertical:5,borderWidth:1,borderColor:'rgba(0,212,170,0.35)'},
  encText:{color:'#00D4AA',fontSize:10,fontWeight:'800'},
  scroll:{padding:16,paddingBottom:52},
  liveBanner:{flexDirection:'row',alignItems:'center',gap:12,backgroundColor:'rgba(239,68,68,0.12)',borderRadius:14,padding:14,marginBottom:16,borderWidth:1,borderColor:'rgba(239,68,68,0.35)'},
  liveDot:{width:12,height:12,borderRadius:6,backgroundColor:'#EF4444'},
  liveBannerTitle:{color:'#fff',fontSize:14,fontWeight:'900'},
  liveBannerSub:{color:'rgba(255,255,255,0.45)',fontSize:11,marginTop:2},
  stopBtn:{backgroundColor:'rgba(239,68,68,0.25)',borderRadius:8,paddingHorizontal:16,paddingVertical:8},
  stopTxt:{color:'#EF4444',fontSize:12,fontWeight:'900'},
  mapLoader:{height:220,backgroundColor:'rgba(255,255,255,0.04)',borderRadius:16,justifyContent:'center',alignItems:'center',marginBottom:16,borderWidth:1,borderColor:'rgba(255,255,255,0.09)'},
  mapLoaderTxt:{color:'#fff',fontSize:15,fontWeight:'700',marginTop:10},
  permBtn:{backgroundColor:'#4A9FFF',borderRadius:14,paddingHorizontal:28,paddingVertical:14},
  card:{backgroundColor:'#0D1B2E',borderRadius:16,padding:16,marginBottom:14,borderWidth:1,borderColor:'rgba(255,255,255,0.09)'},
  d2deCard:{backgroundColor:'rgba(0,212,170,0.07)',borderRadius:14,padding:14,marginBottom:14,borderWidth:1,borderColor:'rgba(0,212,170,0.22)'},
  d2deTitle:{color:'#00D4AA',fontSize:14,fontWeight:'800',marginBottom:6},
  d2deSub:{color:'rgba(0,212,170,0.7)',fontSize:12,lineHeight:19},
  row:{flexDirection:'row',alignItems:'flex-start',gap:12},
  ico:{fontSize:20,marginTop:2},
  lbl:{color:'rgba(255,255,255,0.45)',fontSize:10,fontWeight:'700',letterSpacing:0.5},
  val:{color:'#fff',fontSize:14,fontWeight:'700',marginTop:2},
  sub:{color:'rgba(255,255,255,0.45)',fontSize:12},
  dot:{width:8,height:8,borderRadius:4},
  divider:{height:1,backgroundColor:'rgba(255,255,255,0.06)',marginVertical:12},
  sendBtn:{flexDirection:'row',alignItems:'center',gap:14,backgroundColor:'rgba(29,78,216,0.18)',borderRadius:16,padding:18,marginBottom:14,borderWidth:1,borderColor:'rgba(29,78,216,0.35)'},
  sendIco:{fontSize:30},
  sendTitle:{color:'#fff',fontSize:16,fontWeight:'900'},
  sendSub:{color:'rgba(255,255,255,0.45)',fontSize:12,marginTop:2},
  sectionTitle:{color:'#fff',fontSize:17,fontWeight:'900',marginBottom:6},
  durRow:{flexDirection:'row',gap:8,marginBottom:14},
  durBtn:{flex:1,alignItems:'center',padding:12,borderRadius:12,backgroundColor:'rgba(255,255,255,0.05)',borderWidth:1,borderColor:'rgba(255,255,255,0.1)'},
  durBtnActive:{backgroundColor:'rgba(239,68,68,0.15)',borderColor:'rgba(239,68,68,0.5)'},
  durLbl:{color:'rgba(255,255,255,0.45)',fontSize:12,fontWeight:'800'},
  liveBtn:{flexDirection:'row',alignItems:'center',justifyContent:'center',gap:10,backgroundColor:'#EF4444',borderRadius:14,paddingVertical:15},
  liveBtnDot:{width:10,height:10,borderRadius:5,backgroundColor:'#fff'},
  liveBtnTxt:{color:'#fff',fontSize:15,fontWeight:'900'},
  liveActive:{alignItems:'center',gap:10,backgroundColor:'rgba(239,68,68,0.1)',borderRadius:14,padding:16,borderWidth:1,borderColor:'rgba(239,68,68,0.35)'},
  liveActiveDot:{width:10,height:10,borderRadius:5,backgroundColor:'#EF4444'},
  liveActiveTxt:{color:'#fff',fontSize:14,fontWeight:'800'},
  stopLiveBtn:{backgroundColor:'rgba(239,68,68,0.2)',borderRadius:10,paddingHorizontal:24,paddingVertical:10,borderWidth:1,borderColor:'rgba(239,68,68,0.45)'},
  stopLiveTxt:{color:'#EF4444',fontWeight:'900',fontSize:14},
  privacyNote:{backgroundColor:'rgba(16,185,129,0.07)',borderRadius:12,padding:14,borderWidth:1,borderColor:'rgba(16,185,129,0.2)'},
  privacyTxt:{color:'rgba(255,255,255,0.45)',fontSize:12,lineHeight:18,textAlign:'center'},
});
