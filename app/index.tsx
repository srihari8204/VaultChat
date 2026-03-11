import { ErrorBoundary } from '../components/ErrorBoundary';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, Easing, FlatList, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

function HomeContent() {
  const router = useRouter();
  const fadeIn = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const rotateAnim = useRef(new Animated.Value(0)).current;
  const [securityScore] = useState(98);

  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 800, useNativeDriver: true }).start();
    Animated.loop(Animated.sequence([
      Animated.timing(pulseAnim, { toValue: 1.05, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(pulseAnim, { toValue: 1.00, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ])).start();
    Animated.loop(Animated.timing(rotateAnim, { toValue: 1, duration: 10000, easing: Easing.linear, useNativeDriver: true })).start();
  }, []);

  const features = [
    { icon: '💬', label: 'Chats', route: '/chats', color: ['#1D4ED8','#3B82F6'] },
    { icon: '🧬', label: 'VaultID', route: '/vaultid', color: ['#7C3AED','#A78BFA'] },
    { icon: '🎭', label: 'DeepFake', route: '/deepfake', color: ['#059669','#10B981'] },
    { icon: '💀', label: 'MemoryShield', route: '/memoryshield', color: ['#DC2626','#EF4444'] },
    { icon: '🤖', label: 'AI Guard', route: '/behavioral', color: ['#D97706','#F59E0B'] },
    { icon: '👥', label: 'SafeFamily', route: '/safefamily', color: ['#0891B2','#06B6D4'] },
    { icon: '🌐', label: 'Dark Web', route: '/darkweb', color: ['#7C3AED','#EC4899'] },
    { icon: '⚙️', label: 'Settings', route: '/settings', color: ['#374151','#6B7280'] },
    { icon: '🛡️', label: 'Dashboard', route: '/dashboard', color: ['#1D4ED8','#4A9FFF'] },
  ];

  const rotateStr = rotateAnim.interpolate({ inputRange: [0,1], outputRange: ['0deg','360deg'] });

  return (
    <LinearGradient colors={['#020B18','#040F20','#060F24']} style={{ flex: 1 }}>
      <Animated.View style={{ flex: 1, opacity: fadeIn }}>
        <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
          <View style={{ alignItems: 'center', paddingTop: 60, paddingBottom: 30, paddingHorizontal: 24 }}>
            <Animated.View style={{ transform: [{ scale: pulseAnim }], marginBottom: 20 }}>
              <LinearGradient colors={['#0D1E3A','#0A1628']} style={{ width: 120, height: 120, borderRadius: 60, justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: '#1D4ED8' }}>
                <Animated.View style={{ position: 'absolute', width: 140, height: 140, borderRadius: 70, borderWidth: 1, borderColor: 'rgba(29,78,216,0.3)', borderStyle: 'dashed', transform: [{ rotate: rotateStr }] }} />
                <Text style={{ fontSize: 52 }}>🛡️</Text>
              </LinearGradient>
            </Animated.View>
            <Text style={{ color: '#fff', fontSize: 28, fontWeight: '900', letterSpacing: 1, marginBottom: 4 }}>VaultChat</Text>
            <Text style={{ color: '#3D5A7A', fontSize: 12, letterSpacing: 2, marginBottom: 20 }}>WORLD'S MOST SECURE MESSENGER</Text>
            <View style={{ backgroundColor: '#052E16', borderRadius: 20, paddingHorizontal: 20, paddingVertical: 10, borderWidth: 1, borderColor: '#166534', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#10B981' }} />
              <Text style={{ color: '#10B981', fontSize: 13, fontWeight: '800' }}>Security Score: {securityScore}/100</Text>
            </View>
          </View>

          <TouchableOpacity onPress={() => router.push('/chats' as any)} style={{ marginHorizontal: 18, marginBottom: 20 }}>
            <LinearGradient colors={['#1D4ED8','#7C3AED']} style={{ borderRadius: 20, padding: 20, flexDirection: 'row', alignItems: 'center', gap: 16 }}>
              <Text style={{ fontSize: 40 }}>💬</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#fff', fontSize: 20, fontWeight: '900' }}>Open Chats</Text>
                <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, marginTop: 2 }}>End-to-end encrypted messaging</Text>
              </View>
              <Text style={{ color: '#fff', fontSize: 24 }}>→</Text>
            </LinearGradient>
          </TouchableOpacity>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 14, gap: 10 }}>
            {features.slice(1).map((f, i) => (
              <TouchableOpacity key={i} onPress={() => router.push(f.route as any)} style={{ width: (Dimensions.get('window').width - 48) / 2 - 5 }}>
                <LinearGradient colors={['#0A1628','#0D1E3A']} style={{ borderRadius: 18, padding: 18, borderWidth: 1, borderColor: '#0D1E3A', alignItems: 'flex-start', gap: 8 }}>
                  <LinearGradient colors={f.color as [string,string]} style={{ width: 44, height: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center' }}>
                    <Text style={{ fontSize: 22 }}>{f.icon}</Text>
                  </LinearGradient>
                  <Text style={{ color: '#fff', fontSize: 14, fontWeight: '800' }}>{f.label}</Text>
                </LinearGradient>
              </TouchableOpacity>
            ))}
          </View>

          <View style={{ marginHorizontal: 18, marginTop: 20, backgroundColor: '#0A1628', borderRadius: 18, padding: 16, borderWidth: 1, borderColor: '#0D1E3A' }}>
            <Text style={{ color: '#fff', fontSize: 14, fontWeight: '800', marginBottom: 12 }}>🌍 World-First Features</Text>
            {[
              { icon: '🧬', text: 'Blockchain VaultID — No phone number needed' },
              { icon: '🎭', text: 'DeepFake Detection — Real-time AI analysis' },
              { icon: '💀', text: 'MemoryShield — Nuclear data destruction' },
              { icon: '🤖', text: 'AI Behavioral Security — Keystroke dynamics' },
            ].map((item, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, borderBottomWidth: i < 3 ? 1 : 0, borderBottomColor: '#0D1E3A' }}>
                <Text style={{ fontSize: 18 }}>{item.icon}</Text>
                <Text style={{ color: '#3D5A7A', fontSize: 12, flex: 1 }}>{item.text}</Text>
              </View>
            ))}
          </View>
        </ScrollView>
      </Animated.View>
    </LinearGradient>
  );
}

export default function HomeScreen() {
  return (
    <ErrorBoundary fallbackTitle="Home failed to load" fallbackMessage="The home screen ran into a problem. Try restarting the app.">
      <HomeContent />
    </ErrorBoundary>
  );
}
