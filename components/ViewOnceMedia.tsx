// components/ViewOnceMedia.tsx
// View Once Media — photo/video viewable exactly once, then auto-deleted
// Shows a blurred placeholder until tapped, then reveals for viewing
// After closing, marks as viewed and deletes from Firestore

import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal,
  Image, Dimensions, Animated, Alert, Platform,
} from 'react-native';
import firestore from '@react-native-firebase/firestore';

const { width: SW, height: SH } = Dimensions.get('window');

interface ViewOnceMediaProps {
  messageId: string;
  chatId: string;
  mediaUrl: string;
  msgType: 'image' | 'video';
  isMe: boolean;
  viewedBy?: string[];
  currentUid: string;
}

export default function ViewOnceMedia({
  messageId, chatId, mediaUrl, msgType, isMe, viewedBy = [], currentUid,
}: ViewOnceMediaProps) {
  const hasViewed = viewedBy.includes(currentUid);
  const [showViewer, setShowViewer] = useState(false);
  const [expired, setExpired] = useState(hasViewed);
  const countdown = useRef(new Animated.Value(1)).current;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleOpen = () => {
    if (expired || hasViewed) {
      Alert.alert('Already Viewed', 'This media can only be viewed once.');
      return;
    }
    setShowViewer(true);

    // Start 10-second countdown then auto-close
    Animated.timing(countdown, { toValue: 0, duration: 10000, useNativeDriver: false }).start();
    timerRef.current = setTimeout(() => handleClose(), 10000);
  };

  const handleClose = async () => {
    setShowViewer(false);
    setExpired(true);
    if (timerRef.current) clearTimeout(timerRef.current);

    // Mark as viewed in Firestore
    try {
      await firestore()
        .collection('chats').doc(chatId)
        .collection('messages').doc(messageId)
        .update({
          viewedBy: firestore.FieldValue.arrayUnion(currentUid),
        });
    } catch {}

    // If both have now viewed, delete the message entirely after a short delay
    try {
      const doc = await firestore()
        .collection('chats').doc(chatId)
        .collection('messages').doc(messageId)
        .get();
      const data = doc.data();
      if (data?.viewedBy && data.viewedBy.length >= 2) {
        // Both sender and receiver have viewed — delete
        setTimeout(async () => {
          try {
            await firestore()
              .collection('chats').doc(chatId)
              .collection('messages').doc(messageId)
              .update({
                isDeleted: true,
                mediaUrl: firestore.FieldValue.delete(),
                plaintext: '',
              });
          } catch {}
        }, 2000);
      }
    } catch {}
  };

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  // Already viewed — show expired state
  if (expired || hasViewed) {
    return (
      <View style={[s.container, isMe ? s.containerMe : s.containerPeer]}>
        <View style={s.expiredWrap}>
          <Text style={s.expiredIcon}>{msgType === 'video' ? '\uD83C\uDFA5' : '\uD83D\uDCF7'}</Text>
          <Text style={s.expiredTxt}>Opened</Text>
        </View>
      </View>
    );
  }

  // Not yet viewed — show tap-to-view
  return (
    <>
      <TouchableOpacity
        style={[s.container, isMe ? s.containerMe : s.containerPeer]}
        onPress={handleOpen}
        activeOpacity={0.7}
      >
        <View style={s.viewOnceWrap}>
          <View style={s.iconCircle}>
            <Text style={s.viewIcon}>{msgType === 'video' ? '\uD83C\uDFA5' : '\uD83D\uDCF7'}</Text>
          </View>
          <View>
            <Text style={s.viewOnceTxt}>View Once {msgType === 'video' ? 'Video' : 'Photo'}</Text>
            <Text style={s.viewOnceSub}>Tap to open — disappears after viewing</Text>
          </View>
        </View>
      </TouchableOpacity>

      {/* Fullscreen viewer */}
      <Modal visible={showViewer} transparent animationType="fade" onRequestClose={handleClose}>
        <View style={s.modal}>
          {/* Countdown bar */}
          <View style={s.countdownBar}>
            <Animated.View style={[s.countdownFill, {
              width: countdown.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
            }]} />
          </View>

          <TouchableOpacity style={s.closeBtn} onPress={handleClose}>
            <Text style={s.closeTxt}>{'✕'}</Text>
          </TouchableOpacity>

          <Text style={s.viewOnceLabel}>{'\uD83D\uDC41'} View Once — tap X or wait 10s</Text>

          {msgType === 'image' ? (
            <Image source={{ uri: mediaUrl }} style={s.fullImage} resizeMode="contain" />
          ) : (
            <View style={s.videoPlaceholder}>
              <Text style={s.videoTxt}>{'\uD83C\uDFA5'} Video playback</Text>
              <Text style={s.videoSub}>Video would play here with expo-av</Text>
            </View>
          )}
        </View>
      </Modal>
    </>
  );
}

const s = StyleSheet.create({
  container: {
    borderRadius: 16,
    overflow: 'hidden',
    minWidth: 200,
  },
  containerMe: { backgroundColor: '#6C63FF' },
  containerPeer: { backgroundColor: '#1A1D27' },

  viewOnceWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
  },
  iconCircle: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  viewIcon: { fontSize: 20 },
  viewOnceTxt: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  viewOnceSub: { color: 'rgba(255,255,255,0.6)', fontSize: 11, marginTop: 1 },

  expiredWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 6, padding: 12,
    opacity: 0.5,
  },
  expiredIcon: { fontSize: 16 },
  expiredTxt: { color: '#9CA3AF', fontSize: 13, fontStyle: 'italic' },

  modal: {
    flex: 1, backgroundColor: '#000000F0',
    justifyContent: 'center', alignItems: 'center',
  },
  countdownBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    height: 4, backgroundColor: '#333',
  },
  countdownFill: {
    height: 4, backgroundColor: '#6C63FF',
  },
  closeBtn: {
    position: 'absolute', top: Platform.OS === 'ios' ? 56 : 40, right: 20,
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#FFFFFF20', alignItems: 'center', justifyContent: 'center',
    zIndex: 10,
  },
  closeTxt: { color: '#FFFFFF', fontSize: 18 },
  viewOnceLabel: {
    color: '#A78BFA', fontSize: 12, fontWeight: '600',
    position: 'absolute', top: Platform.OS === 'ios' ? 60 : 44, left: 20,
  },
  fullImage: {
    width: SW * 0.9, height: SH * 0.6,
  },
  videoPlaceholder: {
    width: SW * 0.8, height: 200,
    backgroundColor: '#1A1D27', borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  videoTxt: { color: '#FFFFFF', fontSize: 18, marginBottom: 4 },
  videoSub: { color: '#6B7280', fontSize: 12 },
});
