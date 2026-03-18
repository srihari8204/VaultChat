// @ts-nocheck
// app/media-viewer.tsx — Universal In-App Media Viewer
// Images: zoom, pan | Videos: stream while loading | Audio: built-in player | Code: inline preview

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, StatusBar,
  ActivityIndicator, Dimensions, ScrollView, Image, Animated,
  PanResponder, Alert, Share,
} from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Video, Audio, ResizeMode } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as MediaLibrary from 'expo-media-library';

const { width: SW, height: SH } = Dimensions.get('window');
const C = { bg: '#000', accent: '#00E5FF', green: '#10B981' };

const getFileType = (name) => {
  const ext = (name || '').split('.').pop()?.toLowerCase() || '';
  if (['jpg','jpeg','png','gif','webp','bmp','svg','heic'].includes(ext)) return 'image';
  if (['mp4','mov','avi','mkv','webm','flv','wmv','m4v'].includes(ext)) return 'video';
  if (['mp3','wav','m4a','aac','ogg','flac','wma'].includes(ext)) return 'audio';
  if (['js','jsx','ts','tsx','py','java','c','cpp','go','rs','rb','php','swift','kt','dart','sh','bat','ps1','sql','html','css','json','xml','yaml','yml','md','txt','toml','ini','csv','log'].includes(ext)) return 'code';
  if (ext === 'pdf') return 'pdf';
  return 'unknown';
};

const formatSize = (b) => { if (!b) return ''; if (b<1024) return b+' B'; if (b<1048576) return (b/1024).toFixed(1)+' KB'; return (b/1048576).toFixed(1)+' MB'; };
const formatDur = (ms) => { if (!ms) return '0:00'; const s=Math.floor(ms/1000); return Math.floor(s/60)+':'+(s%60<10?'0':'')+(s%60); };

export default function MediaViewerScreen() {
  const router = useRouter();
  const { uri, mediaUrl, filename, msgType } = useLocalSearchParams();
  const fileUri = (mediaUrl || uri || '') + '';
  const fileName = (filename || 'file') + '';
  const fileType = msgType === 'image' ? 'image' : msgType === 'video' ? 'video' : msgType === 'audio' ? 'audio' : getFileType(fileName);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fileSize, setFileSize] = useState(0);

  useEffect(() => {
    if (fileUri.startsWith('http')) fetch(fileUri, { method: 'HEAD' }).then(r => setFileSize(parseInt(r.headers.get('content-length') || '0'))).catch(() => {});
  }, []);

  const saveToDevice = async () => {
    try {
      const ext = fileName.split('.').pop() || 'file';
      const localPath = FileSystem.cacheDirectory + 'vc_' + Date.now() + '.' + ext;
      await FileSystem.downloadAsync(fileUri, localPath);
      if (['image','video'].includes(fileType)) {
        const { status } = await MediaLibrary.requestPermissionsAsync();
        if (status === 'granted') { await MediaLibrary.saveToLibraryAsync(localPath); Alert.alert('Saved!', fileName + ' saved to gallery'); }
      } else if (await Sharing.isAvailableAsync()) { await Sharing.shareAsync(localPath); }
    } catch (e) { Alert.alert('Error', e.message); }
  };

  // IMAGE
  const ImageViewer = () => {
    const scale = useRef(new Animated.Value(1)).current;
    const [imgLoaded, setImgLoaded] = useState(false);
    const lastScale = useRef(1);
    const panResponder = useRef(PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderRelease: (_, g) => {
        if (Math.abs(g.dx) < 5 && Math.abs(g.dy) < 5) {
          const ns = lastScale.current > 1 ? 1 : 2.5; lastScale.current = ns;
          Animated.spring(scale, { toValue: ns, useNativeDriver: true }).start();
        }
      },
    })).current;
    return (
      <View style={s.full} {...panResponder.panHandlers}>
        {!imgLoaded && <ActivityIndicator color={C.accent} style={s.center} />}
        <Animated.Image source={{ uri: fileUri }} style={[s.fullImg, { transform: [{ scale }] }]} resizeMode="contain"
          onLoad={() => { setImgLoaded(true); setLoading(false); }} onError={() => { setError('Failed to load image'); setLoading(false); }} />
      </View>
    );
  };

  // VIDEO — streams while loading
  const VideoPlayer = () => {
    const videoRef = useRef(null);
    const [st, setSt] = useState({});
    const [ctrl, setCtrl] = useState(true);
    useEffect(() => { setLoading(false); }, []);
    return (
      <TouchableOpacity style={s.full} activeOpacity={1} onPress={() => setCtrl(!ctrl)}>
        <Video ref={videoRef} source={{ uri: fileUri }} style={s.fullVid} resizeMode={ResizeMode.CONTAIN}
          shouldPlay={true} useNativeControls={false} progressUpdateIntervalMillis={250}
          onPlaybackStatusUpdate={setSt} onLoad={() => setLoading(false)} onError={() => { setError('Failed to load video'); setLoading(false); }} />
        {st.isBuffering && !st.isPlaying && <View style={s.bufOverlay}><ActivityIndicator color={C.accent} size="large" /><Text style={s.bufTxt}>Streaming...</Text></View>}
        {ctrl && (
          <View style={s.vidCtrl}>
            <TouchableOpacity style={s.playBtn} onPress={async () => { if (!videoRef.current) return; st.isPlaying ? await videoRef.current.pauseAsync() : await videoRef.current.playAsync(); }}>
              <Text style={{ fontSize: 32 }}>{st.isPlaying ? '\u23F8' : '\u25B6\uFE0F'}</Text>
            </TouchableOpacity>
            <View style={s.progRow}>
              <Text style={s.timeTxt}>{formatDur(st.positionMillis)}</Text>
              <View style={s.seekBg}>
                <View style={[s.seekBuf, { width: ((st.playableDurationMillis||0) / (st.durationMillis||1) * 100) + '%' }]} />
                <View style={[s.seekFill, { width: ((st.positionMillis||0) / (st.durationMillis||1) * 100) + '%' }]} />
              </View>
              <Text style={s.timeTxt}>{formatDur(st.durationMillis)}</Text>
            </View>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  // AUDIO
  const AudioPlayer = () => {
    const soundRef = useRef(null);
    const [ast, setAst] = useState({});
    useEffect(() => {
      (async () => {
        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
        const { sound } = await Audio.Sound.createAsync({ uri: fileUri }, { shouldPlay: false, progressUpdateIntervalMillis: 200 }, setAst);
        soundRef.current = sound; setLoading(false);
      })();
      return () => { soundRef.current?.unloadAsync(); };
    }, []);
    const prog = (ast.positionMillis||0) / (ast.durationMillis||1);
    return (
      <View style={s.audioWrap}>
        <View style={s.audioCard}>
          <Text style={{ fontSize: 48 }}>{"\uD83C\uDFB5"}</Text>
          <Text style={s.audioName}>{fileName}</Text>
          <Text style={s.audioMeta}>{formatSize(fileSize)}{ast.durationMillis ? ' | ' + formatDur(ast.durationMillis) : ''}</Text>
          <View style={s.waveform}>{Array.from({length:40}).map((_,i) => <View key={i} style={[s.waveBar,{height:8+Math.random()*28,backgroundColor:i/40<prog?C.accent:'#333'}]}/>)}</View>
          <View style={s.audioTimeRow}><Text style={s.audioTime}>{formatDur(ast.positionMillis)}</Text><Text style={s.audioTime}>{formatDur(ast.durationMillis)}</Text></View>
          <View style={s.audioCtrlRow}>
            <TouchableOpacity onPress={async()=>{if(!soundRef.current)return;const p=Math.max(0,prog-0.1);await soundRef.current.setPositionAsync(p*(ast.durationMillis||0));}}><Text style={{fontSize:24}}>{"\u23EA"}</Text></TouchableOpacity>
            <TouchableOpacity style={s.audioPlayBtn} onPress={async()=>{if(!soundRef.current)return;ast.isPlaying?await soundRef.current.pauseAsync():await soundRef.current.playAsync();}}>
              <Text style={{fontSize:28}}>{ast.isPlaying?'\u23F8':'\u25B6\uFE0F'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={async()=>{if(!soundRef.current)return;const p=Math.min(1,prog+0.1);await soundRef.current.setPositionAsync(p*(ast.durationMillis||0));}}><Text style={{fontSize:24}}>{"\u23E9"}</Text></TouchableOpacity>
          </View>
        </View>
      </View>
    );
  };

  // CODE/TEXT
  const CodeViewer = () => {
    const [content, setContent] = useState('');
    useEffect(() => {
      (async () => {
        try {
          if (fileUri.startsWith('http')) { const lp = FileSystem.cacheDirectory+'prev_'+Date.now(); await FileSystem.downloadAsync(fileUri,lp); setContent(await FileSystem.readAsStringAsync(lp)); }
          else setContent(await FileSystem.readAsStringAsync(fileUri));
        } catch(e) { setContent('Error: '+e.message); }
        setLoading(false);
      })();
    }, []);
    const lines = content.split('\n');
    return (
      <ScrollView style={{flex:1,background:'#0D1117'}}>
        <View style={{padding:12,background:'#161B22',borderBottomWidth:1,borderBottomColor:'#21262D'}}>
          <Text style={{color:'#E0E0F0',fontSize:14,fontWeight:800}}>{fileName}</Text>
          <Text style={{color:'#8B949E',fontSize:11,marginTop:4}}>{lines.length} lines | {formatSize(content.length)}</Text>
          <TouchableOpacity style={{marginTop:10,background:'#4A9FFF22',borderRadius:10,paddingVertical:10,alignItems:'center',borderWidth:1,borderColor:'#4A9FFF44'}}
            onPress={()=>router.push({pathname:'/file-preview',params:{uri:fileUri,filename:fileName,mediaUrl:fileUri}})}>
            <Text style={{color:'#4A9FFF',fontSize:12,fontWeight:700}}>{"\uD83C\uDF08 Open with Syntax Highlighting"}</Text>
          </TouchableOpacity>
        </View>
        {lines.slice(0,500).map((l,i)=><View key={i} style={{flexDirection:'row',minHeight:22}}><Text style={{color:'#484F58',fontSize:12,fontFamily:'monospace',width:40,textAlign:'right',paddingRight:12,paddingTop:2}}>{i+1}</Text><Text style={{color:'#C9D1D9',fontSize:12,fontFamily:'monospace',flex:1,paddingTop:2}}>{l}</Text></View>)}
        {lines.length>500&&<Text style={{color:'#484F58',fontSize:12,textAlign:'center',padding:20}}>...{lines.length-500} more lines</Text>}
        <View style={{height:100}}/>
      </ScrollView>
    );
  };

  // PDF / UNKNOWN
  const GenericViewer = () => { useEffect(()=>{setLoading(false);},[]);
    return (<View style={s.audioWrap}><View style={s.audioCard}><Text style={{fontSize:48}}>{"\uD83D\uDCC4"}</Text><Text style={s.audioName}>{fileName}</Text><Text style={s.audioMeta}>{formatSize(fileSize)}</Text>
      <TouchableOpacity style={{marginTop:20,background:C.accent,borderRadius:14,paddingVertical:14,paddingHorizontal:32}} onPress={saveToDevice}><Text style={{color:'#000',fontSize:14,fontWeight:800}}>{"\uD83D\uDCE5 Download & Open"}</Text></TouchableOpacity>
    </View></View>);
  };

  return (
    <>
      <Stack.Screen options={{ title: fileName, headerStyle: { backgroundColor: '#000' }, headerTintColor: '#fff',
        headerRight: () => <View style={{flexDirection:'row',gap:14,marginRight:8}}>
          <TouchableOpacity onPress={()=>Share.share({url:fileUri,message:fileName})}><Text style={{color:C.accent,fontSize:13,fontWeight:700}}>Share</Text></TouchableOpacity>
          <TouchableOpacity onPress={saveToDevice}><Text style={{color:C.accent,fontSize:13,fontWeight:700}}>Save</Text></TouchableOpacity>
        </View>,
      }} />
      <View style={s.container}>
        <StatusBar barStyle="light-content" backgroundColor="#000" />
        {loading && <ActivityIndicator color={C.accent} style={s.center} />}
        {error ? <Text style={{color:'#FF3C6E',textAlign:'center',padding:20}}>{error}</Text> : null}
        {fileType === 'image' && <ImageViewer />}
        {fileType === 'video' && <VideoPlayer />}
        {fileType === 'audio' && <AudioPlayer />}
        {fileType === 'code' && <CodeViewer />}
        {(fileType === 'pdf' || fileType === 'unknown') && <GenericViewer />}
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container:{flex:1,backgroundColor:'#000'},
  full:{flex:1,justifyContent:'center',alignItems:'center'},
  center:{position:'absolute',top:'45%',alignSelf:'center',zIndex:10},
  fullImg:{width:SW,height:SH-100},
  fullVid:{width:SW,height:SH-100},
  bufOverlay:{position:'absolute',justifyContent:'center',alignItems:'center'},
  bufTxt:{color:'#888',fontSize:12,marginTop:8},
  vidCtrl:{position:'absolute',bottom:0,left:0,right:0,backgroundColor:'#000000AA',padding:16,paddingBottom:30},
  playBtn:{alignSelf:'center',marginBottom:12},
  progRow:{flexDirection:'row',alignItems:'center',gap:8},
  timeTxt:{color:'#ccc',fontSize:11,width:40},
  seekBg:{flex:1,height:4,backgroundColor:'#333',borderRadius:2,overflow:'hidden'},
  seekBuf:{position:'absolute',height:'100%',backgroundColor:'#555',borderRadius:2},
  seekFill:{height:'100%',backgroundColor:C.accent,borderRadius:2},
  audioWrap:{flex:1,justifyContent:'center',padding:24},
  audioCard:{backgroundColor:'#0A1628',borderRadius:24,padding:32,alignItems:'center',borderWidth:1,borderColor:'#111'},
  audioName:{color:'#E0E0F0',fontSize:16,fontWeight:800,marginTop:12,textAlign:'center'},
  audioMeta:{color:'#666',fontSize:12,marginTop:4},
  waveform:{flexDirection:'row',alignItems:'center',gap:2,marginTop:24,height:40},
  waveBar:{width:3,borderRadius:2},
  audioTimeRow:{flexDirection:'row',justifyContent:'space-between',width:'100%',marginTop:8},
  audioTime:{color:'#666',fontSize:11},
  audioCtrlRow:{flexDirection:'row',alignItems:'center',gap:24,marginTop:20},
  audioPlayBtn:{width:64,height:64,borderRadius:32,backgroundColor:C.accent,justifyContent:'center',alignItems:'center'},
});
