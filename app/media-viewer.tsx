// app/media-viewer.tsx — Universal In-App Media Viewer
// Images: zoom, pan | Videos: stream while loading | Audio: built-in player | Code: inline preview

import { BRAND_ACCENT } from '../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, StatusBar,
  ActivityIndicator, Dimensions, ScrollView, Animated,
  PanResponder, Alert, Share,
} from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Video, Audio, ResizeMode, type AVPlaybackStatusSuccess } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as MediaLibrary from 'expo-media-library';
import { getMedia } from '../lib/mediaStore';
import { getAccessToken } from '../lib/api';
import { attachmentUrl, markAttachmentViewed, reportScreenshotCaptured } from '../lib/chatService';
import { getCurrentUserAsync } from './(constants)/authService';
import ProtectedMediaView from '../components/ProtectedMediaView';
import { onScreenshot } from '../lib/screenGuard';

// Playback status is a union (loaded | error); every read below wants the loaded
// shape. Partial<> keeps the `{}` initial state honest — the fields genuinely
// are absent until the first status callback lands.
type PlaybackState = Partial<AVPlaybackStatusSuccess>;

const { width: SW, height: SH } = Dimensions.get('window');
const C = { bg: '#000', accent: '#4A9FFF', green: BRAND_ACCENT };

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
  const { uri, mediaUrl, attachmentId, needsAuth, save, isMine, mime, filename, msgType, viewOnce, chatId } = useLocalSearchParams();
  const isViewOnce = viewOnce === '1';

  // ── VaultView watermark identity ─────────────────────────
  // The overlay carries the VIEWER's identity, not the sender's — that is what
  // makes a second-phone photo self-incriminating. Loaded from the local
  // session so it works offline.
  const [me, setMe] = useState<{ name?: string; phone?: string } | null>(null);
  useEffect(() => {
    if (!isViewOnce) return;
    getCurrentUserAsync()
      .then((u: any) => setMe({ name: u?.name || u?.email, phone: u?.phone || u?.phoneNumber }))
      .catch(() => {});
  }, [isViewOnce]);

  // Screenshot while protected media is open → tell the sender. On Android
  // FLAG_SECURE means this rarely fires (the capture is black); on iOS it is the
  // whole defence.
  useEffect(() => {
    if (!isViewOnce || !chatId) return;
    const stop = onScreenshot(() => {
      reportScreenshotCaptured(String(chatId)).catch(() => {});
    });
    return stop;
  }, [isViewOnce, chatId]);
  const viewedRef = useRef(false);
  // Path of the ephemeral plaintext this viewer wrote (view-once only). The
  // server burns the attachment on first view, so this cache file is the ONLY
  // remaining copy — it must not outlive the screen. Deleted on unmount here;
  // lib/mediaCacheGC.purgeEphemeralMedia() is the crash-recovery path.
  const ephemeralRef = useRef<string | null>(null);
  useEffect(() => () => {
    const p = ephemeralRef.current;
    ephemeralRef.current = null;
    if (p) FileSystem.deleteAsync(p, { idempotent: true }).catch(() => {});
  }, []);
  // Mark the server "viewed" only AFTER the media has loaded — never before, or
  // the POST /viewed flips viewed_at while the GET is still in flight and the GET
  // 410s. View-once is also downloaded to cache (below), never persisted.
  const markViewedAfterLoad = () => {
    if (isViewOnce && attachmentId && !viewedRef.current) {
      viewedRef.current = true;
      markAttachmentViewed(String(attachmentId)).catch(() => {});
    }
  };
  const fileName = (filename || 'file') + '';
  // For our own /uploads images we attach the Bearer header so Fresco serves the
  // already-cached image instantly (no re-download).
  const [authHeaders, setAuthHeaders] = useState<{ Authorization: string } | undefined>(undefined);
  useEffect(() => {
    if (needsAuth) getAccessToken().then(t => { if (t) setAuthHeaders({ Authorization: `Bearer ${t}` }); });
  }, [needsAuth]);
  const fileType = msgType === 'image' ? 'image' : msgType === 'video' ? 'video' : msgType === 'audio' ? 'audio' : getFileType(fileName);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fileSize, setFileSize] = useState(0);
  // When opened by attachmentId (the common path from a chat bubble) we resolve
  // a local file here — so the bubble navigates INSTANTLY and we show a spinner,
  // instead of the bubble awaiting a download (which made taps feel unreliable
  // and stacked multiple viewers).
  const [fileUri, setFileUri] = useState<string>((mediaUrl || uri || '') + '');
  useEffect(() => {
    if (fileUri || !attachmentId) return;
    let cancel = false;
    const onErr = () => { if (!cancel) { setError('Failed to load media'); setLoading(false); } };
    if (isViewOnce) {
      // View-once: download to an EPHEMERAL cache file (not the browsable media
      // folder) so it's never saved. The GET runs while viewed_at is still NULL,
      // so it serves; we flip viewed_at only after onLoad (markViewedAfterLoad).
      (async () => {
        try {
          const token = await getAccessToken();
          const ext = msgType === 'video' ? 'mp4' : 'jpg';
          const dest = FileSystem.cacheDirectory + 'vo_' + String(attachmentId) + '.' + ext;
          const res = await FileSystem.downloadAsync(attachmentUrl(String(attachmentId)), dest, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          });
          if (res.status >= 400) throw new Error('view-once GET ' + res.status);
          ephemeralRef.current = res.uri;   // wiped on unmount
          if (cancel) { FileSystem.deleteAsync(res.uri, { idempotent: true }).catch(() => {}); return; }
          setFileUri(res.uri);
        } catch { onErr(); }
      })();
      return () => { cancel = true; };
    }
    getMedia(String(attachmentId), {
      kind: msgType === 'video' ? 'video' : 'image',
      isMine: isMine === '1',
      mime: mime ? String(mime) : undefined,
      filename: filename ? String(filename) : undefined,
    })
      .then(u => { if (!cancel) setFileUri(u); })
      .catch(onErr);
    return () => { cancel = true; };
  }, [attachmentId]);

  useEffect(() => {
    if (fileUri.startsWith('http')) fetch(fileUri, { method: 'HEAD' }).then(r => setFileSize(parseInt(r.headers.get('content-length') || '0'))).catch(() => {});
  }, [fileUri]);

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
        <Animated.Image source={needsAuth && fileUri.startsWith('http') ? { uri: fileUri, headers: authHeaders } : { uri: fileUri }} style={[s.fullImg, { transform: [{ scale }] }]} resizeMode="contain"
          onLoad={() => { setImgLoaded(true); setLoading(false); markViewedAfterLoad(); }} onError={() => { setError('Failed to load image'); setLoading(false); }} />
      </View>
    );
  };

  // VIDEO — streams while loading
  const VideoPlayer = () => {
    const videoRef = useRef(null);
    const [st, setSt] = useState<PlaybackState>({});
    const [ctrl, setCtrl] = useState(true);
    const [shouldPlay, setShouldPlay] = useState(true);
    useEffect(() => { setLoading(false); }, []);
    return (
      <TouchableOpacity style={s.full} activeOpacity={1} onPress={() => setCtrl(!ctrl)}>
        <Video ref={videoRef} source={{ uri: fileUri }} style={s.fullVid} resizeMode={ResizeMode.CONTAIN}
          shouldPlay={shouldPlay} isLooping={false} useNativeControls={false} progressUpdateIntervalMillis={250}
          onPlaybackStatusUpdate={(status) => { if (!status.isLoaded) return; setSt(status); if (status.didJustFinish) setShouldPlay(false); }}
          onLoad={() => { setLoading(false); markViewedAfterLoad(); }} onError={() => { setError('Failed to load video'); setLoading(false); }} />
        {st.isBuffering && !st.isPlaying && <View style={s.bufOverlay}><ActivityIndicator color={C.accent} size="large" /><Text style={s.bufTxt}>Streaming...</Text></View>}
        {ctrl && (
          <View style={s.vidCtrl}>
            <TouchableOpacity style={s.playBtn} onPress={async () => {
              const v = videoRef.current; if (!v) return;
              if (st.isPlaying) { await v.pauseAsync(); setShouldPlay(false); }
              else {
                // Replay from the start if it had reached the end.
                if (st.didJustFinish || (st.durationMillis && st.positionMillis >= st.durationMillis)) { await v.setPositionAsync(0); }
                await v.playAsync(); setShouldPlay(true);
              }
            }}>
              <Ionicons name={st.isPlaying ? 'pause' : 'play'} size={40} color="#fff" />
            </TouchableOpacity>
            <View style={s.progRow}>
              <Text style={s.timeTxt}>{formatDur(st.positionMillis)}</Text>
              <View style={s.seekBg}>
                <View style={[s.seekBuf, { width: `${(st.playableDurationMillis||0) / (st.durationMillis||1) * 100}%` }]} />
                <View style={[s.seekFill, { width: `${(st.positionMillis||0) / (st.durationMillis||1) * 100}%` }]} />
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
    const [ast, setAst] = useState<PlaybackState>({});
    useEffect(() => {
      (async () => {
        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
        const { sound } = await Audio.Sound.createAsync({ uri: fileUri }, { shouldPlay: false, progressUpdateIntervalMillis: 200 }, (st) => { if (st.isLoaded) setAst(st); });
        soundRef.current = sound; setLoading(false);
      })();
      return () => { soundRef.current?.unloadAsync(); };
    }, []);
    const prog = (ast.positionMillis||0) / (ast.durationMillis||1);
    return (
      <View style={s.audioWrap}>
        <View style={s.audioCard}>
          <Ionicons name="musical-notes" size={48} color="#1F2937" />
          <Text style={s.audioName}>{fileName}</Text>
          <Text style={s.audioMeta}>{formatSize(fileSize)}{ast.durationMillis ? ' | ' + formatDur(ast.durationMillis) : ''}</Text>
          <View style={s.waveform}>{Array.from({length:40}).map((_,i) => <View key={i} style={[s.waveBar,{height:8+Math.random()*28,backgroundColor:i/40<prog?C.accent:'#D1D5DB'}]}/>)}</View>
          <View style={s.audioTimeRow}><Text style={s.audioTime}>{formatDur(ast.positionMillis)}</Text><Text style={s.audioTime}>{formatDur(ast.durationMillis)}</Text></View>
          <View style={s.audioCtrlRow}>
            <TouchableOpacity onPress={async()=>{if(!soundRef.current)return;const p=Math.max(0,prog-0.1);await soundRef.current.setPositionAsync(p*(ast.durationMillis||0));}}><Ionicons name="play-back" size={26} color="#1F2937" /></TouchableOpacity>
            <TouchableOpacity style={s.audioPlayBtn} onPress={async()=>{if(!soundRef.current)return;if(ast.isPlaying){await soundRef.current.pauseAsync();}else{await soundRef.current.playAsync();}}}>
              <Ionicons name={ast.isPlaying?'pause':'play'} size={30} color="#000" />
            </TouchableOpacity>
            <TouchableOpacity onPress={async()=>{if(!soundRef.current)return;const p=Math.min(1,prog+0.1);await soundRef.current.setPositionAsync(p*(ast.durationMillis||0));}}><Ionicons name="play-forward" size={26} color="#1F2937" /></TouchableOpacity>
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
      <ScrollView style={{flex:1,backgroundColor:'#FFFFFF'}}>
        <View style={{padding:12,backgroundColor:'#161B22',borderBottomWidth:1,borderBottomColor:'#21262D'}}>
          <Text style={{color:'#1F2937',fontSize:14,fontWeight:800}}>{fileName}</Text>
          <Text style={{color:'#8B949E',fontSize:11,marginTop:4}}>{lines.length} lines | {formatSize(content.length)}</Text>
          <TouchableOpacity style={{marginTop:10,backgroundColor:'#4A9FFF22',borderRadius:10,paddingVertical:10,flexDirection:'row',gap:6,justifyContent:'center',alignItems:'center',borderWidth:1,borderColor:'#4A9FFF44'}}
            onPress={()=>router.push({pathname:'/file-preview',params:{uri:fileUri,filename:fileName,mediaUrl:fileUri}})}>
            <Ionicons name="code-slash-outline" size={14} color="#4A9FFF" />
            <Text style={{color:'#4A9FFF',fontSize:12,fontWeight:'700'}}>Open with Syntax Highlighting</Text>
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
    return (<View style={s.audioWrap}><View style={s.audioCard}><Ionicons name="document-outline" size={48} color="#1F2937" /><Text style={s.audioName}>{fileName}</Text><Text style={s.audioMeta}>{formatSize(fileSize)}</Text>
      <TouchableOpacity style={{marginTop:20,backgroundColor:C.accent,borderRadius:14,flexDirection:'row',gap:8,alignItems:'center',paddingVertical:14,paddingHorizontal:32}} onPress={saveToDevice}><Ionicons name="download-outline" size={16} color="#000" /><Text style={{color:'#000',fontSize:14,fontWeight:'800'}}>Download & Open</Text></TouchableOpacity>
    </View></View>);
  };

  return (
    <>
      <Stack.Screen options={{ title: fileName, headerStyle: { backgroundColor: '#000' }, headerTintColor: '#fff',
        // Share/Save are hidden for view-once media. Offering "Download" on a
        // photo the sender was promised is one-view-only would hand the
        // recipient a permanent copy through the app's own UI — the protection
        // has to hold in the viewer, not only on the server.
        headerRight: () => isViewOnce ? null : <View style={{flexDirection:'row',gap:20,marginRight:8}}>
          <TouchableOpacity onPress={()=>Share.share({url:fileUri,message:fileName})} hitSlop={8}><Ionicons name="share-social-outline" size={22} color="#fff" /></TouchableOpacity>
          <TouchableOpacity onPress={saveToDevice} hitSlop={8}><Ionicons name="download-outline" size={22} color="#fff" /></TouchableOpacity>
        </View>,
      }} />
      <View style={s.container}>
        <StatusBar barStyle="light-content" backgroundColor="#000" />
        {loading && <ActivityIndicator color={C.accent} style={s.center} />}
        {error ? <Text style={{color:'#FF3C6E',textAlign:'center',padding:20}}>{error}</Text> : null}
        {!fileUri && !error ? (
          <ActivityIndicator color={C.accent} style={s.center} size="large" />
        ) : fileUri ? (
          // Protected media renders inside the VaultView guard: watermarked, and
          // refused outright while a recording/mirror is active. Everything else
          // renders exactly as before.
          isViewOnce && (fileType === 'image' || fileType === 'video') ? (
            <ProtectedMediaView
              watermarkName={me?.name}
              watermarkPhone={me?.phone}
              onBlocked={() => { if (chatId) reportScreenshotCaptured(String(chatId)).catch(() => {}); }}
            >
              {fileType === 'image' ? <ImageViewer /> : <VideoPlayer />}
            </ProtectedMediaView>
          ) : (
            <>
              {fileType === 'image' && <ImageViewer />}
              {fileType === 'video' && <VideoPlayer />}
              {fileType === 'audio' && <AudioPlayer />}
              {fileType === 'code' && <CodeViewer />}
              {(fileType === 'pdf' || fileType === 'unknown') && <GenericViewer />}
            </>
          )
        ) : null}
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container:{flex:1,backgroundColor:'#000'},
  full:{flex:1,justifyContent:'center',alignItems:'center'},
  center:{position:'absolute',top:'45%',alignSelf:'center',zIndex:10},
  fullImg:{width:'100%',height:'100%'},
  fullVid:{width:'100%',height:'100%'},
  bufOverlay:{position:'absolute',justifyContent:'center',alignItems:'center'},
  bufTxt:{color:'#6B7280',fontSize:12,marginTop:8},
  vidCtrl:{position:'absolute',bottom:0,left:0,right:0,backgroundColor:'#000000AA',padding:16,paddingBottom:30},
  playBtn:{alignSelf:'center',marginBottom:12},
  progRow:{flexDirection:'row',alignItems:'center',gap:8},
  timeTxt:{color:'#ccc',fontSize:11,width:40},
  seekBg:{flex:1,height:4,backgroundColor:'#D1D5DB',borderRadius:2,overflow:'hidden'},
  seekBuf:{position:'absolute',height:'100%',backgroundColor:'#6B7280',borderRadius:2},
  seekFill:{height:'100%',backgroundColor:C.accent,borderRadius:2},
  audioWrap:{flex:1,justifyContent:'center',padding:24},
  audioCard:{backgroundColor:'#F9FAFB',borderRadius:24,padding:32,alignItems:'center',borderWidth:1,borderColor:'#E5E7EB'},
  audioName:{color:'#1F2937',fontSize:16,fontWeight:800,marginTop:12,textAlign:'center'},
  audioMeta:{color:'#9CA3AF',fontSize:12,marginTop:4},
  waveform:{flexDirection:'row',alignItems:'center',gap:2,marginTop:24,height:40},
  waveBar:{width:3,borderRadius:2},
  audioTimeRow:{flexDirection:'row',justifyContent:'space-between',width:'100%',marginTop:8},
  audioTime:{color:'#9CA3AF',fontSize:11},
  audioCtrlRow:{flexDirection:'row',alignItems:'center',gap:24,marginTop:20},
  audioPlayBtn:{width:64,height:64,borderRadius:32,backgroundColor:C.accent,justifyContent:'center',alignItems:'center'},
});
