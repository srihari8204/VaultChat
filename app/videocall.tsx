import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Alert, Animated, Modal, StyleSheet, Text,
  TouchableOpacity, TouchableWithoutFeedback, View,
} from 'react-native';

const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '👏'];

interface FloatingEmoji {
  id: number;
  emoji: string;
  x: Animated.Value;
  y: Animated.Value;
  opacity: Animated.Value;
}

export default function VideoCallScreen() {
  const router = useRouter();
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [frontCamera, setFrontCamera] = useState(true);
  const [speaker, setSpeaker] = useState(true);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showEmojiTray, setShowEmojiTray] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [floatingEmojis, setFloatingEmojis] = useState<FloatingEmoji[]>([]);
  const emojiIdRef = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controlsOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const interval = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const resetHideTimer = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    showControls();
    hideTimer.current = setTimeout(() => hideControls(), 5000);
  };

  const showControls = () => {
    setControlsVisible(true);
    Animated.timing(controlsOpacity, { toValue: 1, duration: 250, useNativeDriver: true }).start();
  };

  const hideControls = () => {
    Animated.timing(controlsOpacity, { toValue: 0, duration: 500, useNativeDriver: true })
      .start(() => setControlsVisible(false));
  };

  useEffect(() => {
    resetHideTimer();
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, []);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  const sendEmoji = (emoji: string) => {
    const id = emojiIdRef.current++;
    const x = new Animated.Value(Math.random() * 200 + 80);
    const y = new Animated.Value(500);
    const opacity = new Animated.Value(1);
    setFloatingEmojis(prev => [...prev, { id, emoji, x, y, opacity }]);
    Animated.parallel([
      Animated.timing(y, { toValue: 100, duration: 1800, useNativeDriver: true }),
      Animated.sequence([
        Animated.delay(1200),
        Animated.timing(opacity, { toValue: 0, duration: 600, useNativeDriver: true }),
      ]),
    ]).start(() => setFloatingEmojis(prev => prev.filter(e => e.id !== id)));
    setShowEmojiTray(false);
    resetHideTimer();
  };

  const handleEndCall = () => {
    Alert.alert('End Call', 'Are you sure you want to end this call?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'End Call', style: 'destructive', onPress: () => router.back() },
    ]);
  };

  return (
    <TouchableWithoutFeedback onPress={() => resetHideTimer()}>
      <View style={s.root}>
        <View style={s.remoteFeed}>
          <View style={s.videoPlaceholder}>
            <Text style={s.avatarText}>👤</Text>
            <Text style={s.callerName}>Alex Morgan</Text>
          </View>
        </View>

        <View style={s.selfView}>
          {cameraOff
            ? <View style={s.selfViewOff}><Text style={{ fontSize: 24 }}>🚫</Text></View>
            : <View style={s.selfViewOn}><Text style={s.selfAvatar}>🧑</Text></View>}
        </View>

        {floatingEmojis.map(fe => (
          <Animated.Text key={fe.id}
            style={[s.floatingEmoji, { transform: [{ translateX: fe.x }, { translateY: fe.y }], opacity: fe.opacity }]}>
            {fe.emoji}
          </Animated.Text>
        ))}

        <Animated.View style={[s.topBar, { opacity: controlsOpacity }]}>
          <View style={s.hdBadge}><Text style={s.hdText}>HD</Text></View>
          <View style={s.timerWrap}>
            <View style={s.timerDot} />
            <Text style={s.timerText}>{formatTime(seconds)}</Text>
          </View>
          <TouchableOpacity style={s.moreBtn} onPress={() => { setShowMoreMenu(true); resetHideTimer(); }}>
            <Text style={s.moreDots}>⋮</Text>
          </TouchableOpacity>
        </Animated.View>

        <Animated.View style={[s.callerInfo, { opacity: controlsOpacity }]}>
          <Text style={s.callerInfoName}>Alex Morgan</Text>
          <Text style={s.callerInfoStatus}>🔒 VaultChat Encrypted Call</Text>
        </Animated.View>

        <Animated.View style={[s.bottomBar, { opacity: controlsOpacity }]}>
          {showEmojiTray && (
            <View style={s.emojiTray}>
              {EMOJIS.map(emoji => (
                <TouchableOpacity key={emoji} onPress={() => sendEmoji(emoji)} style={s.emojiBtn}>
                  <Text style={s.emojiText}>{emoji}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          <View style={s.controlsRow}>
            <TouchableOpacity style={[s.ctrlBtn, muted && s.ctrlActive]}
              onPress={() => { setMuted(v => !v); resetHideTimer(); }}>
              <Text style={s.ctrlIcon}>{muted ? '🔇' : '🎤'}</Text>
              <Text style={s.ctrlLabel}>{muted ? 'Unmute' : 'Mute'}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[s.ctrlBtn, cameraOff && s.ctrlActive]}
              onPress={() => { setCameraOff(v => !v); resetHideTimer(); }}>
              <Text style={s.ctrlIcon}>{cameraOff ? '📵' : '📹'}</Text>
              <Text style={s.ctrlLabel}>{cameraOff ? 'Start' : 'Camera'}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={s.endBtn} onPress={handleEndCall}>
              <Text style={s.endIcon}>📵</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[s.ctrlBtn, !frontCamera && s.ctrlActive]}
              onPress={() => { setFrontCamera(v => !v); resetHideTimer(); }}>
              <Text style={s.ctrlIcon}>🔄</Text>
              <Text style={s.ctrlLabel}>{frontCamera ? 'Flip' : 'Front'}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[s.ctrlBtn, !speaker && s.ctrlActive]}
              onPress={() => { setSpeaker(v => !v); resetHideTimer(); }}>
              <Text style={s.ctrlIcon}>{speaker ? '🔊' : '🔉'}</Text>
              <Text style={s.ctrlLabel}>{speaker ? 'Speaker' : 'Earpiece'}</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={s.emojiToggle}
            onPress={() => { setShowEmojiTray(v => !v); resetHideTimer(); }}>
            <Text style={s.emojiToggleText}>😊 Reactions</Text>
          </TouchableOpacity>
        </Animated.View>

        <Modal visible={showMoreMenu} transparent animationType="slide"
          onRequestClose={() => setShowMoreMenu(false)}>
          <TouchableWithoutFeedback onPress={() => setShowMoreMenu(false)}>
            <View style={s.modalOverlay}>
              <TouchableWithoutFeedback>
                <View style={s.menuSheet}>
                  <View style={s.menuHandle} />
                  <Text style={s.menuTitle}>More Options</Text>
                  {[
                    { icon: '💬', label: 'Send Message' },
                    { icon: '📋', label: 'Share Screen' },
                    { icon: '📸', label: 'Take Screenshot' },
                    { icon: '🔒', label: 'View Encryption Info' },
                    { icon: '👤', label: 'View Profile' },
                    { icon: '🚫', label: 'Block User' },
                  ].map(item => (
                    <TouchableOpacity key={item.label} style={s.menuItem}
                      onPress={() => setShowMoreMenu(false)}>
                      <Text style={s.menuItemIcon}>{item.icon}</Text>
                      <Text style={s.menuItemLabel}>{item.label}</Text>
                    </TouchableOpacity>
                  ))}
                  <TouchableOpacity style={s.menuCancel} onPress={() => setShowMoreMenu(false)}>
                    <Text style={s.menuCancelText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </TouchableWithoutFeedback>
            </View>
          </TouchableWithoutFeedback>
        </Modal>
      </View>
    </TouchableWithoutFeedback>
  );
}

const s = StyleSheet.create({
  root:             { flex: 1, backgroundColor: '#000' },
  remoteFeed:       { ...StyleSheet.absoluteFillObject, backgroundColor: '#0a1628' },
  videoPlaceholder: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  avatarText:       { fontSize: 80, marginBottom: 16 },
  callerName:       { color: 'rgba(255,255,255,0.3)', fontSize: 18, fontWeight: '600' },
  selfView:         { position: 'absolute', top: 100, right: 16, width: 100, height: 140,
                      borderRadius: 16, overflow: 'hidden', borderWidth: 2, borderColor: '#4A9FFF' },
  selfViewOff:      { flex: 1, backgroundColor: '#1a1a2e', justifyContent: 'center', alignItems: 'center' },
  selfViewOn:       { flex: 1, backgroundColor: '#0d2137', justifyContent: 'center', alignItems: 'center' },
  selfAvatar:       { fontSize: 40 },
  floatingEmoji:    { position: 'absolute', fontSize: 36, zIndex: 100 },
  topBar:           { position: 'absolute', top: 50, left: 0, right: 0,
                      flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20 },
  hdBadge:          { backgroundColor: '#4A9FFF', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, marginRight: 10 },
  hdText:           { color: '#fff', fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  timerWrap:        { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  timerDot:         { width: 8, height: 8, borderRadius: 4, backgroundColor: '#EF4444' },
  timerText:        { color: '#fff', fontSize: 15, fontWeight: '700', letterSpacing: 1 },
  moreBtn:          { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.15)',
                      justifyContent: 'center', alignItems: 'center' },
  moreDots:         { color: '#fff', fontSize: 22, fontWeight: '900', marginTop: -4 },
  callerInfo:       { position: 'absolute', top: 110, left: 20 },
  callerInfoName:   { color: '#fff', fontSize: 22, fontWeight: '900' },
  callerInfoStatus: { color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 4 },
  bottomBar:        { position: 'absolute', bottom: 0, left: 0, right: 0,
                      backgroundColor: 'rgba(0,0,0,0.75)', paddingBottom: 40, paddingTop: 16,
                      paddingHorizontal: 20, borderTopLeftRadius: 28, borderTopRightRadius: 28,
                      borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.1)' },
  emojiTray:        { flexDirection: 'row', justifyContent: 'center', gap: 12, marginBottom: 16,
                      backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 40,
                      paddingVertical: 10, paddingHorizontal: 16 },
  emojiBtn:         { padding: 4 },
  emojiText:        { fontSize: 28 },
  controlsRow:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  ctrlBtn:          { alignItems: 'center', gap: 6, width: 60, backgroundColor: 'rgba(255,255,255,0.1)',
                      borderRadius: 16, paddingVertical: 12 },
  ctrlActive:       { backgroundColor: 'rgba(239,68,68,0.3)', borderWidth: 1, borderColor: '#EF4444' },
  ctrlIcon:         { fontSize: 22 },
  ctrlLabel:        { color: 'rgba(255,255,255,0.7)', fontSize: 10, fontWeight: '600' },
  endBtn:           { width: 68, height: 68, borderRadius: 34, backgroundColor: '#EF4444',
                      justifyContent: 'center', alignItems: 'center', elevation: 8 },
  endIcon:          { fontSize: 28 },
  emojiToggle:      { alignSelf: 'center', backgroundColor: 'rgba(255,255,255,0.1)',
                      borderRadius: 20, paddingVertical: 8, paddingHorizontal: 20 },
  emojiToggleText:  { color: 'rgba(255,255,255,0.8)', fontSize: 14, fontWeight: '600' },
  modalOverlay:     { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  menuSheet:        { backgroundColor: '#0d1f35', borderTopLeftRadius: 28, borderTopRightRadius: 28,
                      paddingBottom: 40, paddingTop: 12, paddingHorizontal: 20 },
  menuHandle:       { width: 40, height: 4, backgroundColor: 'rgba(255,255,255,0.2)',
                      borderRadius: 2, alignSelf: 'center', marginBottom: 16 },
  menuTitle:        { color: '#fff', fontSize: 18, fontWeight: '900', marginBottom: 16 },
  menuItem:         { flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 14,
                      borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.07)' },
  menuItemIcon:     { fontSize: 22, width: 32 },
  menuItemLabel:    { color: 'rgba(255,255,255,0.85)', fontSize: 15, fontWeight: '600' },
  menuCancel:       { marginTop: 16, alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.08)',
                      borderRadius: 14, paddingVertical: 14 },
  menuCancelText:   { color: '#4A9FFF', fontSize: 15, fontWeight: '800' },
});
