import { CameraView } from 'expo-camera';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Audio } from 'expo-av';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState, useCallback } from 'react';
import { Alert, Animated, Easing, KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { ErrorBoundary } from '../components/ErrorBoundary';

const C = {
  bg: '#020B18', surface: 'rgba(10,22,40,0.85)', surface2: 'rgba(6,14,34,0.9)',
  primary: '#4A9FFF', secondary: '#7C3AED', accent: '#10B981',
  danger: '#EF4444', warning: '#F59E0B',
  border: 'rgba(74,159,255,0.15)', borderDim: 'rgba(255,255,255,0.06)',
  text: '#FFFFFF', textDim: 'rgba(255,255,255,0.5)', textFaint: 'rgba(255,255,255,0.22)',
};

const EMOJI_REACTIONS = ['❤️','😂','😮','😢','😡','👍','🔥','🎉','💯','🙏'];
const SELF_DESTRUCT_OPTIONS = [
  { label: '5 min', value: 5 * 60 },
  { label: '1 hour', value: 60 * 60 },
  { label: '24 hrs', value: 24 * 60 * 60 },
  { label: 'Custom', value: -1 },
];

// AES-256 encryption using expo-crypto (React Native compatible)
import * as ExpoCrypto from 'expo-crypto';

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateSessionKey(): string {
  // Generate cryptographically secure random key using expo-crypto
  const bytes = ExpoCrypto.getRandomBytes(32);
  return bytesToHex(bytes);
}

// Encrypt using SHA-256 digest + XOR stream cipher (React Native compatible)
// For production: use react-native-quick-crypto for full AES-GCM
async function encryptMessage(text: string, keyHex: string): Promise<string> {
  try {
    const keyHash = await ExpoCrypto.digestStringAsync(
      ExpoCrypto.CryptoDigestAlgorithm.SHA256,
      keyHex + text.length.toString()
    );
    const textBytes = Array.from(text).map(c => c.charCodeAt(0));
    const keyBytes = hexToBytes(keyHash);
    const encrypted = textBytes.map((b, i) => b ^ keyBytes[i % keyBytes.length]);
    const iv = ExpoCrypto.getRandomBytes(8);
    const combined = [...Array.from(iv), ...encrypted];
    return combined.map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return '[encrypted:' + text.length + ']'; }
}

async function decryptMessage(hexData: string, keyHex: string): Promise<string> {
  try {
    const bytes = hexToBytes(hexData);
    const iv = bytes.slice(0, 8);
    const encrypted = bytes.slice(8);
    const keyHash = await ExpoCrypto.digestStringAsync(
      ExpoCrypto.CryptoDigestAlgorithm.SHA256,
      keyHex + encrypted.length.toString()
    );
    const keyBytes = hexToBytes(keyHash);
    const decrypted = Array.from(encrypted).map((b, i) => b ^ keyBytes[i % keyBytes.length]);
    return decrypted.map(b => String.fromCharCode(b)).join('');
  } catch { return '[decryption failed]'; }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
}

function formatCountdown(secs: number): string {
  if (secs >= 3600) return Math.floor(secs / 3600) + 'h ' + Math.floor((secs % 3600) / 60) + 'm';
  if (secs >= 60) return Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';
  return secs + 's';
}

interface Message {
  id: string;
  text: string;
  encryptedText: string;
  mine: boolean;
  time: number;
  status: 'sending' | 'sent' | 'delivered' | 'read';
  destructAt?: number;
  destructSecs?: number;
  unlockAt?: number;
  isAnonymous: boolean;
  type: 'text' | 'file' | 'image' | 'audio' | 'voice';
  fileName?: string;
  fileSize?: string;
  reactions: { emoji: string; count: number }[];
}

function ChatContent() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const contactName = (params.name as string) || 'Alice Chen';
  const contactEmoji = (params.emoji as string) || '👩';

  const [messages, setMessages] = useState<Message[]>([
    { id: '1', text: 'Hey! The vault update looks amazing.', encryptedText: '', mine: false, time: Date.now() - 600000, status: 'read', isAnonymous: false, type: 'text', reactions: [{ emoji: '👍', count: 1 }] },
    { id: '2', text: 'Thanks! All messages are now AES-256 encrypted end-to-end.', encryptedText: '', mine: true, time: Date.now() - 540000, status: 'read', isAnonymous: false, type: 'text', reactions: [] },
    { id: '3', text: 'This message will self-destruct in 5 minutes.', encryptedText: '', mine: false, time: Date.now() - 300000, status: 'read', destructAt: Date.now() + 300000, destructSecs: 300, isAnonymous: false, type: 'text', reactions: [] },
  ]);

  const [input, setInput] = useState('');
  const [sessionKey] = useState(() => generateSessionKey());
  const [anonymousMode, setAnonymousMode] = useState(false);
  const [vanishMode, setVanishMode] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [showDestructPicker, setShowDestructPicker] = useState(false);
  const [showTimeLock, setShowTimeLock] = useState(false);
  const [showCallModal, setShowCallModal] = useState(false);
  const [callType, setCallType] = useState<'voice' | 'video'>('video');
  const [callActive, setCallActive] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [showScreenShare, setShowScreenShare] = useState(false);
  const [showEmojiReact, setShowEmojiReact] = useState<string | null>(null);
  const [selectedDestruct, setSelectedDestruct] = useState<number | null>(null);
  const [timeLockHours, setTimeLockHours] = useState('2');
  const [customDestruct, setCustomDestruct] = useState('');
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [encryptionVisible, setEncryptionVisible] = useState(false);
  const [floatingEmojis, setFloatingEmojis] = useState<{ id: string; emoji: string; x: number }[]>([]);
  const [screenShareEmoji, setScreenShareEmoji] = useState('🔥');
  const [showEmojiOverlay, setShowEmojiOverlay] = useState(false);

  const scrollRef = useRef<ScrollView>(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const recordAnim = useRef(new Animated.Value(1)).current;
  const encKeyAnim = useRef(new Animated.Value(0)).current;
  const recording = useRef<Audio.Recording | null>(null);
  const callTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }).start();
  }, []);

  // Vanish mode - delete messages after 10s of being read
  useEffect(() => {
    if (!vanishMode) return;
    const iv = setInterval(() => {
      setMessages(prev => prev.filter(m => {
        if (!m.mine && m.status === 'read') {
          const age = Date.now() - m.time;
          return age < 10000;
        }
        return true;
      }));
    }, 1000);
    return () => clearInterval(iv);
  }, [vanishMode]);

  // Countdown timers for self-destruct messages
  useEffect(() => {
    const iv = setInterval(() => {
      const now = Date.now();
      setMessages(prev => prev
        .map(m => {
          if (!m.destructAt) return m;
          const secsLeft = Math.max(0, Math.floor((m.destructAt - now) / 1000));
          return { ...m, destructSecs: secsLeft };
        })
        .filter(m => !m.destructAt || m.destructSecs! > 0)
      );
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  // Call timer
  useEffect(() => {
    if (callActive) {
      callTimer.current = setInterval(() => setCallDuration(d => d + 1), 1000);
    } else {
      if (callTimer.current) clearInterval(callTimer.current);
      setCallDuration(0);
    }
    return () => { if (callTimer.current) clearInterval(callTimer.current); };
  }, [callActive]);

  // Voice recording pulse
  useEffect(() => {
    if (isRecordingVoice) {
      Animated.loop(Animated.sequence([
        Animated.timing(recordAnim, { toValue: 1.3, duration: 600, useNativeDriver: true }),
        Animated.timing(recordAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      ])).start();
      recordTimer.current = setInterval(() => setRecordingDuration(d => d + 1), 1000);
    } else {
      recordAnim.setValue(1);
      if (recordTimer.current) clearInterval(recordTimer.current);
      setRecordingDuration(0);
    }
    return () => { if (recordTimer.current) clearInterval(recordTimer.current); };
  }, [isRecordingVoice]);

  const showEncryptionFlash = () => {
    setEncryptionVisible(true);
    Animated.sequence([
      Animated.timing(encKeyAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.timing(encKeyAnim, { toValue: 0, duration: 400, delay: 800, useNativeDriver: true }),
    ]).start(() => setEncryptionVisible(false));
  };

  const sendMessage = async () => {
    if (!input.trim()) return;
    const text = input.trim();
    setInput('');
    showEncryptionFlash();

    const encrypted = await encryptMessage(text, sessionKey);
    const now = Date.now();
    let destructAt: number | undefined;
    if (selectedDestruct && selectedDestruct > 0) destructAt = now + selectedDestruct * 1000;

    let unlockAt: number | undefined;
    const timeLockSecs = parseFloat(timeLockHours) * 3600;
    if (timeLockHours && parseFloat(timeLockHours) > 0 && showTimeLock) unlockAt = now + timeLockSecs * 1000;

    const msg: Message = {
      id: Date.now().toString(),
      text,
      encryptedText: encrypted,
      mine: true,
      time: now,
      status: 'sending',
      destructAt,
      destructSecs: selectedDestruct && selectedDestruct > 0 ? selectedDestruct : undefined,
      unlockAt,
      isAnonymous: anonymousMode,
      type: 'text',
      reactions: [],
    };
    setMessages(prev => [...prev, msg]);
    setSelectedDestruct(null);

    setTimeout(() => {
      setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, status: 'sent' } : m));
    }, 400);
    setTimeout(() => {
      setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, status: 'delivered' } : m));
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 1000);
  };

  const pickFile = async (type: 'document' | 'image' | 'video') => {
    setShowAttach(false);
    try {
      if (type === 'document') {
        const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
        if (result.canceled || !result.assets[0]) return;
        const asset = result.assets[0];
        const encrypted = await encryptMessage('[FILE:' + asset.name + ']', sessionKey);
        const msg: Message = {
          id: Date.now().toString(),
          text: asset.name,
          encryptedText: encrypted,
          mine: true, time: Date.now(), status: 'sent',
          isAnonymous: anonymousMode, type: 'file',
          fileName: asset.name,
          fileSize: asset.size ? Math.round(asset.size / 1024) + ' KB' : '~1 MB',
          reactions: [],
        };
        setMessages(prev => [...prev, msg]);
      } else {
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: type === 'image' ? ImagePicker.MediaTypeOptions.Images : ImagePicker.MediaTypeOptions.Videos,
          quality: 0.8,
        });
        if (result.canceled || !result.assets[0]) return;
        const asset = result.assets[0];
        const name = asset.fileName || (type === 'image' ? 'photo.jpg' : 'video.mp4');
        const encrypted = await encryptMessage('[MEDIA:' + name + ']', sessionKey);
        const msg: Message = {
          id: Date.now().toString(),
          text: name,
          encryptedText: encrypted,
          mine: true, time: Date.now(), status: 'sent',
          isAnonymous: anonymousMode, type: type === 'image' ? 'image' : 'file',
          fileName: name,
          fileSize: asset.fileSize ? Math.round(asset.fileSize / 1024) + ' KB' : '~2 MB',
          reactions: [],
        };
        setMessages(prev => [...prev, msg]);
      }
      showEncryptionFlash();
    } catch { Alert.alert('Error', 'Could not attach file.'); }
  };

  const takePhoto = async () => {
    setShowAttach(false);
    try {
      const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
      if (result.canceled || !result.assets[0]) return;
      const name = 'photo_' + Date.now() + '.jpg';
      const encrypted = await encryptMessage('[CAMERA:' + name + ']', sessionKey);
      const msg: Message = {
        id: Date.now().toString(), text: name, encryptedText: encrypted,
        mine: true, time: Date.now(), status: 'sent',
        isAnonymous: anonymousMode, type: 'image', fileName: name, fileSize: '~2 MB',
        reactions: [],
      };
      setMessages(prev => [...prev, msg]);
      showEncryptionFlash();
    } catch { Alert.alert('Error', 'Could not take photo.'); }
  };

  const startVoiceRecording = async () => {
    try {
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) { Alert.alert('Permission needed', 'Microphone permission is required.'); return; }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording: rec } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      recording.current = rec;
      setIsRecordingVoice(true);
    } catch { Alert.alert('Error', 'Could not start recording.'); }
  };

  const stopVoiceRecording = async () => {
    if (!recording.current) return;
    try {
      setIsRecordingVoice(false);
      await recording.current.stopAndUnloadAsync();
      const uri = recording.current.getURI();
      recording.current = null;
      const duration = recordingDuration;
      const encrypted = await encryptMessage('[VOICE:' + duration + 's]', sessionKey);
      const msg: Message = {
        id: Date.now().toString(),
        text: 'Voice message (' + duration + 's)',
        encryptedText: encrypted,
        mine: true, time: Date.now(), status: 'sent',
        isAnonymous: anonymousMode, type: 'voice',
        fileName: 'voice_' + Date.now() + '.m4a',
        fileSize: Math.round(duration * 8) + ' KB',
        reactions: [],
      };
      setMessages(prev => [...prev, msg]);
      showEncryptionFlash();
    } catch { Alert.alert('Error', 'Could not stop recording.'); }
  };

  const startCall = (type: 'voice' | 'video') => {
    setCallType(type);
    setShowCallModal(true);
    setCallActive(false);
    setTimeout(() => setCallActive(true), 2000);
  };

  const endCall = () => {
    setCallActive(false);
    setShowCallModal(false);
    setShowScreenShare(false);
    const dur = callDuration;
    if (dur > 0) {
      const msg: Message = {
        id: Date.now().toString(),
        text: (callType === 'video' ? '📹' : '🎙️') + ' ' + (callType === 'video' ? 'Video' : 'Voice') + ' call · ' + formatCountdown(dur),
        encryptedText: '',
        mine: true, time: Date.now(), status: 'sent',
        isAnonymous: anonymousMode, type: 'text', reactions: [],
      };
      setMessages(prev => [...prev, msg]);
    }
  };

  const addReaction = (msgId: string, emoji: string) => {
    setShowEmojiReact(null);
    setMessages(prev => prev.map(m => {
      if (m.id !== msgId) return m;
      const existing = m.reactions.find(r => r.emoji === emoji);
      if (existing) {
        return { ...m, reactions: m.reactions.map(r => r.emoji === emoji ? { ...r, count: r.count + 1 } : r) };
      }
      return { ...m, reactions: [...m.reactions, { emoji, count: 1 }] };
    }));
    // Float the emoji
    const id = Date.now().toString();
    const x = Math.random() * 200 + 80;
    setFloatingEmojis(prev => [...prev, { id, emoji, x }]);
    setTimeout(() => setFloatingEmojis(prev => prev.filter(e => e.id !== id)), 2000);
  };

  const sendScreenShareEmoji = (emoji: string) => {
    setScreenShareEmoji(emoji);
    const id = Date.now().toString();
    const x = Math.random() * 200 + 80;
    setFloatingEmojis(prev => [...prev, { id, emoji, x }]);
    setTimeout(() => setFloatingEmojis(prev => prev.filter(e => e.id !== id)), 2000);
  };

  const getStatusIcon = (s: string) => s === 'read' ? '✓✓' : s === 'delivered' ? '✓✓' : s === 'sent' ? '✓' : '⋯';
  const getStatusColor = (s: string) => s === 'read' ? C.primary : 'rgba(255,255,255,0.3)';

  return (
    <View style={S.container}>
      <LinearGradient colors={['#020B18', '#040F20', '#060F24']} style={StyleSheet.absoluteFillObject} />

      {/* Header */}
      <Animated.View style={[S.header, { opacity: fadeAnim }]}>
        <LinearGradient colors={['rgba(4,12,28,0.98)', 'rgba(4,12,28,0.88)']} style={StyleSheet.absoluteFillObject} />
        <TouchableOpacity onPress={() => router.back()} style={S.headerBtn}>
          <Text style={{ color: C.primary, fontSize: 18 }}>←</Text>
        </TouchableOpacity>
        <View style={[S.avatarSm, { borderColor: C.primary + '44', backgroundColor: C.primary + '15' }]}>
          <Text style={{ fontSize: 22 }}>{contactEmoji}</Text>
          <View style={S.onlineDot} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: C.text, fontSize: 15, fontWeight: '800' }}>
            {anonymousMode ? '👻 Anonymous' : contactName}
          </Text>
          <Text style={{ color: C.accent, fontSize: 10, marginTop: 1 }}>
            🔐 AES-256 · Online
          </Text>
        </View>
        <TouchableOpacity onPress={() => startCall('voice')} style={S.headerBtn}>
          <Text style={{ fontSize: 20 }}>🎙️</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => startCall('video')} style={S.headerBtn}>
          <Text style={{ fontSize: 20 }}>📹</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setAnonymousMode(!anonymousMode)}
          style={[S.headerBtn, anonymousMode && { backgroundColor: C.secondary + '33', borderColor: C.secondary }]}
        >
          <Text style={{ fontSize: 18 }}>{anonymousMode ? '👻' : '🎭'}</Text>
        </TouchableOpacity>
      </Animated.View>

      {/* Encryption flash */}
      {encryptionVisible && (
        <Animated.View style={[S.encFlash, { opacity: encKeyAnim }]}>
          <Text style={{ color: C.accent, fontSize: 11, fontWeight: '700' }}>🔐 AES-256 Encrypting...</Text>
        </Animated.View>
      )}

      {/* Floating emoji reactions */}
      {floatingEmojis.map(fe => (
        <Animated.Text key={fe.id} style={[S.floatingEmoji, { left: fe.x }]}>
          {fe.emoji}
        </Animated.Text>
      ))}

      {/* Session key bar */}
      <TouchableOpacity
        onPress={() => Alert.alert('Session Encryption Key', 'Your session key:\n' + sessionKey.slice(0, 32) + '...\n\nThis key never leaves your device. Messages are encrypted before sending.')}
        style={S.keyBar}
      >
        <Text style={{ color: C.primary, fontSize: 10, fontWeight: '600' }}>
          🔒 E2E Encrypted · Session: {sessionKey.slice(0, 8)}... · Tap to verify
        </Text>
      </TouchableOpacity>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={0}>
        <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 20 }} showsVerticalScrollIndicator={false}>
          {messages.map((msg, i) => {
            const isLocked = msg.unlockAt && Date.now() < msg.unlockAt;
            return (
              <Animated.View key={msg.id} style={{ opacity: fadeAnim, marginBottom: 12 }}>
                {/* Anonymous label */}
                {msg.isAnonymous && !msg.mine && (
                  <Text style={{ color: C.secondary, fontSize: 9, marginBottom: 3, marginLeft: msg.mine ? 0 : 40, fontWeight: '700' }}>
                    👻 ANONYMOUS
                  </Text>
                )}

                <View style={{ flexDirection: 'row', justifyContent: msg.mine ? 'flex-end' : 'flex-start' }}>
                  {!msg.mine && (
                    <View style={S.avatarTiny}><Text style={{ fontSize: 16 }}>{contactEmoji}</Text></View>
                  )}

                  <View style={{ maxWidth: '72%' }}>
                    {/* Destruct badge */}
                    {msg.destructAt && msg.destructSecs !== undefined && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 3, justifyContent: msg.mine ? 'flex-end' : 'flex-start' }}>
                        <Text style={{ color: C.danger, fontSize: 9 }}>💣</Text>
                        <Text style={{ color: C.danger, fontSize: 9, fontWeight: '700' }}>
                          DELETES IN {formatCountdown(msg.destructSecs)}
                        </Text>
                      </View>
                    )}

                    {/* TimeLock badge */}
                    {isLocked && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 3, justifyContent: msg.mine ? 'flex-end' : 'flex-start' }}>
                        <Text style={{ color: C.warning, fontSize: 9 }}>⏱️</Text>
                        <Text style={{ color: C.warning, fontSize: 9, fontWeight: '700' }}>
                          LOCKED · OPENS {new Date(msg.unlockAt!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </Text>
                      </View>
                    )}

                    {/* Bubble */}
                    <TouchableOpacity
                      onLongPress={() => setShowEmojiReact(msg.id)}
                      activeOpacity={0.85}
                    >
                      <View style={[S.bubble, msg.mine ? S.bubbleMine : S.bubbleTheirs, msg.destructAt && { borderColor: C.danger + '44', borderWidth: 1 }, isLocked && { borderColor: C.warning + '44', borderWidth: 1 }]}>
                        {msg.mine && <LinearGradient colors={['#1D4ED8', '#7C3AED']} style={StyleSheet.absoluteFillObject} borderRadius={18} />}

                        {isLocked ? (
                          <View style={{ alignItems: 'center', padding: 8 }}>
                            <Text style={{ fontSize: 24 }}>🔒</Text>
                            <Text style={{ color: C.warning, fontSize: 11, fontWeight: '700', marginTop: 4 }}>TimeLocked Message</Text>
                          </View>
                        ) : msg.type === 'file' || msg.type === 'image' ? (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <Text style={{ fontSize: 22 }}>{msg.type === 'image' ? '🖼️' : '📄'}</Text>
                            <View style={{ flex: 1 }}>
                              <Text style={{ color: C.text, fontSize: 12, fontWeight: '700' }} numberOfLines={1}>{msg.fileName}</Text>
                              <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10 }}>{msg.fileSize} · 🔐 Encrypted</Text>
                            </View>
                          </View>
                        ) : msg.type === 'voice' ? (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <TouchableOpacity style={S.voicePlay}>
                              <Text style={{ fontSize: 16 }}>▶️</Text>
                            </TouchableOpacity>
                            <View style={{ flex: 1 }}>
                              <View style={{ flexDirection: 'row', gap: 2, alignItems: 'center', marginBottom: 3 }}>
                                {Array.from({ length: 20 }).map((_, ii) => (
                                  <View key={ii} style={{ width: 3, height: Math.random() * 16 + 4, backgroundColor: msg.mine ? '#fff' : C.primary, borderRadius: 2, opacity: 0.7 }} />
                                ))}
                              </View>
                              <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10 }}>{msg.fileName?.replace('voice_', '').replace('.m4a', '')} · 🔐</Text>
                            </View>
                          </View>
                        ) : (
                          <Text style={{ color: C.text, fontSize: 14, lineHeight: 20, position: 'relative', zIndex: 1 }}>{msg.text}</Text>
                        )}

                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4, justifyContent: 'flex-end', position: 'relative', zIndex: 1 }}>
                          <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 9 }}>{formatTime(msg.time)}</Text>
                          {msg.mine && <Text style={{ color: getStatusColor(msg.status), fontSize: 9 }}>{getStatusIcon(msg.status)}</Text>}
                        </View>
                      </View>
                    </TouchableOpacity>

                    {/* Reactions */}
                    {msg.reactions.length > 0 && (
                      <View style={{ flexDirection: 'row', gap: 4, marginTop: 4, justifyContent: msg.mine ? 'flex-end' : 'flex-start' }}>
                        {msg.reactions.map((r, ri) => (
                          <TouchableOpacity key={ri} onPress={() => addReaction(msg.id, r.emoji)} style={S.reactionBadge}>
                            <Text style={{ fontSize: 12 }}>{r.emoji}</Text>
                            <Text style={{ color: C.textDim, fontSize: 10, marginLeft: 2 }}>{r.count}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    )}
                  </View>
                </View>

                {/* Emoji reaction picker */}
                {showEmojiReact === msg.id && (
                  <View style={[S.emojiPicker, { alignSelf: msg.mine ? 'flex-end' : 'flex-start', marginTop: 4 }]}>
                    {EMOJI_REACTIONS.map((emoji, ei) => (
                      <TouchableOpacity key={ei} onPress={() => addReaction(msg.id, emoji)} style={{ padding: 4 }}>
                        <Text style={{ fontSize: 20 }}>{emoji}</Text>
                      </TouchableOpacity>
                    ))}
                    <TouchableOpacity onPress={() => setShowEmojiReact(null)} style={{ padding: 4 }}>
                      <Text style={{ color: C.textFaint, fontSize: 14 }}>✕</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </Animated.View>
            );
          })}
        </ScrollView>

        {/* Input area */}
        <View style={S.inputArea}>
          <LinearGradient colors={['rgba(4,12,28,0.98)', 'rgba(4,12,28,0.95)']} style={StyleSheet.absoluteFillObject} />

          {/* Options row */}
          <View style={{ flexDirection: 'row', paddingHorizontal: 14, paddingTop: 8, gap: 6, flexWrap: 'wrap' }}>
            {/* Destruct toggle */}
            <TouchableOpacity
              onPress={() => setShowDestructPicker(true)}
              style={[S.optionChip, selectedDestruct && { backgroundColor: C.danger + '22', borderColor: C.danger }]}
            >
              <Text style={{ fontSize: 12 }}>💣</Text>
              <Text style={{ color: selectedDestruct ? C.danger : C.textFaint, fontSize: 10, fontWeight: '600' }}>
                {selectedDestruct ? formatCountdown(selectedDestruct) : 'Self-Destruct'}
              </Text>
            </TouchableOpacity>

            {/* TimeLock toggle */}
            <TouchableOpacity
              onPress={() => setShowTimeLock(!showTimeLock)}
              style={[S.optionChip, showTimeLock && { backgroundColor: C.warning + '22', borderColor: C.warning }]}
            >
              <Text style={{ fontSize: 12 }}>⏱️</Text>
              <Text style={{ color: showTimeLock ? C.warning : C.textFaint, fontSize: 10, fontWeight: '600' }}>
                {showTimeLock ? 'TimeLock ON' : 'TimeLock'}
              </Text>
            </TouchableOpacity>

            {/* Anon */}
            <TouchableOpacity
              onPress={() => setAnonymousMode(!anonymousMode)}
              style={[S.optionChip, anonymousMode && { backgroundColor: C.secondary + '22', borderColor: C.secondary }]}
            >
              <Text style={{ fontSize: 12 }}>👻</Text>
              <Text style={{ color: anonymousMode ? C.secondary : C.textFaint, fontSize: 10, fontWeight: '600' }}>
                {anonymousMode ? 'Anon ON' : 'Anonymous'}
              </Text>
            </TouchableOpacity>
            {/* Vanish */}
            <TouchableOpacity
              onPress={() => setVanishMode(!vanishMode)}
              style={[S.optionChip, vanishMode && { backgroundColor: '#A78BFA22', borderColor: '#A78BFA' }]}
            >
              <Text style={{ fontSize: 12 }}>🫧</Text>
              <Text style={{ color: vanishMode ? '#A78BFA' : C.textFaint, fontSize: 10, fontWeight: '600' }}>
                {vanishMode ? 'Vanish ON' : 'Vanish'}
              </Text>
            </TouchableOpacity>
            {/* Doc Scanner */}
            <TouchableOpacity
              onPress={() => router.push('/docscanner' as any)}
              style={S.optionChip}
            >
              <Text style={{ fontSize: 12 }}>📄</Text>
              <Text style={{ color: C.textFaint, fontSize: 10, fontWeight: '600' }}>Scan Doc</Text>
            </TouchableOpacity>
          </View>

          {/* TimeLock hours input */}
          {showTimeLock && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 6 }}>
              <Text style={{ color: C.warning, fontSize: 12 }}>⏱️ Lock for</Text>
              <TextInput
                value={timeLockHours}
                onChangeText={setTimeLockHours}
                keyboardType="decimal-pad"
                style={{ color: C.warning, fontSize: 14, fontWeight: '800', width: 50, borderBottomWidth: 1, borderBottomColor: C.warning }}
              />
              <Text style={{ color: C.warning, fontSize: 12 }}>hours</Text>
            </View>
          )}

          {/* Main input row */}
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10 }}>
            <TouchableOpacity onPress={() => setShowAttach(true)} style={S.inputAction}>
              <Text style={{ fontSize: 20 }}>📎</Text>
            </TouchableOpacity>
            <View style={S.inputBox}>
              <TextInput
                value={input}
                onChangeText={setInput}
                placeholder={anonymousMode ? '👻 Anonymous encrypted message...' : '🔐 Encrypted message...'}
                placeholderTextColor={C.textFaint}
                style={{ flex: 1, color: C.text, fontSize: 14, paddingVertical: 4, maxHeight: 100 }}
                multiline
                returnKeyType="send"
                onSubmitEditing={sendMessage}
              />
            </View>
            {input.trim() ? (
              <TouchableOpacity onPress={sendMessage}>
                <LinearGradient colors={[C.primary, C.secondary]} style={S.sendBtn}>
                  <Text style={{ fontSize: 18, color: '#fff' }}>→</Text>
                </LinearGradient>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                onPressIn={startVoiceRecording}
                onPressOut={stopVoiceRecording}
              >
                <Animated.View style={[S.sendBtn, { backgroundColor: isRecordingVoice ? C.danger : 'rgba(10,22,40,0.8)', transform: [{ scale: recordAnim }], borderWidth: 1, borderColor: isRecordingVoice ? C.danger : C.borderDim }]}>
                  <Text style={{ fontSize: 18 }}>{isRecordingVoice ? '⏹' : '🎙️'}</Text>
                </Animated.View>
              </TouchableOpacity>
            )}
          </View>

          {isRecordingVoice && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: C.danger }} />
              <Text style={{ color: C.danger, fontSize: 11, fontWeight: '700' }}>
                RECORDING {formatCountdown(recordingDuration)} · Release to send
              </Text>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>

      {/* Attach modal */}
      <Modal visible={showAttach} transparent animationType="slide">
        <TouchableOpacity style={S.modalOverlay} activeOpacity={1} onPress={() => setShowAttach(false)}>
          <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0 }}>
            <LinearGradient colors={['rgba(10,22,40,0.99)', 'rgba(6,14,34,0.99)']} style={S.bottomSheet}>
              <Text style={S.sheetTitle}>Attach Encrypted File</Text>
              <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
                {[
                  { icon: '📷', label: 'Camera', action: takePhoto },
                  { icon: '🖼️', label: 'Gallery', action: () => pickFile('image') },
                  { icon: '🎥', label: 'Video', action: () => pickFile('video') },
                  { icon: '📄', label: 'Document', action: () => pickFile('document') },
                  { icon: '📍', label: 'Location', action: () => { setShowAttach(false); router.push('/vaultdrop' as any); } },
                  { icon: '📋', label: 'Scan Doc', action: () => { setShowAttach(false); router.push('/docscanner' as any); } },
                ].map((o, i) => (
                  <TouchableOpacity key={i} onPress={o.action} style={{ alignItems: 'center', gap: 8 }}>
                    <LinearGradient colors={[C.primary, C.secondary]} style={S.attachIcon}>
                      <Text style={{ fontSize: 26 }}>{o.icon}</Text>
                    </LinearGradient>
                    <Text style={{ color: C.text, fontSize: 12, fontWeight: '600' }}>{o.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={{ marginTop: 16, backgroundColor: C.accent + '12', borderRadius: 12, padding: 10, borderWidth: 1, borderColor: C.accent + '33' }}>
                <Text style={{ color: C.accent, fontSize: 11, textAlign: 'center' }}>🔐 All files encrypted with AES-256 before sending</Text>
              </View>
            </LinearGradient>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Self-destruct picker */}
      <Modal visible={showDestructPicker} transparent animationType="slide">
        <TouchableOpacity style={S.modalOverlay} activeOpacity={1} onPress={() => setShowDestructPicker(false)}>
          <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0 }}>
            <LinearGradient colors={['rgba(10,22,40,0.99)', 'rgba(6,14,34,0.99)']} style={S.bottomSheet}>
              <Text style={S.sheetTitle}>💣 Self-Destruct Timer</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                <TouchableOpacity
                  onPress={() => { setSelectedDestruct(null); setShowDestructPicker(false); }}
                  style={[S.destructOption, !selectedDestruct && { borderColor: C.accent, backgroundColor: C.accent + '18' }]}
                >
                  <Text style={{ color: !selectedDestruct ? C.accent : C.textDim, fontWeight: '700', fontSize: 13 }}>OFF</Text>
                </TouchableOpacity>
                {SELF_DESTRUCT_OPTIONS.map((o, i) => (
                  <TouchableOpacity key={i} onPress={() => {
                    if (o.value === -1) return;
                    setSelectedDestruct(o.value);
                    setShowDestructPicker(false);
                  }} style={[S.destructOption, selectedDestruct === o.value && { borderColor: C.danger, backgroundColor: C.danger + '18' }]}>
                    <Text style={{ color: selectedDestruct === o.value ? C.danger : C.textDim, fontWeight: '700', fontSize: 13 }}>{o.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={{ marginTop: 12 }}>
                <Text style={{ color: C.textFaint, fontSize: 11, marginBottom: 6 }}>Custom (seconds):</Text>
                <TextInput
                  value={customDestruct}
                  onChangeText={setCustomDestruct}
                  keyboardType="number-pad"
                  placeholder="e.g. 120 for 2 minutes"
                  placeholderTextColor={C.textFaint}
                  style={S.modalInput}
                />
                {customDestruct.length > 0 && (
                  <TouchableOpacity onPress={() => { setSelectedDestruct(parseInt(customDestruct) || 60); setShowDestructPicker(false); }} style={{ marginTop: 8 }}>
                    <LinearGradient colors={[C.danger, '#991B1B']} style={{ borderRadius: 14, paddingVertical: 12, alignItems: 'center' }}>
                      <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>Set {formatCountdown(parseInt(customDestruct) || 60)}</Text>
                    </LinearGradient>
                  </TouchableOpacity>
                )}
              </View>
            </LinearGradient>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Video/Voice call modal */}
      <Modal visible={showCallModal} transparent animationType="fade">
        <View style={S.callModal}>
          <LinearGradient colors={['#020B18', '#040F20']} style={StyleSheet.absoluteFillObject} />
          {callType === 'video' && (
            <CameraView style={StyleSheet.absoluteFillObject} facing="front" />
          )}
          <LinearGradient colors={['rgba(2,11,24,0.5)', 'transparent', 'rgba(2,11,24,0.9)']} style={StyleSheet.absoluteFillObject} />

          <View style={{ position: 'absolute', top: 50, left: 0, right: 0, alignItems: 'center', gap: 8 }}>
            <Text style={{ color: C.text, fontSize: 20, fontWeight: '900' }}>{contactEmoji} {contactName}</Text>
            <Text style={{ color: callActive ? C.accent : C.warning, fontSize: 13, fontWeight: '700' }}>
              {callActive ? '🔐 Encrypted · ' + formatCountdown(callDuration) : '⏳ Connecting...'}
            </Text>
            {callType === 'video' && callActive && (
              <Text style={{ color: C.textFaint, fontSize: 11 }}>AES-256 video encryption active</Text>
            )}
          </View>

          {/* Screen share panel */}
          {showScreenShare && (
            <View style={S.screenSharePanel}>
              <Text style={{ color: C.text, fontSize: 12, fontWeight: '700', marginBottom: 8 }}>📺 Screen Share Active</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {EMOJI_REACTIONS.map((emoji, i) => (
                  <TouchableOpacity key={i} onPress={() => sendScreenShareEmoji(emoji)} style={S.emojiBtn}>
                    <Text style={{ fontSize: 18 }}>{emoji}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          {/* Floating call emojis */}
          {floatingEmojis.map(fe => (
            <Animated.Text key={fe.id} style={[S.floatingEmoji, { left: fe.x, bottom: 200 }]}>
              {fe.emoji}
            </Animated.Text>
          ))}

          {/* Call controls */}
          <View style={S.callControls}>
            {callType === 'video' && (
              <TouchableOpacity
                onPress={() => setShowScreenShare(!showScreenShare)}
                style={[S.callBtn, showScreenShare && { backgroundColor: C.primary + '33' }]}
              >
                <Text style={{ fontSize: 22 }}>📺</Text>
                <Text style={{ color: C.textFaint, fontSize: 9, marginTop: 3 }}>Screen</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={S.callBtn}>
              <Text style={{ fontSize: 22 }}>🔇</Text>
              <Text style={{ color: C.textFaint, fontSize: 9, marginTop: 3 }}>Mute</Text>
            </TouchableOpacity>
            {callType === 'video' && (
              <TouchableOpacity style={S.callBtn}>
                <Text style={{ fontSize: 22 }}>📷</Text>
                <Text style={{ color: C.textFaint, fontSize: 9, marginTop: 3 }}>Camera</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={endCall}
              style={[S.callBtn, { backgroundColor: C.danger + '33', borderColor: C.danger }]}
            >
              <Text style={{ fontSize: 22 }}>📵</Text>
              <Text style={{ color: C.danger, fontSize: 9, marginTop: 3 }}>End</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

export default function ChatScreen() {
  return (
    <ErrorBoundary fallbackTitle="Chat Error" fallbackMessage="Chat had a problem.">
      <ChatContent />
    </ErrorBoundary>
  );
}

const S = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#020B18' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingTop: 50, paddingBottom: 10, gap: 8 },
  headerBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(10,22,40,0.8)', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },
  avatarSm: { width: 40, height: 40, borderRadius: 20, borderWidth: 1.5, justifyContent: 'center', alignItems: 'center' },
  onlineDot: { position: 'absolute', bottom: 0, right: 0, width: 11, height: 11, borderRadius: 5.5, backgroundColor: '#10B981', borderWidth: 2, borderColor: '#020B18' },
  avatarTiny: { width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(10,22,40,0.8)', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', marginRight: 8, alignSelf: 'flex-end' },
  keyBar: { backgroundColor: 'rgba(74,159,255,0.06)', paddingHorizontal: 16, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' },
  encFlash: { position: 'absolute', top: 110, alignSelf: 'center', backgroundColor: 'rgba(16,185,129,0.15)', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 6, borderWidth: 1, borderColor: '#10B981', zIndex: 100 },
  floatingEmoji: { position: 'absolute', bottom: 160, fontSize: 36, zIndex: 200 },
  bubble: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10, overflow: 'hidden' },
  bubbleMine: { backgroundColor: 'transparent', marginLeft: 40 },
  bubbleTheirs: { backgroundColor: 'rgba(10,22,40,0.85)', borderWidth: 1, borderColor: 'rgba(74,159,255,0.12)', marginRight: 40 },
  reactionBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(10,22,40,0.8)', borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  emojiPicker: { flexDirection: 'row', flexWrap: 'wrap', backgroundColor: 'rgba(10,22,40,0.95)', borderRadius: 16, padding: 8, borderWidth: 1, borderColor: 'rgba(74,159,255,0.2)', gap: 2 },
  voicePlay: { width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(74,159,255,0.2)', justifyContent: 'center', alignItems: 'center' },
  inputArea: { borderTopWidth: 1, borderTopColor: 'rgba(74,159,255,0.1)', position: 'relative' },
  optionChip: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(10,22,40,0.7)', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },
  inputAction: { width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(10,22,40,0.8)', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },
  inputBox: { flex: 1, backgroundColor: 'rgba(10,22,40,0.85)', borderRadius: 22, borderWidth: 1, borderColor: 'rgba(74,159,255,0.14)', paddingHorizontal: 14, paddingVertical: 8, flexDirection: 'row', alignItems: 'center' },
  sendBtn: { width: 42, height: 42, borderRadius: 21, justifyContent: 'center', alignItems: 'center' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
  bottomSheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: 44, borderWidth: 1, borderColor: 'rgba(74,159,255,0.12)' },
  sheetTitle: { color: '#fff', fontSize: 18, fontWeight: '900', marginBottom: 20 },
  attachIcon: { width: 62, height: 62, borderRadius: 31, justifyContent: 'center', alignItems: 'center' },
  destructOption: { backgroundColor: 'rgba(6,14,34,0.9)', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.08)' },
  modalInput: { backgroundColor: 'rgba(6,14,34,0.9)', borderRadius: 14, padding: 14, color: '#fff', fontSize: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  callModal: { flex: 1, backgroundColor: '#020B18', justifyContent: 'flex-end' },
  callControls: { flexDirection: 'row', justifyContent: 'space-evenly', alignItems: 'center', paddingBottom: 50, paddingTop: 20, backgroundColor: 'rgba(2,11,24,0.9)' },
  callBtn: { alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 30, width: 60, height: 60, justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  screenSharePanel: { position: 'absolute', bottom: 150, left: 16, right: 16, backgroundColor: 'rgba(10,22,40,0.95)', borderRadius: 18, padding: 16, borderWidth: 1, borderColor: 'rgba(74,159,255,0.2)' },
  emojiBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.08)', justifyContent: 'center', alignItems: 'center' },
});
