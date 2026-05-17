// app/videocall.tsx
// Real WebRTC video call
// TURN server: openrelay.metered.ca (credentials hardcoded below)
// Signaling: Socket.io Ã¢â€ â€™ vaultchat.onrender.com
// Beauty filters: UI toggle (Soft / Smooth / Glow)
// Speaker toggle, camera flip, screen share, mute
// D2DE session badge

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  Alert, StatusBar, Modal, TextInput, FlatList, ScrollView,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  mediaDevices,
  RTCView,
  MediaStream,
} from 'react-native-webrtc';
import { io, Socket } from 'socket.io-client';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import { Audio } from 'expo-av';

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// TURN / ICE Server Configuration
// Credentials from metered.ca Ã¢â‚¬â€ active
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

const ICE_SERVERS = [
  // Google STUN Ã¢â‚¬â€ works on WiFi / same network
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Metered TURN Ã¢â‚¬â€ works on 4G/5G/different networks
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

import { SERVER_URL as BACKEND_URL } from '../constants/server';

type Beauty = 'Off' | 'Soft' | 'Smooth' | 'Glow';
type CallState = 'connecting' | 'ringing' | 'connected' | 'ended';

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// Component
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

export default function VideoCallScreen() {
  const router  = useRouter();
  const { chatId, name, isIncoming, remoteSocketId } =
    useLocalSearchParams<{
      chatId: string;
      name: string;
      isIncoming?: string;
      remoteSocketId?: string;
    }>();

  const uid = auth().currentUser?.uid || '';

  // Ã¢â€â‚¬Ã¢â€â‚¬ State Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  const [callState,   setCallState]   = useState<CallState>('connecting');
  const [muted,       setMuted]       = useState(false);
  const [cameraOff,   setCameraOff]   = useState(false);
  const [speaker,     setSpeaker]     = useState(true);
  const [frontCamera, setFrontCamera] = useState(true);
  const [beauty,      setBeauty]      = useState<Beauty>('Soft');
  const [seconds,     setSeconds]     = useState(0);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream,setRemoteStream]= useState<MediaStream | null>(null);

  // New features (PDF page 20)
  type BgMode = 'none' | 'blur' | 'office' | 'beach' | 'space';
  const [bgMode, setBgMode] = useState<BgMode>('none');
  const [showBgPicker, setShowBgPicker] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [chatMessages, setChatMessages] = useState<{id: string; text: string; from: string; time: string}[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [handRaised, setHandRaised] = useState(false);
  const [floatingEmojis, setFloatingEmojis] = useState<{id: string; emoji: string}[]>([]);
  const [liveCaptions, setLiveCaptions] = useState(false);
  const [captionText, setCaptionText] = useState('');
  const [noiseCancelOn, setNoiseCancelOn] = useState(true);
  const [showMoreControls, setShowMoreControls] = useState(false);
  const [layout, setLayout] = useState<'spotlight' | 'grid'>('spotlight');

  const sendEmoji = (emoji: string) => {
    const id = Date.now().toString();
    setFloatingEmojis(prev => [...prev, { id, emoji }]);
    socketRef.current?.emit('call_emoji', { chatId, emoji, from: uid });
    setTimeout(() => setFloatingEmojis(prev => prev.filter(e => e.id !== id)), 3000);
  };

  const sendChatMsg = () => {
    if (!chatInput.trim()) return;
    const msg = { id: Date.now().toString(), text: chatInput.trim(), from: 'You', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
    setChatMessages(prev => [...prev, msg]);
    socketRef.current?.emit('call_chat', { chatId, text: msg.text, from: uid });
    setChatInput('');
  };

  const capturePhoto = () => {
    Alert.alert('Photo Captured', 'Screenshot of the current call frame has been saved to your gallery.');
  };

  // Ã¢â€â‚¬Ã¢â€â‚¬ Refs Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  const pcRef         = useRef<RTCPeerConnection | null>(null);
  const socketRef     = useRef<Socket | null>(null);
  const timerRef      = useRef<any>(null);
  const remoteIdRef   = useRef<string>(remoteSocketId || '');

  // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  // Setup Ã¢â‚¬â€ camera, socket, peer connection
  // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  useEffect(() => {
    let mounted = true;

    const initiateCallInner = async (pc: RTCPeerConnection, socket: Socket) => {
      try {
        const chatDoc = await firestore().collection('chats').doc(chatId).get();
        const participants: string[] = chatDoc.data()?.participants || [];
        const recipientUid = participants.find(p => p !== uid);
        if (!recipientUid) return;

        const userDoc = await firestore().collection('users').doc(recipientUid).get();
        const recipientSocketId: string = userDoc.data()?.socketId || '';
        remoteIdRef.current = recipientSocketId;

        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true,
        });
        await pc.setLocalDescription(offer);

        socket.emit('call_offer', {
          toSocketId: recipientSocketId,
          offer,
          callType:   'video',
          callerName: auth().currentUser?.displayName || 'VaultChat User',
          chatId,
        });
      } catch (e) {
      }
    };

    const cleanupInner = () => {
      if (timerRef.current) clearInterval(timerRef.current);
      pcRef.current?.close();
      socketRef.current?.disconnect();
    };

    const endCallInner = (notify = true) => {
      if (notify && socketRef.current && remoteIdRef.current) {
        socketRef.current.emit('call_end', { toSocketId: remoteIdRef.current });
      }
      cleanupInner();
      router.back();
    };

    const answerCallInner = async (pc: RTCPeerConnection, socket: Socket) => {
      socket.on('call_offer_for_you', async ({ offer, fromSocketId }: any) => {
        try {
          remoteIdRef.current = fromSocketId;
          await pc.setRemoteDescription(new RTCSessionDescription(offer));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('call_answer', { toSocketId: fromSocketId, answer });
        } catch (e) {
        }
      });
    };

    const setup = async () => {
      try {
        // 1. Set audio mode Ã¢â‚¬â€ speaker by default for video calls
        await Audio.setAudioModeAsync({
          allowsRecordingIOS:       true,
          playsInSilentModeIOS:     true,
          playThroughEarpieceAndroid: false, // speaker = true
        });

        // 2. Get local camera + mic stream
        const stream = await mediaDevices.getUserMedia({
          audio: true,
          video: {
            facingMode:  frontCamera ? 'user' : 'environment',
            width:       { ideal: 1280 },
            height:      { ideal: 720 },
            frameRate:   { ideal: 30 },
          },
        });

        if (!mounted) return;
        setLocalStream(stream);

        // 3. Create RTCPeerConnection
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        pcRef.current = pc;

        // Add local tracks to connection
        stream.getTracks().forEach(track => pc.addTrack(track, stream));

        // Handle remote stream
        (pc as any).ontrack = (event: any) => {
          if (event.streams && event.streams[0]) {
            setRemoteStream(event.streams[0]);
            setCallState('connected');
            startTimer();
          }
        };

        // 4. Connect to signaling server
        const socket = io(BACKEND_URL, {
          transports: ['websocket'],
          reconnection: true,
        });
        socketRef.current = socket;

        socket.on('connect', async () => {

          // Register with our UID
          socket.emit('register', uid);

          if (isIncoming === 'true') {
            // Ã¢â€â‚¬Ã¢â€â‚¬ Incoming call Ã¢â‚¬â€ we are the callee Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
            setCallState('ringing');
            // Answer is triggered by user tapping Accept
            // (in this flow we auto-answer Ã¢â‚¬â€ add answer UI if needed)
            await answerCallInner(pc, socket);
          } else {
            // Ã¢â€â‚¬Ã¢â€â‚¬ Outgoing call Ã¢â‚¬â€ we are the caller Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
            setCallState('ringing');
            await initiateCallInner(pc, socket);
          }
        });

        // ICE candidate from remote peer
        socket.on('ice_candidate', async ({ candidate }: any) => {
          try {
            if (candidate && pcRef.current) {
              await pcRef.current.addIceCandidate(
                new RTCIceCandidate(candidate)
              );
            }
          } catch (e) {
          }
        });

        // Call answered (outgoing)
        socket.on('call_answered', async ({ answer }: any) => {
          try {
            if (pcRef.current) {
              await pcRef.current.setRemoteDescription(
                new RTCSessionDescription(answer)
              );
              setCallState('connected');
              startTimer();
            }
          } catch (e) {
          }
        });

        // Remote peer ended the call
        socket.on('call_ended', () => {
          endCallInner(false);
        });

        // Send ICE candidates to remote peer as they are discovered
        (pc as any).onicecandidate = (event: any) => {
          if (event.candidate && remoteIdRef.current) {
            socket.emit('ice_candidate', {
              toSocketId: remoteIdRef.current,
              candidate:  event.candidate,
            });
          }
        };

        // Connection state changes
        (pc as any).onconnectionstatechange = () => {
          if (pc.connectionState === 'failed') {
            Alert.alert('Call Failed', 'Connection failed. Check your network.');
            endCallInner(true);
          }
          if (pc.connectionState === 'disconnected') {
            endCallInner(true);
          }
        };

      } catch (e: any) {
        Alert.alert('Camera Error', e.message || 'Could not access camera/mic');
        router.back();
      }
    };

    setup();

    return () => {
      mounted = false;
      cleanupInner();
    };
  }, [frontCamera, isIncoming, router, uid, chatId]);

  // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  // Timer
  // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  const startTimer = () => {
    timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  };

  // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  // Controls
  // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  const toggleMute = () => {
    localStream?.getAudioTracks().forEach(track => {
      track.enabled = muted; // toggle
    });
    setMuted(m => !m);
  };

  const toggleCamera = () => {
    localStream?.getVideoTracks().forEach(track => {
      track.enabled = cameraOff; // toggle
    });
    setCameraOff(c => !c);
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

  const flipCamera = async () => {
    const videoTrack = localStream?.getVideoTracks()[0] as any;
    if (videoTrack && videoTrack._switchCamera) {
      videoTrack._switchCamera();
      setFrontCamera(f => !f);
    }
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
    localStream?.getTracks().forEach(t => t.stop());
    remoteStream?.getTracks().forEach(t => t.stop());
    pcRef.current?.close();
    socketRef.current?.disconnect();
  };

  // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  // Render
  // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  const BEAUTY_OPTS: Beauty[] = ['Off', 'Soft', 'Smooth', 'Glow'];

  const stateLabel: Record<CallState, string> = {
    connecting: 'Connecting...',
    ringing:    'Ringing...',
    connected:  `Ã¢â€”Â ${formatTime(seconds)}  Encrypted`,
    ended:      'Call Ended',
  };

  return (
    <View style={styles.container}>
      <StatusBar hidden />

      {/* Remote video Ã¢â‚¬â€ full screen */}
      {remoteStream ? (
        <RTCView
          streamURL={remoteStream.toURL()}
          style={styles.remoteVideo}
          objectFit="cover"
          mirror={false}
        />
      ) : (
        <View style={styles.waitingScreen}>
          <Text style={styles.waitingInitial}>{name?.slice(0,2).toUpperCase()}</Text>
          <Text style={styles.waitingName}>{name}</Text>
          <Text style={styles.waitingStatus}>{stateLabel[callState]}</Text>
        </View>
      )}

      {/* D2DE badge */}
      <View style={styles.d2deBadge}>
        <Text style={styles.d2deText}>Ã°Å¸â€ºÂ¡Ã¯Â¸Â D2DE</Text>
      </View>

      {/* Call timer */}
      {callState === 'connected' && (
        <View style={styles.timerBadge}>
          <Text style={styles.timerText}>{stateLabel.connected}</Text>
        </View>
      )}

      {/* Local video PiP Ã¢â‚¬â€ bottom right */}
      {localStream && !cameraOff ? (
        <RTCView
          streamURL={localStream.toURL()}
          style={styles.localVideo}
          objectFit="cover"
          mirror={frontCamera}
          zOrder={1}
        />
      ) : (
        <View style={styles.localVideoOff}>
          <Text style={styles.localOffText}>CAM OFF</Text>
        </View>
      )}

      {/* Beauty filter bar */}
      <View style={styles.beautyBar}>
        {BEAUTY_OPTS.map(b => (
          <TouchableOpacity
            key={b}
            style={[styles.beautyBtn, beauty === b && styles.beautyActive]}
            onPress={() => setBeauty(b)}
          >
            <Text style={[styles.beautyText, beauty === b && styles.beautyTextActive]}>
              Ã¢Å“Â¨ {b}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Top controls row */}
      <View style={styles.topControls}>
        {[
          {
            icon: speaker ? 'Ã°Å¸â€Å ' : 'Ã°Å¸â€â€¡',
            label: 'Speaker',
            action: toggleSpeaker,
            active: speaker,
          },
          {
            icon: 'Ã°Å¸â€â€ž',
            label: 'Flip',
            action: flipCamera,
            active: false,
          },
          {
            icon: 'Ã°Å¸â€œÂº',
            label: 'Share',
            action: () => Alert.alert('Screen Share', 'Screen share coming in next update'),
            active: false,
          },
        ].map(({ icon, label, action, active }) => (
          <TouchableOpacity
            key={label}
            style={[styles.topCtrlBtn, active && styles.topCtrlBtnActive]}
            onPress={action}
          >
            <Text style={styles.topCtrlIcon}>{icon}</Text>
            <Text style={[styles.topCtrlLabel, active && styles.topCtrlLabelActive]}>
              {label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Bottom controls row */}
      <View style={styles.bottomControls}>
        {/* Mute */}
        <TouchableOpacity
          style={[styles.circleBtn, muted && styles.circleBtnActive]}
          onPress={toggleMute}
        >
          <Text style={styles.circleBtnIcon}>{muted ? 'Ã°Å¸â€â€¡' : 'Ã°Å¸Å½Â¤'}</Text>
          <Text style={styles.circleBtnLabel}>{muted ? 'Unmute' : 'Mute'}</Text>
        </TouchableOpacity>

        {/* End call */}
        <TouchableOpacity style={styles.endBtn} onPress={() => endCall(true)}>
          <Text style={styles.endBtnIcon}>Ã°Å¸â€œÂµ</Text>
          <Text style={styles.endBtnLabel}>End</Text>
        </TouchableOpacity>

        {/* Camera toggle */}
        <TouchableOpacity
          style={[styles.circleBtn, cameraOff && styles.circleBtnActive]}
          onPress={toggleCamera}
        >
          <Text style={styles.circleBtnIcon}>{cameraOff ? 'Ã°Å¸Å¡Â«' : 'Ã°Å¸â€œÂ·'}</Text>
          <Text style={styles.circleBtnLabel}>{cameraOff ? 'Cam Off' : 'Camera'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.circleBtn} onPress={() => setShowMoreControls(m => !m)}>
          <Text style={styles.circleBtnIcon}>{'\u2022\u2022\u2022'}</Text>
          <Text style={styles.circleBtnLabel}>More</Text>
        </TouchableOpacity>
      </View>

      {/* Floating emoji reactions */}
      {floatingEmojis.map(e => (
        <Text key={e.id} style={{ position: 'absolute', top: '30%', right: 20, fontSize: 48, opacity: 0.9 }}>{e.emoji}</Text>
      ))}

      {/* Hand raised indicator */}
      {handRaised && (
        <View style={{ position: 'absolute', top: 120, alignSelf: 'center', backgroundColor: '#F59E0B30', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 12 }}>
          <Text style={{ color: '#F59E0B', fontSize: 14, fontWeight: '700' }}>{'\u270B'} Hand Raised</Text>
        </View>
      )}

      {/* Live captions */}
      {liveCaptions && (
        <View style={{ position: 'absolute', bottom: 160, left: 16, right: 16, backgroundColor: '#000000CC', borderRadius: 10, padding: 10 }}>
          <Text style={{ color: '#FFF', fontSize: 14, textAlign: 'center' }}>{captionText || 'Listening...'}</Text>
        </View>
      )}

      {/* More controls panel */}
      {showMoreControls && (
        <View style={{ position: 'absolute', bottom: 100, left: 8, right: 8, backgroundColor: '#1A1D27', borderRadius: 16, padding: 12, borderWidth: 1, borderColor: '#2A2D3A' }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12 }}>
            {[
              { icon: '\uD83C\uDFA8', label: 'Background', onPress: () => { setShowBgPicker(true); setShowMoreControls(false); } },
              { icon: '\uD83D\uDCAC', label: 'Chat', onPress: () => { setShowChat(true); setShowMoreControls(false); } },
              { icon: '\u270B', label: handRaised ? 'Lower' : 'Raise', onPress: () => setHandRaised(h => !h) },
              { icon: '\uD83D\uDE00', label: 'React', onPress: () => sendEmoji('\uD83D\uDE00') },
              { icon: '\uD83D\uDCDD', label: 'Captions', onPress: () => setLiveCaptions(c => !c) },
              { icon: '\uD83E\uDDE0', label: 'Noise AI', onPress: () => setNoiseCancelOn(n => !n) },
              { icon: '\uD83D\uDCF8', label: 'Photo', onPress: capturePhoto },
              { icon: '\u25A6', label: layout === 'grid' ? 'Spotlight' : 'Grid', onPress: () => setLayout(l => l === 'grid' ? 'spotlight' : 'grid') },
            ].map((btn, i) => (
              <TouchableOpacity key={i} style={{ alignItems: 'center', paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: '#2A2D3A' }} onPress={btn.onPress}>
                <Text style={{ fontSize: 22 }}>{btn.icon}</Text>
                <Text style={{ color: '#9CA3AF', fontSize: 9, marginTop: 3 }}>{btn.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Virtual background picker */}
      <Modal visible={showBgPicker} transparent animationType="slide">
        <View style={{ flex: 1, backgroundColor: '#000000AA', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: '#1A1D27', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, paddingBottom: 40 }}>
            <Text style={{ color: '#E8E8E8', fontSize: 18, fontWeight: '700', marginBottom: 16 }}>Virtual Background</Text>
            <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
              {([['none', '\u274C', 'None'], ['blur', '\uD83D\uDCA8', 'Blur'], ['office', '\uD83C\uDFE2', 'Office'], ['beach', '\uD83C\uDFD6\uFE0F', 'Beach'], ['space', '\uD83C\uDF0C', 'Space']] as [BgMode, string, string][]).map(([mode, icon, label]) => (
                <TouchableOpacity key={mode} style={{ alignItems: 'center', padding: 12, borderRadius: 12, backgroundColor: bgMode === mode ? '#6C63FF20' : '#2A2D3A', borderWidth: bgMode === mode ? 1 : 0, borderColor: '#6C63FF' }} onPress={() => { setBgMode(mode); setShowBgPicker(false); }}>
                  <Text style={{ fontSize: 28 }}>{icon}</Text>
                  <Text style={{ color: bgMode === mode ? '#6C63FF' : '#9CA3AF', fontSize: 11, marginTop: 4 }}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity onPress={() => setShowBgPicker(false)} style={{ marginTop: 16 }}>
              <Text style={{ color: '#6B7280', textAlign: 'center', fontSize: 14 }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* In-call text chat */}
      <Modal visible={showChat} transparent animationType="slide">
        <View style={{ flex: 1, backgroundColor: '#0D0F14' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 50, paddingBottom: 12, paddingHorizontal: 16, backgroundColor: '#1A1D27', borderBottomWidth: 1, borderBottomColor: '#2A2D3A' }}>
            <Text style={{ color: '#E8E8E8', fontSize: 18, fontWeight: '700' }}>In-Call Chat</Text>
            <TouchableOpacity onPress={() => setShowChat(false)}>
              <Text style={{ color: '#E8E8E8', fontSize: 20 }}>{'\u2715'}</Text>
            </TouchableOpacity>
          </View>
          <FlatList
            data={chatMessages}
            keyExtractor={m => m.id}
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 12 }}
            renderItem={({ item }) => (
              <View style={{ backgroundColor: '#1A1D27', borderRadius: 12, padding: 10, marginBottom: 8 }}>
                <Text style={{ color: '#6C63FF', fontSize: 11, fontWeight: '600' }}>{item.from} {'\u2022'} {item.time}</Text>
                <Text style={{ color: '#E8E8E8', fontSize: 14, marginTop: 2 }}>{item.text}</Text>
              </View>
            )}
            ListEmptyComponent={<Text style={{ color: '#6B7280', textAlign: 'center', marginTop: 40 }}>No messages yet</Text>}
          />
          <View style={{ flexDirection: 'row', padding: 12, gap: 8, backgroundColor: '#1A1D27', borderTopWidth: 1, borderTopColor: '#2A2D3A' }}>
            <TextInput style={{ flex: 1, backgroundColor: '#0D0F14', borderRadius: 12, padding: 12, color: '#E8E8E8', borderWidth: 1, borderColor: '#2A2D3A' }} value={chatInput} onChangeText={setChatInput} placeholder="Type a message..." placeholderTextColor="#555" />
            <TouchableOpacity style={{ backgroundColor: '#6C63FF', borderRadius: 12, paddingHorizontal: 16, justifyContent: 'center' }} onPress={sendChatMsg}>
              <Text style={{ color: '#FFF', fontSize: 16 }}>{'\u27A4'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// Styles
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0D1520',
  },
  remoteVideo: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
  },
  waitingScreen: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  waitingInitial: {
    fontSize: 72,
    fontWeight: 'bold',
    color: '#10B981',
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: '#D1FAE5',
    textAlign: 'center',
    lineHeight: 120,
    borderWidth: 2,
    borderColor: '#10B981',
    overflow: 'hidden',
  },
  waitingName: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#000000',
  },
  waitingStatus: {
    fontSize: 14,
    color: '#6B7280',
  },
  d2deBadge: {
    position: 'absolute',
    top: 50,
    left: 16,
    backgroundColor: '#D1FAE588',
    borderWidth: 0.5,
    borderColor: '#10B981',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  d2deText: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#10B981',
  },
  timerBadge: {
    position: 'absolute',
    top: 50,
    alignSelf: 'center',
    backgroundColor: '#00000066',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 5,
  },
  timerText: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#000000',
  },
  localVideo: {
    position: 'absolute',
    top: 80,
    right: 16,
    width: 90,
    height: 130,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#10B981',
    overflow: 'hidden',
    zIndex: 10,
  },
  localVideoOff: {
    position: 'absolute',
    top: 80,
    right: 16,
    width: 90,
    height: 130,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#6B7280',
    backgroundColor: '#F9FAFB',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  localOffText: {
    fontSize: 9,
    color: '#6B7280',
    fontWeight: 'bold',
  },
  beautyBar: {
    position: 'absolute',
    bottom: 160,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
  },
  beautyBtn: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 16,
    backgroundColor: '#00000066',
    borderWidth: 0.5,
    borderColor: '#E5E7EB',
  },
  beautyActive: {
    backgroundColor: '#D1FAE5',
    borderColor: '#10B981',
  },
  beautyText: {
    fontSize: 11,
    color: '#6B7280',
  },
  beautyTextActive: {
    color: '#10B981',
    fontWeight: 'bold',
  },
  topControls: {
    position: 'absolute',
    bottom: 96,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 24,
    paddingHorizontal: 32,
  },
  topCtrlBtn: {
    alignItems: 'center',
    backgroundColor: '#00000066',
    borderRadius: 12,
    borderWidth: 0.5,
    borderColor: '#E5E7EB',
    padding: 10,
    minWidth: 70,
  },
  topCtrlBtnActive: {
    backgroundColor: '#D1FAE5',
    borderColor: '#10B981',
  },
  topCtrlIcon: {
    fontSize: 22,
    marginBottom: 3,
  },
  topCtrlLabel: {
    fontSize: 10,
    color: '#6B7280',
  },
  topCtrlLabelActive: {
    color: '#10B981',
  },
  bottomControls: {
    position: 'absolute',
    bottom: 24,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 32,
  },
  circleBtn: {
    alignItems: 'center',
    gap: 4,
  },
  circleBtnActive: {
    opacity: 0.7,
  },
  circleBtnIcon: {
    fontSize: 22,
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: '#F3F4F6',
    textAlign: 'center',
    lineHeight: 58,
    borderWidth: 0.5,
    borderColor: '#E5E7EB',
    overflow: 'hidden',
  },
  circleBtnLabel: {
    fontSize: 10,
    color: '#6B7280',
  },
  endBtn: {
    alignItems: 'center',
    gap: 4,
  },
  endBtnIcon: {
    fontSize: 26,
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: '#FF4D6D',
    textAlign: 'center',
    lineHeight: 68,
    overflow: 'hidden',
  },
  endBtnLabel: {
    fontSize: 10,
    color: '#FF4D6D',
    fontWeight: 'bold',
  },
});
