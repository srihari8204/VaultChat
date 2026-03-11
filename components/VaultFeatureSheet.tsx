import React from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal,
  Pressable, ScrollView
} from 'react-native';
import { useRouter } from 'expo-router';

interface Props {
  visible: boolean;
  onClose: () => void;
  chatId?: string;
}

const OPTIONS = [
  {
    id:    'vaultdrop',
    icon:  '📦',
    color: '#4A9FFF',
    title: 'VaultDrop',
    desc:  'Send files securely · Link+Code or Direct Email',
    badge: 'FILES',
    tags:  ['🔗 Link+Code', '📨 Direct Email', '🗑️ Auto-delete', '🔒 AES-256'],
    route: '/vaultdrop',
  },
  {
    id:    'location',
    icon:  '📍',
    color: '#00D4AA',
    title: 'Location Sharing',
    desc:  'Current snapshot, live tracking, or until you stop',
    badge: 'LIVE',
    tags:  ['🎯 Current', '📡 Live', '♾️ Until I Stop', '⏱️ Auto-expire'],
    route: '/location-sharing',
  },
  {
    id:    'sync',
    icon:  '🔒',
    color: '#A78BFA',
    title: 'Sync Contact',
    desc:  'Mutual consent contact saving with 6-digit code',
    badge: 'MUTUAL',
    tags:  ['🤝 Mutual consent', '🔢 6-digit code', '⏱️ 5 min expiry', '🔒 Private'],
    route: '/sync-contact',
  },
];

export default function VaultFeatureSheet({ visible, onClose, chatId }: Props) {
  const router = useRouter();

  const open = (route: string) => {
    onClose();
    const full = chatId ? `${route}?chatId=${chatId}` : route;
    router.push(full as any);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable style={s.backdrop} onPress={onClose} />

      <View style={s.sheet}>
        <View style={s.handle} />

        <View style={s.header}>
          <View style={s.headerIcon}>
            <Text style={{ fontSize: 18 }}>🔗</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.headerTitle}>Vault Features</Text>
            <Text style={s.headerSub}>VaultDrop · Location · Sync Contact</Text>
          </View>
          <TouchableOpacity style={s.closeBtn} onPress={onClose}>
            <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 16 }}>✕</Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 4, paddingBottom: 40 }}>
          {OPTIONS.map(opt => (
            <TouchableOpacity
              key={opt.id}
              style={[s.optCard, { borderColor: `${opt.color}33` }]}
              onPress={() => open(opt.route)}
              activeOpacity={0.75}
            >
              <View style={[s.optIcon, { backgroundColor: `${opt.color}18`, borderColor: `${opt.color}30` }]}>
                <Text style={{ fontSize: 24 }}>{opt.icon}</Text>
              </View>

              <View style={{ flex: 1 }}>
                <View style={s.optTitleRow}>
                  <Text style={s.optTitle}>{opt.title}</Text>
                  <View style={[s.badge, { backgroundColor: `${opt.color}15`, borderColor: `${opt.color}30` }]}>
                    <Text style={[s.badgeTxt, { color: opt.color }]}>{opt.badge}</Text>
                  </View>
                </View>
                <Text style={s.optDesc}>{opt.desc}</Text>
                <View style={s.tagRow}>
                  {opt.tags.map(t => (
                    <View key={t} style={[s.tag, { backgroundColor: `${opt.color}0a`, borderColor: `${opt.color}22` }]}>
                      <Text style={[s.tagTxt, { color: `${opt.color}bb` }]}>{t}</Text>
                    </View>
                  ))}
                </View>
              </View>

              <Text style={{ color: 'rgba(255,255,255,0.2)', fontSize: 18, marginLeft: 4 }}>›</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop:    { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.65)' },
  sheet:       { position: 'absolute', bottom: 0, left: 0, right: 0,
                 backgroundColor: '#0D1B2E', borderTopLeftRadius: 24, borderTopRightRadius: 24,
                 borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', maxHeight: '78%' },
  handle:      { width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.2)',
                 alignSelf: 'center', marginTop: 10, marginBottom: 6 },
  header:      { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, paddingBottom: 14 },
  headerIcon:  { width: 34, height: 34, borderRadius: 10, backgroundColor: 'rgba(74,159,255,0.15)',
                 alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 16, fontWeight: '900', color: '#fff' },
  headerSub:   { fontSize: 9, color: 'rgba(255,255,255,0.35)', marginTop: 1 },
  closeBtn:    { width: 28, height: 28, borderRadius: 14,
                 backgroundColor: 'rgba(255,255,255,0.07)', alignItems: 'center', justifyContent: 'center' },
  optCard:     { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 14,
                 borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.03)',
                 borderWidth: 1, marginBottom: 10 },
  optIcon:     { width: 48, height: 48, borderRadius: 13, alignItems: 'center',
                 justifyContent: 'center', borderWidth: 1, flexShrink: 0 },
  optTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 3 },
  optTitle:    { fontSize: 14, fontWeight: '800', color: '#fff' },
  badge:       { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, borderWidth: 1 },
  badgeTxt:    { fontSize: 8, fontWeight: '700' },
  optDesc:     { fontSize: 11, color: 'rgba(255,255,255,0.4)', lineHeight: 16, marginBottom: 8 },
  tagRow:      { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  tag:         { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 5, borderWidth: 1 },
  tagTxt:      { fontSize: 9, fontWeight: '600' },
});
