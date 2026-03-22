// @ts-nocheck
// app/camera.tsx — In-App Camera
// Full-screen camera with photo/video, flip, flash, viewOnce toggle
// Returns captured media URI back to chat via router params

import React, { useState, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Alert, StatusBar,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';

export default function CameraScreen() {
  const router = useRouter();
  const { chatId, peerUid, peerName, returnTo } = useLocalSearchParams();
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<'front' | 'back'>('back');
  const [flash, setFlash] = useState<'off' | 'on'>('off');
  const [viewOnce, setViewOnce] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const cameraRef = useRef<CameraView>(null);

  if (!permission) return <View style={s.container} />;

  if (!permission.granted) {
    return (
      <View style={[s.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <Text style={{ color: '#fff', fontSize: 16, marginBottom: 20 }}>Camera permission needed</Text>
        <TouchableOpacity onPress={requestPermission} style={s.permBtn}>
          <Text style={{ color: '#00D4AA', fontWeight: '800', fontSize: 16 }}>Grant Access</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 16 }}>
          <Text style={{ color: '#888' }}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const takePhoto = async () => {
    if (capturing || !cameraRef.current) return;
    setCapturing(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 1 });
      if (photo?.uri) {
        // Navigate back to chat with the captured photo
        router.replace({
          pathname: (returnTo || '/chat') as any,
          params: {
            chatId, peerUid, peerName,
            capturedUri: photo.uri,
            capturedType: 'image',
            capturedViewOnce: viewOnce ? '1' : '0',
          },
        });
      }
    } catch {
      Alert.alert('Error', 'Could not capture photo');
    }
    setCapturing(false);
  };

  return (
    <View style={s.container}>
      <StatusBar hidden />
      <CameraView
        ref={cameraRef}
        style={s.camera}
        facing={facing}
        flash={flash}
      >
        {/* Top bar */}
        <View style={s.topBar}>
          <TouchableOpacity onPress={() => router.back()} style={s.topBtn}>
            <Text style={s.topIcon}>{"\u2715"}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setFlash(f => f === 'off' ? 'on' : 'off')} style={s.topBtn}>
            <Text style={s.topIcon}>{flash === 'on' ? "\u26A1" : "\u26A1 OFF"}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setViewOnce(v => !v)}
            style={[s.topBtn, viewOnce && { backgroundColor: '#00D4AA44' }]}
          >
            <Text style={[s.topIcon, viewOnce && { color: '#00D4AA' }]}>{"\uD83D\uDC41"}</Text>
          </TouchableOpacity>
        </View>

        {/* Bottom controls */}
        <View style={s.bottomBar}>
          <View style={{ width: 50 }} />
          <TouchableOpacity
            onPress={takePhoto}
            style={[s.captureBtn, capturing && { opacity: 0.5 }]}
            disabled={capturing}
          >
            <View style={s.captureInner} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setFacing(f => f === 'back' ? 'front' : 'back')}
            style={s.flipBtn}
          >
            <Text style={{ fontSize: 24 }}>{"\uD83D\uDD04"}</Text>
          </TouchableOpacity>
        </View>

        {viewOnce && (
          <View style={s.voBadge}>
            <Text style={s.voTxt}>{"\uD83D\uDC41"} View Once</Text>
          </View>
        )}
      </CameraView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  camera: { flex: 1 },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 50, paddingHorizontal: 20 },
  topBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#00000066', justifyContent: 'center', alignItems: 'center' },
  topIcon: { color: '#fff', fontSize: 18, fontWeight: '700' },
  bottomBar: { position: 'absolute', bottom: 40, left: 0, right: 0, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 40 },
  captureBtn: { width: 76, height: 76, borderRadius: 38, borderWidth: 4, borderColor: '#fff', justifyContent: 'center', alignItems: 'center' },
  captureInner: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#fff' },
  flipBtn: { width: 50, height: 50, borderRadius: 25, backgroundColor: '#00000066', justifyContent: 'center', alignItems: 'center' },
  permBtn: { paddingHorizontal: 28, paddingVertical: 14, borderRadius: 14, borderWidth: 1, borderColor: '#00D4AA44', backgroundColor: '#00D4AA15' },
  voBadge: { position: 'absolute', top: 100, alignSelf: 'center', backgroundColor: '#00D4AA33', paddingHorizontal: 16, paddingVertical: 6, borderRadius: 20 },
  voTxt: { color: '#00D4AA', fontSize: 13, fontWeight: '700' },
});
