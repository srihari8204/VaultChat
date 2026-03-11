import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
    Animated,
    StyleSheet,
    Text,
    TouchableOpacity,
    View
} from 'react-native';

export default function VoiceCallScreen() {
  const router = useRouter();
  const { name, avatar } = useLocalSearchParams();
  const [callStatus, setCallStatus] = useState<'calling' | 'connected' | 'ended'>('calling');
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeaker, setIsSpeaker] = useState(false);
  const [duration, setDuration] = useState(0);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const timerRef = useRef<any>(null);

  useEffect(() => {
    // Pulse animation
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.2, duration: 800, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
      ])
    );
    pulse.start();

    // Auto connect after 2 seconds
    setTimeout(() => {
      setCallStatus('connected');
      timerRef.current = setInterval(() => setDuration(d => d + 1), 1000);
    }, 2000);

    return () => {
      pulse.stop();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const endCall = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setCallStatus('ended');
    setTimeout(() => router.back(), 1000);
  };

  return (
    <View style={styles.container}>

      {/* DeepFake Shield Banner */}
      <View style={styles.deepfakeBanner}>
        <Text style={styles.deepfakeText}>
          🎭 DeepFake Shield: ACTIVE — Real person verified ✅
        </Text>
      </View>

      {/* Encryption badge */}
      <View style={styles.encryptBadge}>
        <Text style={styles.encryptText}>🔒 VoiceCloak ON  ·  E2E Encrypted</Text>
      </View>

      {/* Avatar */}
      <View style={styles.avatarArea}>
        <Animated.View style={[
          styles.pulseRing,
          { transform: [{ scale: pulseAnim }],
            opacity: callStatus === 'connected' ? 0.3 : 0.6 }
        ]} />
        <View style={styles.avatar}>
          <Text style={styles.avatarEmoji}>{avatar || '👤'}</Text>
        </View>
      </View>

      {/* Name & Status */}
      <Text style={styles.callerName}>{name || 'Unknown'}</Text>
      <Text style={[
        styles.callStatus,
        callStatus === 'connected' && { color: '#22C55E' },
        callStatus === 'ended' && { color: '#EF4444' },
      ]}>
        {callStatus === 'calling' ? '📞 Calling...' :
         callStatus === 'ended' ? 'Call ended' :
         `🔒 Encrypted · ${formatDuration(duration)}`}
      </Text>

      {/* Voice wave (when connected) */}
      {callStatus === 'connected' && (
        <View style={styles.waveRow}>
          {[1,2,3,4,5,6,7].map(i => (
            <View key={i} style={[
              styles.wavebar,
              { height: isMuted ? 4 : [20,35,25,40,20,30,15][i-1] }
            ]} />
          ))}
        </View>
      )}

      {/* Controls */}
      <View style={styles.controls}>
        <View style={styles.controlsRow}>
          {[
            { icon: isMuted ? '🔇' : '🎤', label: isMuted ? 'Unmute' : 'Mute',
              active: isMuted, onPress: () => setIsMuted(!isMuted) },
            { icon: isSpeaker ? '🔊' : '🔈', label: 'Speaker',
              active: isSpeaker, onPress: () => setIsSpeaker(!isSpeaker) },
            { icon: '🎥', label: 'Video',
              active: false, onPress: () => router.replace({ pathname: '/videocall' as any, params: { name, avatar } }) },
            { icon: '⌨️', label: 'Keypad', active: false, onPress: () => {} },
          ].map((btn, i) => (
            <TouchableOpacity
              key={i}
              style={[styles.controlBtn, btn.active && styles.controlBtnActive]}
              onPress={btn.onPress}
            >
              <Text style={styles.controlIcon}>{btn.icon}</Text>
              <Text style={styles.controlLabel}>{btn.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* End Call */}
        <TouchableOpacity style={styles.endCallBtn} onPress={endCall}>
          <Text style={styles.endCallIcon}>📵</Text>
        </TouchableOpacity>
      </View>

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050D1F',
    alignItems: 'center',
    paddingTop: 60,
  },
  deepfakeBanner: {
    backgroundColor: '#052e16',
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 20,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#166534',
  },
  deepfakeText: { color: '#4ade80', fontSize: 12, fontWeight: '600' },
  encryptBadge: {
    backgroundColor: '#0F1729',
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: 20,
    marginBottom: 48,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  encryptText: { color: '#475569', fontSize: 12 },
  avatarArea: {
    width: 160,
    height: 160,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  pulseRing: {
    position: 'absolute',
    width: 160,
    height: 160,
    borderRadius: 80,
    borderWidth: 2,
    borderColor: '#1D4ED8',
  },
  avatar: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: '#0F1729',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 3,
    borderColor: '#1D4ED8',
  },
  avatarEmoji: { fontSize: 60 },
  callerName: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  callStatus: {
    color: '#94A3B8',
    fontSize: 16,
    marginBottom: 32,
  },
  waveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: 40,
    height: 48,
  },
  wavebar: {
    width: 4,
    backgroundColor: '#1D4ED8',
    borderRadius: 2,
  },
  controls: {
    position: 'absolute',
    bottom: 60,
    width: '100%',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  controlsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    width: '100%',
    marginBottom: 32,
  },
  controlBtn: {
    alignItems: 'center',
    backgroundColor: '#0F1729',
    borderRadius: 16,
    padding: 16,
    minWidth: 72,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  controlBtnActive: {
    backgroundColor: '#1D4ED8',
    borderColor: '#3B82F6',
  },
  controlIcon: { fontSize: 28, marginBottom: 6 },
  controlLabel: { color: '#94A3B8', fontSize: 11 },
  endCallBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#EF4444',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 8,
    shadowColor: '#EF4444',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
  },
  endCallIcon: { fontSize: 32 },
});