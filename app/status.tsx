import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Animated, Easing, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { ErrorBoundary } from '../components/ErrorBoundary';

const C = {
  bg: '#020B18', primary: '#4A9FFF', secondary: '#7C3AED',
  accent: '#10B981', danger: '#EF4444', warning: '#F59E0B',
  border: 'rgba(74,159,255,0.15)', borderDim: 'rgba(255,255,255,0.06)',
  text: '#FFFFFF', textDim: 'rgba(255,255,255,0.5)', textFaint: 'rgba(255,255,255,0.22)',
};

const NAV = [
  { id: 'chats', icon: '💬', label: 'Chats', route: '/chats' },
  { id: 'shield', icon: '🛡️', label: 'Shield', route: '/dashboard' },
  { id: 'community', icon: '🌐', label: 'Groups', route: '/communities' },
  { id: 'status', icon: '✨', label: 'Status', route: '/status' },
  { id: 'profile', icon: '👤', label: 'Profile', route: '/profile' },
];

interface Status {
  id: string;
  userName: string;
  userEmoji: string;
  userColor: string;
  items: StatusItem[];
  viewedAll: boolean;
  isOwn?: boolean;
}

interface StatusItem {
  id: string;
  type: 'text' | 'image' | 'video';
  content: string;
  bg: string;
  timestamp: number;
  expiresAt: number;
  views: number;
  isEncrypted: boolean;
}

const DEMO_STATUSES: Status[] = [
  {
    id: '1', userName: 'Alice Chen', userEmoji: '👩', userColor: '#4A9FFF', viewedAll: false,
    items: [
      { id: '1a', type: 'text', content: 'Privacy is a human right. 🔐', bg: '#1D4ED8', timestamp: Date.now() - 3600000, expiresAt: Date.now() + 82800000, views: 12, isEncrypted: true },
      { id: '1b', type: 'text', content: 'VaultChat keeps everything safe ✅', bg: '#7C3AED', timestamp: Date.now() - 1800000, expiresAt: Date.now() + 84600000, views: 8, isEncrypted: true },
    ],
  },
  {
    id: '2', userName: 'Bob Martinez', userEmoji: '👨', userColor: '#7C3AED', viewedAll: false,
    items: [
      { id: '2a', type: 'text', content: 'Encrypted call with the team 📹', bg: '#059669', timestamp: Date.now() - 7200000, expiresAt: Date.now() + 79200000, views: 23, isEncrypted: true },
    ],
  },
  {
    id: '3', userName: 'Sarah Kim', userEmoji: '👧', userColor: '#10B981', viewedAll: true,
    items: [
      { id: '3a', type: 'text', content: '🛡️ 100% secure today too', bg: '#1D4ED8', timestamp: Date.now() - 14400000, expiresAt: Date.now() + 72000000, views: 45, isEncrypted: false },
    ],
  },
  {
    id: '4', userName: 'CryptoVault 🌐', userEmoji: '🌐', userColor: '#F59E0B', viewedAll: false,
    items: [
      { id: '4a', type: 'text', content: 'New privacy law — join the discussion', bg: '#92400E', timestamp: Date.now() - 3000000, expiresAt: Date.now() + 83400000, views: 156, isEncrypted: true },
    ],
  },
];

function fmtAgo(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function StatusViewer({ status, onClose }: { status: Status; onClose: () => void }) {
  const [currentIdx, setCurrentIdx] = useState(0);
  const progressAnim = useRef(new Animated.Value(0)).current;
  const item = status.items[currentIdx];

  useEffect(() => {
    progressAnim.setValue(0);
    Animated.timing(progressAnim, { toValue: 1, duration: 5000, useNativeDriver: false }).start(() => {
      if (currentIdx < status.items.length - 1) {
        setCurrentIdx(i => i + 1);
      } else {
        onClose();
      }
    });
    return () => progressAnim.stopAnimation();
  }, [currentIdx]);

  const progressWidth = progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <View style={{ flex: 1 }}>
      <LinearGradient colors={[item.bg, item.bg + 'CC', '#020B18']} style={StyleSheet.absoluteFillObject} />
      {/* Progress bars */}
      <View style={{ flexDirection: 'row', gap: 4, paddingHorizontal: 12, paddingTop: 52 }}>
        {status.items.map((_, i) => (
          <View key={i} style={{ flex: 1, height: 3, backgroundColor: 'rgba(255,255,255,0.25)', borderRadius: 2, overflow: 'hidden' }}>
            {i < currentIdx && <View style={{ width: '100%', height: 3, backgroundColor: '#fff' }} />}
            {i === currentIdx && <Animated.View style={{ width: progressWidth, height: 3, backgroundColor: '#fff' }} />}
          </View>
        ))}
      </View>
      {/* User info */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 12 }}>
        <Text style={{ fontSize: 32 }}>{status.userEmoji}</Text>
        <View style={{ flex: 1 }}>
          <Text style={{ color: '#fff', fontSize: 14, fontWeight: '800' }}>{status.userName}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11 }}>{fmtAgo(item.timestamp)}</Text>
            {item.isEncrypted && <Text style={{ color: '#10B981', fontSize: 10 }}>🔐 Encrypted</Text>}
          </View>
        </View>
        <TouchableOpacity onPress={onClose} style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' }}>
          <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700' }}>✕</Text>
        </TouchableOpacity>
      </View>
      {/* Content */}
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 }}>
        <Text style={{ color: '#fff', fontSize: 28, fontWeight: '900', textAlign: 'center', lineHeight: 38 }}>{item.content}</Text>
      </View>
      {/* Footer */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 50, gap: 12 }}>
        <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>👁️ {item.views} views</Text>
        <View style={{ flex: 1 }} />
        {currentIdx > 0 && (
          <TouchableOpacity onPress={() => setCurrentIdx(i => i - 1)} style={{ padding: 8 }}>
            <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 24 }}>‹</Text>
          </TouchableOpacity>
        )}
        {currentIdx < status.items.length - 1 && (
          <TouchableOpacity onPress={() => setCurrentIdx(i => i + 1)} style={{ padding: 8 }}>
            <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 24 }}>›</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

function StatusContent() {
  const router = useRouter();
  const [statuses, setStatuses] = useState<Status[]>(DEMO_STATUSES);
  const [viewingStatus, setViewingStatus] = useState<Status | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newText, setNewText] = useState('');
  const [selectedBg, setSelectedBg] = useState('#1D4ED8');
  const [permission, requestPermission] = useCameraPermissions();
  const [showCamera, setShowCamera] = useState(false);
  const [activeNav] = useState('status');
  const fadeIn = useRef(new Animated.Value(0)).current;
  const ringAnim = useRef(new Animated.Value(0)).current;

  const BG_OPTIONS = ['#1D4ED8', '#7C3AED', '#059669', '#DC2626', '#D97706', '#0891B2', '#BE185D', '#374151'];

  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 500, useNativeDriver: true }).start();
    Animated.loop(Animated.timing(ringAnim, { toValue: 1, duration: 3000, easing: Easing.linear, useNativeDriver: false })).start();
  }, []);

  const myStatus: Status = {
    id: 'mine', userName: 'My Status', userEmoji: '🦊', userColor: C.primary, viewedAll: false, isOwn: true,
    items: statuses[0]?.isOwn ? statuses[0].items : [],
  };

  const postStatus = () => {
    if (!newText.trim()) return;
    const newItem: StatusItem = {
      id: Date.now().toString(),
      type: 'text',
      content: newText.trim(),
      bg: selectedBg,
      timestamp: Date.now(),
      expiresAt: Date.now() + 86400000,
      views: 0,
      isEncrypted: true,
    };
    setStatuses(prev => {
      const ownIdx = prev.findIndex(s => s.isOwn);
      if (ownIdx >= 0) {
        const updated = [...prev];
        updated[ownIdx] = { ...updated[ownIdx], items: [...updated[ownIdx].items, newItem] };
        return updated;
      }
      return [{ id: 'mine', userName: 'My Status', userEmoji: '🦊', userColor: C.primary, viewedAll: false, isOwn: true, items: [newItem] }, ...prev];
    });
    setShowCreateModal(false);
    setNewText('');
  };

  const viewStatus = (status: Status) => {
    setViewingStatus(status);
    setStatuses(prev => prev.map(s => s.id === status.id ? { ...s, viewedAll: true } : s));
  };

  const ringColor = ringAnim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [C.primary, C.secondary, C.primary] });

  const handleNav = (item: typeof NAV[0]) => {
    if (item.id !== 'status') router.push(item.route as any);
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <LinearGradient colors={['#020B18', '#040F20', '#060F24']} style={StyleSheet.absoluteFillObject} />

      <Animated.View style={{ flex: 1, opacity: fadeIn }}>
        <View style={{ paddingHorizontal: 18, paddingTop: 50, paddingBottom: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <TouchableOpacity onPress={() => router.back()} style={S.iconBtn}>
            <Text style={{ color: C.primary, fontSize: 18 }}>←</Text>
          </TouchableOpacity>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={{ color: C.text, fontSize: 20, fontWeight: '900' }}>✨ Status</Text>
            <Text style={{ color: C.textFaint, fontSize: 9, letterSpacing: 2 }}>ENCRYPTED · DISAPPEARS IN 24H</Text>
          </View>
          <TouchableOpacity onPress={() => setShowCreateModal(true)} style={{ backgroundColor: '#1D4ED8', borderRadius: 20, width: 40, height: 40, justifyContent: 'center', alignItems: 'center' }}>
            <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900' }}>+</Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={{ paddingBottom: 110 }} showsVerticalScrollIndicator={false}>
          {/* My status */}
          <View style={{ paddingHorizontal: 18, marginBottom: 8 }}>
            <Text style={{ color: C.textFaint, fontSize: 9, fontWeight: '800', letterSpacing: 2, marginBottom: 12 }}>MY STATUS</Text>
            <TouchableOpacity onPress={() => setShowCreateModal(true)} style={S.myStatusRow}>
              <View style={S.addStatusBtn}>
                <Text style={{ fontSize: 30 }}>🦊</Text>
                <View style={{ position: 'absolute', bottom: -2, right: -2, width: 22, height: 22, borderRadius: 11, backgroundColor: C.primary, justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: '#020B18' }}>
                  <Text style={{ color: '#fff', fontSize: 14, fontWeight: '900', lineHeight: 16 }}>+</Text>
                </View>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: C.text, fontSize: 14, fontWeight: '700' }}>Add to my status</Text>
                <Text style={{ color: C.textFaint, fontSize: 11, marginTop: 2 }}>Text, photo or video · Encrypted · 24h</Text>
              </View>
            </TouchableOpacity>
          </View>

          {/* Recent updates */}
          <View style={{ paddingHorizontal: 18 }}>
            <Text style={{ color: C.textFaint, fontSize: 9, fontWeight: '800', letterSpacing: 2, marginBottom: 12 }}>RECENT UPDATES</Text>
            {statuses.map((status, i) => (
              <TouchableOpacity key={status.id} onPress={() => viewStatus(status)} style={S.statusRow}>
                <View style={{ position: 'relative', marginRight: 12 }}>
                  <Animated.View style={[S.statusRing, { borderColor: status.viewedAll ? 'rgba(255,255,255,0.15)' : status.userColor }]}>
                    <View style={[S.statusAvatar, { backgroundColor: status.userColor + '22' }]}>
                      <Text style={{ fontSize: 26 }}>{status.userEmoji}</Text>
                    </View>
                  </Animated.View>
                  {status.items.some(item => item.isEncrypted) && (
                    <View style={S.encBadge}><Text style={{ fontSize: 8 }}>🔐</Text></View>
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: C.text, fontSize: 14, fontWeight: status.viewedAll ? '500' : '800' }}>{status.userName}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3 }}>
                    <Text style={{ color: C.textFaint, fontSize: 11 }}>{fmtAgo(status.items[status.items.length - 1].timestamp)}</Text>
                    <Text style={{ color: C.textFaint, fontSize: 10 }}>·</Text>
                    <Text style={{ color: C.textFaint, fontSize: 11 }}>{status.items.length} {status.items.length === 1 ? 'update' : 'updates'}</Text>
                  </View>
                </View>
                <View style={{ alignItems: 'flex-end', gap: 6 }}>
                  {!status.viewedAll && <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: status.userColor }} />}
                  <Text style={{ color: C.textFaint, fontSize: 11 }}>›</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>

          {/* Privacy note */}
          <View style={{ marginHorizontal: 18, marginTop: 20, backgroundColor: 'rgba(16,185,129,0.08)', borderRadius: 14, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: 'rgba(16,185,129,0.2)' }}>
            <Text style={{ fontSize: 20 }}>🔐</Text>
            <Text style={{ color: C.textDim, fontSize: 12, flex: 1, lineHeight: 18 }}>Status updates are end-to-end encrypted and automatically deleted after 24 hours. Only your contacts can see them.</Text>
          </View>
        </ScrollView>
      </Animated.View>

      {/* Status viewer modal */}
      <Modal visible={!!viewingStatus} transparent animationType="fade" statusBarTranslucent>
        <View style={{ flex: 1 }}>
          {viewingStatus && <StatusViewer status={viewingStatus} onClose={() => setViewingStatus(null)} />}
        </View>
      </Modal>

      {/* Create status modal */}
      <Modal visible={showCreateModal} transparent animationType="slide">
        <TouchableOpacity style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' }} activeOpacity={1} onPress={() => setShowCreateModal(false)}>
          <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0 }}>
            <LinearGradient colors={['rgba(10,22,40,0.99)', 'rgba(6,14,34,0.99)']} style={{ borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: 44, borderWidth: 1, borderColor: C.border }}>
              <Text style={{ color: C.text, fontSize: 18, fontWeight: '900', marginBottom: 16 }}>Create Status</Text>
              {/* Preview */}
              <View style={{ height: 120, borderRadius: 16, marginBottom: 16, justifyContent: 'center', alignItems: 'center', backgroundColor: selectedBg, overflow: 'hidden' }}>
                <Text style={{ color: '#fff', fontSize: 18, fontWeight: '800', textAlign: 'center', paddingHorizontal: 20 }}>{newText || 'Type something...'}</Text>
              </View>
              {/* Input */}
              <TextInput value={newText} onChangeText={setNewText} placeholder="What's on your mind?" placeholderTextColor={C.textFaint} style={{ backgroundColor: 'rgba(6,14,34,0.9)', borderRadius: 14, padding: 14, color: C.text, fontSize: 14, borderWidth: 1, borderColor: C.borderDim, marginBottom: 14 }} multiline maxLength={200} />
              {/* BG picker */}
              <Text style={{ color: C.textFaint, fontSize: 10, fontWeight: '700', letterSpacing: 1, marginBottom: 10 }}>BACKGROUND COLOR</Text>
              <View style={{ flexDirection: 'row', gap: 10, marginBottom: 20 }}>
                {BG_OPTIONS.map(bg => (
                  <TouchableOpacity key={bg} onPress={() => setSelectedBg(bg)} style={[{ width: 32, height: 32, borderRadius: 16, backgroundColor: bg }, selectedBg === bg && { borderWidth: 3, borderColor: '#fff' }]} />
                ))}
              </View>
              {/* Actions */}
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <TouchableOpacity onPress={() => { Alert.alert('Camera', 'Photo/video status coming soon.'); }} style={{ width: 50, height: 50, borderRadius: 25, backgroundColor: 'rgba(74,159,255,0.12)', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: C.border }}>
                  <Text style={{ fontSize: 22 }}>📷</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={postStatus} style={{ flex: 1 }}>
                  <LinearGradient colors={[C.primary, C.secondary]} style={{ borderRadius: 16, paddingVertical: 14, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }}>
                    <Text style={{ color: '#fff', fontWeight: '900', fontSize: 15 }}>Post Status 🔐</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>
              <Text style={{ color: C.textFaint, fontSize: 10, textAlign: 'center', marginTop: 10 }}>Encrypted · Disappears in 24 hours</Text>
            </LinearGradient>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Nav bar */}
      <View style={S.navBar}>
        {NAV.map(item => (
          <TouchableOpacity key={item.id} onPress={() => handleNav(item)} style={[S.navItem, activeNav === item.id && S.navItemActive]}>
            <Text style={{ fontSize: 20, lineHeight: 22 }}>{item.icon}</Text>
            <Text style={[S.navLabel, { color: activeNav === item.id ? C.primary : C.textFaint }]}>{item.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

export default function StatusScreen() {
  return (
    <ErrorBoundary fallbackTitle="Status Error" fallbackMessage="Status had a problem.">
      <StatusContent />
    </ErrorBoundary>
  );
}

const S = StyleSheet.create({
  iconBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(10,22,40,0.8)', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)' },
  myStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', backgroundColor: 'rgba(10,22,40,0.6)' },
  addStatusBtn: { width: 54, height: 54, borderRadius: 27, borderWidth: 2, borderColor: 'rgba(74,159,255,0.3)', borderStyle: 'dashed', justifyContent: 'center', alignItems: 'center', position: 'relative' },
  statusRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.04)' },
  statusRing: { width: 58, height: 58, borderRadius: 29, borderWidth: 2.5, padding: 3 },
  statusAvatar: { flex: 1, borderRadius: 25, justifyContent: 'center', alignItems: 'center' },
  encBadge: { position: 'absolute', bottom: 0, right: 0, width: 18, height: 18, borderRadius: 9, backgroundColor: 'rgba(2,11,24,0.9)', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  navBar: { position: 'absolute', bottom: 18, left: 14, right: 14, backgroundColor: 'rgba(4,12,28,0.92)', borderRadius: 28, borderWidth: 1, borderColor: 'rgba(74,159,255,0.12)', paddingVertical: 10, paddingHorizontal: 6, flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center' },
  navItem: { alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: 'transparent' },
  navItemActive: { backgroundColor: 'rgba(74,159,255,0.12)', borderColor: 'rgba(74,159,255,0.25)' },
  navLabel: { fontSize: 9, letterSpacing: 0.5, fontWeight: '600' },
});
