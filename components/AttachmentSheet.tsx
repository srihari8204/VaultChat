// components/AttachmentSheet.tsx
// Bottom sheet for choosing what to attach

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Pressable, ScrollView } from 'react-native';

interface Props {
  visible: boolean;
  onClose: () => void;
  onPhoto: () => void;
  onVideo: () => void;
  onFile: () => void;
  onGif: () => void;
  onVoice: () => void;
}

const OPTS = [
  { label: 'Photo',  icon: 'ðŸ–¼ï¸',  key: 'photo'  },
  { label: 'Video',  icon: 'ðŸŽ¬',  key: 'video'  },
  { label: 'File',   icon: 'ðŸ“„',  key: 'file'   },
  { label: 'GIF',    icon: 'ðŸŽžï¸',  key: 'gif'    },
  { label: 'Voice',  icon: 'ðŸŽ¤',  key: 'voice'  },
];

export default function AttachmentSheet({ visible, onClose, onPhoto, onVideo, onFile, onGif, onVoice }: Props) {
  if (!visible) return null;
  const handlers: Record<string, () => void> = {
    photo: onPhoto, video: onVideo, file: onFile, gif: onGif, voice: onVoice,
  };
  return (
    <Pressable style={s.overlay} onPress={onClose}>
      <View style={s.sheet}>
        <View style={s.handle} />
        <Text style={s.title}>Attach</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.row}>
          {OPTS.map(o => (
            <TouchableOpacity key={o.key} style={s.btn} onPress={() => { onClose(); handlers[o.key](); }}>
              <View style={s.circle}><Text style={s.icon}>{o.icon}</Text></View>
              <Text style={s.lbl}>{o.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  sheet:   { backgroundColor: '#0E0E20', borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingBottom: 36, paddingTop: 12 },
  handle:  { width: 40, height: 4, backgroundColor: '#333', borderRadius: 2, alignSelf: 'center', marginBottom: 12 },
  title:   { color: '#888', fontSize: 13, fontWeight: '600', textAlign: 'center', marginBottom: 18 },
  row:     { paddingHorizontal: 16, gap: 16 },
  btn:     { alignItems: 'center', gap: 8 },
  circle:  { width: 60, height: 60, borderRadius: 30, backgroundColor: '#181830', alignItems: 'center', justifyContent: 'center' },
  icon:    { fontSize: 26 },
  lbl:     { color: '#C0C0E0', fontSize: 12 },
});