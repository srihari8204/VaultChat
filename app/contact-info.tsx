// @ts-nocheck
// app/contact-info.tsx — Contact Info Page
// Detailed contact profile with shared media, files, links,
// groups in common, encryption info, block/report.

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  StatusBar, ScrollView, Dimensions, Alert,
} from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import firestore from '@react-native-firebase/firestore';

const { width: SW } = Dimensions.get('window');
const C = { bg: '#020B18', accent: '#4A9FFF', cyan: '#00E5FF', card: '#0A1628', border: '#112240' };
const MEDIA_SIZE = (SW - 48 - 8) / 3;

// Mock shared media placeholders
const MOCK_MEDIA = Array.from({ length: 9 }, (_, i) => ({
  id: `media_${i}`,
  colors: [
    ['#1a2a4a', '#0a1a3a'],
    ['#2a1a3a', '#1a0a2a'],
    ['#0a2a2a', '#001a1a'],
    ['#2a2a1a', '#1a1a0a'],
    ['#1a0a2a', '#2a1a4a'],
    ['#0a1a1a', '#1a2a2a'],
    ['#2a0a1a', '#1a0a0a'],
    ['#1a1a2a', '#0a0a1a'],
    ['#0a2a1a', '#1a3a2a'],
  ][i],
}));

const MOCK_FILES = [
  { id: 'f1', name: 'Project_Proposal.pdf', size: '2.4 MB', icon: 'document-text-outline' },
  { id: 'f2', name: 'Budget_2026.xlsx', size: '1.1 MB', icon: 'grid-outline' },
  { id: 'f3', name: 'Presentation.pptx', size: '5.8 MB', icon: 'easel-outline' },
];

const MOCK_LINKS = [
  { id: 'l1', title: 'Meeting Notes', url: 'https://docs.google.com/doc/...' },
  { id: 'l2', title: 'Design Mockups', url: 'https://figma.com/file/...' },
];

const MOCK_GROUPS = [
  { id: 'g1', name: 'Team Alpha', members: 8 },
  { id: 'g2', name: 'Weekend Plans', members: 5 },
];

export default function ContactInfoScreen() {
  const router = useRouter();
  const { peerUid, peerName, chatId } = useLocalSearchParams<{
    peerUid: string;
    peerName: string;
    chatId: string;
  }>();

  const [muted, setMuted] = useState(false);
  const [peerData, setPeerData] = useState<any>(null);
  const [isOnline, setIsOnline] = useState(false);

  // Fetch peer profile data
  useEffect(() => {
    if (!peerUid) return;
    const unsub = firestore()
      .collection('users')
      .doc(peerUid)
      .onSnapshot(snap => {
        if (snap.exists) {
          const data = snap.data();
          setPeerData(data);
          setIsOnline(data?.online === true);
        }
      });
    return () => unsub();
  }, [peerUid]);

  const getInitials = (name: string) => {
    return (name || '?')
      .split(' ')
      .map(w => w[0])
      .join('')
      .toUpperCase()
      .substring(0, 2);
  };

  const handleBlock = () => {
    Alert.alert(
      `Block ${peerName}?`,
      'Blocked contacts cannot send you messages or call you.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: () => Alert.alert('Blocked', `${peerName} has been blocked.`),
        },
      ],
    );
  };

  const handleReport = () => {
    Alert.alert(
      `Report ${peerName}?`,
      'Report this contact for spam, abuse, or other violations.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Report',
          style: 'destructive',
          onPress: () => Alert.alert('Reported', 'Thank you. We will review this report.'),
        },
      ],
    );
  };

  const ActionButton = ({ icon, label, onPress, color = '#fff' }: any) => (
    <TouchableOpacity style={s.actionBtn} activeOpacity={0.7} onPress={onPress}>
      <View style={s.actionIcon}>
        <Ionicons name={icon} size={22} color={color} />
      </View>
      <Text style={[s.actionLabel, { color }]}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <Stack.Screen options={{ headerShown: false }} />

      <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>
        {/* Hero section */}
        <LinearGradient
          colors={['#0D2137', '#0A1628', C.bg]}
          style={s.hero}
        >
          <TouchableOpacity
            onPress={() => router.back()}
            style={s.backBtn}
          >
            <Ionicons name="arrow-back" size={24} color="#fff" />
          </TouchableOpacity>

          {/* Avatar */}
          <LinearGradient
            colors={[C.accent, C.cyan]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={s.avatarGradient}
          >
            <View style={s.avatarInner}>
              <Text style={s.avatarText}>{getInitials(peerName || '')}</Text>
            </View>
          </LinearGradient>

          {/* Online indicator */}
          {isOnline && <View style={s.onlineDot} />}

          <Text style={s.heroName}>{peerName || 'Contact'}</Text>
          <Text style={s.heroStatus}>
            {isOnline ? 'Online' : 'Last seen recently'}
          </Text>
          {peerData?.phone && (
            <Text style={s.heroPhone}>{peerData.phone}</Text>
          )}
        </LinearGradient>

        {/* Action buttons row */}
        <View style={s.actionsRow}>
          <ActionButton
            icon="call-outline"
            label="Audio"
            color={C.accent}
            onPress={() => router.push({ pathname: '/voicecall', params: { peerUid, peerName } })}
          />
          <ActionButton
            icon="videocam-outline"
            label="Video"
            color={C.accent}
            onPress={() => router.push({ pathname: '/videocall', params: { peerUid, peerName } })}
          />
          <ActionButton
            icon="search-outline"
            label="Search"
            color={C.accent}
            onPress={() => router.push({ pathname: '/in-chat-search', params: { chatId } })}
          />
          <ActionButton
            icon={muted ? 'notifications-off-outline' : 'notifications-outline'}
            label={muted ? 'Unmute' : 'Mute'}
            color={muted ? '#F44' : C.accent}
            onPress={() => setMuted(!muted)}
          />
        </View>

        {/* About section */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>About</Text>
          <View style={s.infoCard}>
            <Text style={s.bioText}>
              {peerData?.bio || peerData?.about || 'Hey there! I am using VaultChat.'}
            </Text>
          </View>
        </View>

        {/* Shared Media */}
        <View style={s.section}>
          <View style={s.sectionHeader}>
            <Text style={s.sectionTitle}>Shared Media</Text>
            <TouchableOpacity
              onPress={() => router.push({ pathname: '/media-gallery', params: { chatId } })}
            >
              <Text style={s.seeAll}>See All</Text>
            </TouchableOpacity>
          </View>
          <View style={s.mediaGrid}>
            {MOCK_MEDIA.map(m => (
              <LinearGradient
                key={m.id}
                colors={m.colors}
                style={s.mediaTile}
              >
                <Ionicons name="image-outline" size={24} color="#334" />
              </LinearGradient>
            ))}
          </View>
        </View>

        {/* Shared Files */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Shared Files</Text>
          {MOCK_FILES.map(f => (
            <View key={f.id} style={s.fileRow}>
              <View style={s.fileIcon}>
                <Ionicons name={f.icon as any} size={20} color={C.accent} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.fileName}>{f.name}</Text>
                <Text style={s.fileSize}>{f.size}</Text>
              </View>
              <Ionicons name="download-outline" size={18} color="#556" />
            </View>
          ))}
        </View>

        {/* Shared Links */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Shared Links</Text>
          {MOCK_LINKS.map(l => (
            <View key={l.id} style={s.linkRow}>
              <View style={s.linkIcon}>
                <Ionicons name="link-outline" size={18} color={C.cyan} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.linkTitle}>{l.title}</Text>
                <Text style={s.linkUrl} numberOfLines={1}>{l.url}</Text>
              </View>
              <Ionicons name="open-outline" size={16} color="#556" />
            </View>
          ))}
        </View>

        {/* Groups in Common */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Groups in Common</Text>
          {MOCK_GROUPS.map(g => (
            <View key={g.id} style={s.groupRow}>
              <LinearGradient
                colors={['#1a2a3a', '#0d1d2d']}
                style={s.groupAvatar}
              >
                <Ionicons name="people" size={18} color={C.accent} />
              </LinearGradient>
              <View style={{ flex: 1 }}>
                <Text style={s.groupName}>{g.name}</Text>
                <Text style={s.groupMembers}>{g.members} members</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color="#334" />
            </View>
          ))}
        </View>

        {/* Encryption Info */}
        <View style={s.section}>
          <View style={s.encryptionCard}>
            <MaterialCommunityIcons name="shield-lock-outline" size={22} color="#00C853" />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={s.encTitle}>End-to-End Encrypted</Text>
              <Text style={s.encSubtitle}>
                Messages are end-to-end encrypted. No one outside of this chat, not even VaultChat, can read or listen to them.
              </Text>
            </View>
          </View>
        </View>

        {/* Block & Report */}
        <View style={[s.section, { marginBottom: 20 }]}>
          <TouchableOpacity style={s.dangerBtn} activeOpacity={0.7} onPress={handleBlock}>
            <Ionicons name="ban-outline" size={20} color="#F44336" />
            <Text style={s.dangerText}>Block {peerName}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.dangerBtn, { marginTop: 8 }]}
            activeOpacity={0.7}
            onPress={handleReport}
          >
            <Ionicons name="flag-outline" size={20} color="#F44336" />
            <Text style={s.dangerText}>Report {peerName}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  hero: {
    alignItems: 'center',
    paddingTop: 54,
    paddingBottom: 24,
  },
  backBtn: {
    position: 'absolute',
    top: 54,
    left: 16,
    zIndex: 10,
  },
  avatarGradient: {
    width: 100,
    height: 100,
    borderRadius: 50,
    padding: 3,
    marginTop: 12,
  },
  avatarInner: {
    flex: 1,
    borderRadius: 48,
    backgroundColor: '#0A1628',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    color: '#fff',
    fontSize: 32,
    fontWeight: '700',
  },
  onlineDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#00C853',
    borderWidth: 3,
    borderColor: C.bg,
    position: 'absolute',
    top: 142,
    right: SW / 2 - 48,
  },
  heroName: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '700',
    marginTop: 14,
  },
  heroStatus: {
    color: '#00C853',
    fontSize: 14,
    marginTop: 4,
  },
  heroPhone: {
    color: '#8899AA',
    fontSize: 14,
    marginTop: 4,
  },
  actionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderColor: C.border,
  },
  actionBtn: {
    alignItems: 'center',
    gap: 6,
  },
  actionIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionLabel: {
    fontSize: 12,
    fontWeight: '500',
  },
  section: {
    paddingHorizontal: 16,
    marginTop: 20,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sectionTitle: {
    color: '#8899AA',
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  seeAll: {
    color: C.accent,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 12,
  },
  infoCard: {
    backgroundColor: C.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
  },
  bioText: {
    color: '#CCD',
    fontSize: 14,
    lineHeight: 20,
  },
  mediaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  mediaTile: {
    width: MEDIA_SIZE,
    height: MEDIA_SIZE,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    padding: 12,
    marginBottom: 6,
  },
  fileIcon: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: C.accent + '15',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  fileName: {
    color: '#DEE',
    fontSize: 14,
    fontWeight: '500',
  },
  fileSize: {
    color: '#556',
    fontSize: 12,
    marginTop: 2,
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    padding: 12,
    marginBottom: 6,
  },
  linkIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: C.cyan + '15',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  linkTitle: {
    color: '#DEE',
    fontSize: 14,
    fontWeight: '500',
  },
  linkUrl: {
    color: C.accent,
    fontSize: 12,
    marginTop: 2,
  },
  groupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    padding: 12,
    marginBottom: 6,
  },
  groupAvatar: {
    width: 40,
    height: 40,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  groupName: {
    color: '#DEE',
    fontSize: 14,
    fontWeight: '500',
  },
  groupMembers: {
    color: '#556',
    fontSize: 12,
    marginTop: 2,
  },
  encryptionCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#00C85308',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#00C85322',
    padding: 14,
  },
  encTitle: {
    color: '#00C853',
    fontSize: 14,
    fontWeight: '600',
  },
  encSubtitle: {
    color: '#667',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 4,
  },
  dangerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F4433608',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#F4433622',
    padding: 14,
    gap: 10,
  },
  dangerText: {
    color: '#F44336',
    fontSize: 15,
    fontWeight: '600',
  },
});
