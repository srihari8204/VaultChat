// app/voicecall.tsx
// Real WebRTC voice call (audio only)
// Same TURN server as videocall.tsx
// Speaker / earpiece toggle, mute, call timer

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  Alert, StatusBar,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  mediaDevices,
} from 'react-native-webrtc';
import { io, Socket } from 'socket.io-client';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import { Audio } from 'expo-av';

// â”€â”€ Same ICE config as videocall.tsx â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls:       'turn:openrelay.metered.ca:80',
    username:   '597bc91ac20a6dbd23f2ceba',
    credential: '6PIgpt3wvCkVMngH',
  },
  {
    urls:       'turn:openrelay.metered.ca:80?transport=tcp',
    username:   '597bc91ac20a6dbd23f2ceba',
    credential: '6PIgpt3wvCkVMngH',
  },
  {
    urls:       'turns:openrelay.metered.ca:443',
    username:   '597bc91ac20a6dbd23f2ceba',
    credential: '6PIgpt3wvCkVMngH',
  },
  {
    urls:       'turns:openrelay.metered.ca:443?transport=tcp',
    username:   '597bc91ac20a6dbd23f2ceba',
    credential: '6PIgpt3wvCkVMngH',
  },
];

const BACKEND_URL = 'https://vaultchat.onrender.com';
type CallState = 'connecting' | 'ringing' | 'connected' | 'ended';

export default function VoiceCallScreen() {
  const router = useRouter();
  const { chatId, name, isIncoming, remoteSocketId } =
    useLocalSearchParams<{
      chatId: string;
      name: string;
      isIncoming?: string;
      remoteSocketId?: string;
    }>();

  const uid = auth().currentUser?.uid || '';

  const [callState,  setCallState]  = useState<CallState>('connecting');
  const [muted,      setMuted]      = useState(false);
  const [speaker,    setSpeaker]    = useState(false); // earpiece by default for voice
  const [seconds,    setSeconds]    = useState(0);

  const pcRef       = useRef<RTCPeerConnection | null>(null);
  const socketRef   = useRef<Socket | null>(null);
  const timerRef    = useRef<any>(null);
  const remoteIdRef = useRef<string>(remoteSocketId || '');
  const localStreamRef = useRef<any>(null);

  useEffect(() => {
    let mounted = true;

    const setup = async () => {
      try {
        // Audio mode â€” earpiece for private voice calls
        await Audio.setAudioModeAsync({
          allowsRecordingIOS:         true,
          playsInSilentModeIOS:       true,
          playThroughEarpieceAndroid: true, // earpiece default
        });

        // Audio only â€” no video track
        const stream = await mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });

        if (!mounted) return;
        localStreamRef.current = stream;

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        pcRef.current = pc;

        stream.getTracks().forEach((track: any) => pc.addTrack(track, stream));

        // Remote audio plays automatically via WebRTC
        (pc as any).ontrack = () => {
          setCallState('connected');
          startTimer();
        };

        const socket = io(BACKEND_URL, { transports: ['websocket'] });
        socketRef.current = socket;

        socket.on('connect', async () => {
          socket.emit('register', uid);

          if (isIncoming === 'true') {
            setCallState('ringing');
            socket.on('call_offer_for_you', async ({ offer, fromSocketId }: any) => {
              remoteIdRef.current = fromSocketId;
              await pc.setRemoteDescription(new RTCSessionDescription(offer));
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              socket.emit('call_answer', { toSocketId: fromSocketId, answer });
            });
          } else {
            setCallState('ringing');
            await makeCall(pc, socket);
          }
        });

        socket.on('ice_candidate', async ({ candidate }: any) => {
          if (candidate && pcRef.current) {
            await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
          }
        });

        socket.on('call_answered', async ({ answer }: any) => {
          await pcRef.current?.setRemoteDescription(new RTCSessionDescription(answer));
          setCallState('connected');
          startTimer();
        });

        socket.on('call_ended', () => endCall(false));

        (pc as any).onicecandidate = (event: any) => {
          if (event.candidate && remoteIdRef.current) {
            socket.emit('ice_candidate', {
              toSocketId: remoteIdRef.current,
              candidate:  event.candidate,
            });
          }
        };

        (pc as any).onconnectionstatechange = () => {
          if (pc.connectionState === 'failed' ||
              pc.connectionState === 'disconnected') {
            endCall(true);
          }
        };

      } catch (e: any) {
        Alert.alert('Error', e.message || 'Could not access microphone');
        router.back();
      }
    };

    setup();
    return () => { mounted = false; cleanup(); };
  }, []);

  const makeCall = async (pc: RTCPeerConnection, socket: Socket) => {
    const chatDoc = await firestore().collection('chats').doc(chatId).get();
    const participants: string[] = chatDoc.data()?.participants || [];
    const recipientUid = participants.find(p => p !== uid);
    if (!recipientUid) return;

    const userDoc = await firestore().collection('users').doc(recipientUid).get();
    remoteIdRef.current = userDoc.data()?.socketId || '';

    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: false,
    });
    await pc.setLocalDescription(offer);

    socket.emit('call_offer', {
      toSocketId: remoteIdRef.current,
      offer,
      callType:   'voice',
      callerName: auth().currentUser?.displayName || 'VaultChat User',
      chatId,
    });
  };

  const startTimer = () => {
    timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
  };

  const fmt = (s: number) => {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    return `${m}:${(s % 60).toString().padStart(2, '0')}`;
  };

  const toggleMute = () => {
    localStreamRef.current?.getAudioTracks().forEach((t: any) => {
      t.enabled = muted;
    });
    setMuted(m => !m);
  };

  const toggleSpeaker = async () => {
    const next = !speaker;
    setSpeaker(next);
    await Audio.setAudioModeAsync({
      playThroughEarpieceAndroid: !next,
      allowsRecordingIOS:         true,
      playsInSilentModeIOS:       true,
    });
  };

  const endCall = (notify = true) => {
    if (notify && socketRef.current && remoteIdRef.current) {
      socketRef.current.emit('call_end', { toSocketId: remoteIdRef.current });
    }
    cleanup();
    router.back();
  };

  const cleanup = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    localStreamRef.current?.getTracks().forEach((t: any) => t.stop());
    pcRef.current?.close();
    socketRef.current?.disconnect();
  };

  const stateLabel: Record<CallState, string> = {
    connecting: 'Connecting...',
    ringing:    'Ringing...',
    connected:  fmt(seconds),
    ended:      'Call Ended',
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0A0E1A" />

      {/* D2DE badge */}
      <View style={styles.d2deBadge}>
        <Text style={styles.d2deText}>ðŸ›¡ï¸ D2DE Â· Encrypted Voice</Text>
      </View>

      {/* Avatar */}
      <View style={styles.avatarCircle}>
        <Text style={styles.avatarText}>{name?.slice(0,2).toUpperCase()}</Text>
      </View>

      <Text style={styles.callerName}>{name}</Text>

      {/* Status / timer */}
      <Text style={[
        styles.callStatus,
        callState === 'connected' && styles.callStatusActive,
      ]}>
        {callState === 'connected' ? `â— ${stateLabel.connected}` : stateLabel[callState]}
      </Text>

      {/* Signal strength visual */}
      {callState === 'connected' && (
        <View style={styles.signalRow}>
          {[1,2,3,4,5].map(i => (
            <View key={i} style={[styles.signalBar, { height: 6 + i * 3 }]} />
          ))}
          <Text style={styles.signalLabel}>HD Voice</Text>
        </View>
      )}

      {/* Controls */}
      <View style={styles.controls}>
        {/* Mute */}
        <View style={styles.ctrlWrap}>
          <TouchableOpacity
            style={[styles.ctrlBtn, muted && styles.ctrlBtnActive]}
            onPress={toggleMute}
          >
            <Text style={styles.ctrlIcon}>{muted ? 'ðŸ”‡' : 'ðŸŽ¤'}</Text>
          </TouchableOpacity>
          <Text style={styles.ctrlLabel}>{muted ? 'Unmute' : 'Mute'}</Text>
        </View>

        {/* End call */}
        <View style={styles.ctrlWrap}>
          <TouchableOpacity style={styles.endBtn} onPress={() => endCall(true)}>
            <Text style={styles.endBtnIcon}>ðŸ“µ</Text>
          </TouchableOpacity>
          <Text style={[styles.ctrlLabel, { color: '#FF4D6D' }]}>End</Text>
        </View>

        {/* Speaker */}
        <View style={styles.ctrlWrap}>
          <TouchableOpacity
            style={[styles.ctrlBtn, speaker && styles.ctrlBtnActive]}
            onPress={toggleSpeaker}
          >
            <Text style={styles.ctrlIcon}>{speaker ? 'ðŸ”Š' : 'ðŸ”‰'}</Text>
          </TouchableOpacity>
          <Text style={styles.ctrlLabel}>{speaker ? 'Speaker' : 'Earpiece'}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0E1A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  d2deBadge: {
    position: 'absolute',
    top: 52,
    backgroundColor: '#003328',
    borderWidth: 0.5,
    borderColor: '#00D4AA',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  d2deText: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#00D4AA',
  },
  avatarCircle: {
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: '#003328',
    borderWidth: 3,
    borderColor: '#00D4AA',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
  },
  avatarText: {
    fontSize: 38,
    fontWeight: 'bold',
    color: '#00D4AA',
  },
  callerName: {
    fontSize: 26,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  callStatus: {
    fontSize: 15,
    color: '#64748B',
    marginBottom: 16,
  },
  callStatusActive: {
    color: '#00D4AA',
    fontWeight: 'bold',
  },
  signalRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 3,
    marginBottom: 60,
  },
  signalBar: {
    width: 4,
    backgroundColor: '#00D4AA',
    borderRadius: 2,
  },
  signalLabel: {
    fontSize: 11,
    color: '#00D4AA',
    marginLeft: 6,
    fontWeight: 'bold',
  },
  controls: {
    position: 'absolute',
    bottom: 48,
    flexDirection: 'row',
    gap: 36,
    alignItems: 'center',
  },
  ctrlWrap: {
    alignItems: 'center',
    gap: 6,
  },
  ctrlBtn: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#1A2235',
    borderWidth: 0.5,
    borderColor: '#1E293B',
    justifyContent: 'center',
    alignItems: 'center',
  },
  ctrlBtnActive: {
    backgroundColor: '#003328',
    borderColor: '#00D4AA',
  },
  ctrlIcon: {
    fontSize: 24,
  },
  ctrlLabel: {
    fontSize: 11,
    color: '#64748B',
  },
  endBtn: {
    width: 70,
    height: 70,
    borderRadius: 35,
    backgroundColor: '#FF4D6D',
    justifyContent: 'center',
    alignItems: 'center',
  },
  endBtnIcon: {
    fontSize: 28,
  },
});
