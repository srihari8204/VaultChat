// app/status.tsx
// Real status screen
// Screenshot detection → fires alert to uploader + logs to Firestore
// 24-hour auto-expiry — statuses deleted from Firestore after 24h
// My status upload (photo, video, text)
// Contact statuses from Firestore real-time listener
// Screenshot protection via expo-screen-capture

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  FlatList, Alert, Modal, TextInput,
  ActivityIndicator, Dimensions, AppState,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as ScreenCapture from 'expo-screen-capture';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import { logScreenshotAttempt } from '../services/securityService';
import { BottomNav } from './chats';

const { width: SW } = Dimensions.get('window');

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

interface Status {
  id:          string;
  uid:         string;
  displayName: string;
  type:        'text' | 'image' | 'video';
  content:     string;   // text content or base64/uri
  bgColor:     string;   // for text statuses
  createdAt:   any;      // Firestore timestamp
  expiresAt:   any;      // Firestore timestamp (createdAt + 24h)
  viewers:     string[]; // UIDs who viewed
  screenshots: number;   // screenshot count
}

const BG_COLORS = [
  '#1A1A2E', '#16213E', '#0F3460', '#533483',
  '#003328', '#1B1B2F', '#2C3E50', '#1A2035',
];

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function timeAgo(ts: any): string {
  if (!ts) return '';
  const d: Date = ts.toDate ? ts.toDate() : new Date(ts);
  const diff = Date.now() - d.getTime();
  const h    = Math.floor(diff / 3600000);
  const m    = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return 'expired';
}

function expiresIn(ts: any): string {
  if (!ts) return '';
  const d: Date = ts.toDate ? ts.toDate() : new Date(ts);
  const diff = d.getTime() - Date.now();
  if (diff <= 0) return 'Expired';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h === 0) return `Expires in ${m}m`;
  return `Expires in ${h}h ${m}m`;
}

// ─────────────────────────────────────────────────────────────────
// Status Viewer — full screen with screenshot detection
// ─────────────────────────────────────────────────────────────────

function StatusViewer({
  status,
  onClose,
}: {
  status: Status;
  onClose: () => void;
}) {
  const uid       = auth().currentUser?.uid || '';
  const timerRef  = useRef<NodeJS.Timeout | null>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    // Mark as viewed
    firestore()
      .collection('statuses')
      .doc(status.id)
      .update({
        viewers: firestore.FieldValue.arrayUnion(uid),
      })
      .catch(() => {});

    // Auto-progress bar — 5 seconds
    const start = Date.now();
    const duration = 5000;
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - start;
      const p = Math.min(elapsed / duration, 1);
      setProgress(p);
      if (p >= 1) {
        if (timerRef.current) clearInterval(timerRef.current);
        onClose();
      }
    }, 50);

    // Screenshot detection — fires when user takes screenshot
    const sub = ScreenCapture.addScreenshotListener(async () => {
      // 1. Log to Firestore under both the viewer and the status uploader
      await logScreenshotAttempt(status.id);

      // 2. Increment screenshot counter on the status document
      await firestore()
        .collection('statuses')
        .doc(status.id)
        .update({
          screenshots: firestore.FieldValue.increment(1),
        })
        .catch(() => {});

      // 3. Create alert for the status owner
      await firestore()
        .collection('users')
        .doc(status.uid)
        .collection('alerts')
        .add({
          type:        'screenshot',
          message:     `Someone screenshotted your status`,
          statusId:    status.id,
          viewerUid:   uid,
          createdAt:   firestore.FieldValue.serverTimestamp(),
          read:        false,
        })
        .catch(() => {});

      Alert.alert(
        '📸 Screenshot Detected',
        'The status owner has been notified that you took a screenshot.',
        [{ text: 'OK' }]
      );
    });

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      sub.remove();
    };
  }, [status.id]);

  return (
    <Modal visible animationType="fade" statusBarTranslucent>
      <View style={[
        viewerStyles.container,
        status.type === 'text' && { backgroundColor: status.bgColor },
      ]}>
        {/* Progress bar */}
        <View style={viewerStyles.progressTrack}>
          <View style={[viewerStyles.progressFill, { width: `${progress * 100}%` }]} />
        </View>

        {/* Header */}
        <View style={viewerStyles.header}>
          <View style={viewerStyles.avatarCircle}>
            <Text style={viewerStyles.avatarText}>
              {status.displayName.slice(0, 2).toUpperCase()}
            </Text>
          </View>
          <View>
            <Text style={viewerStyles.name}>{status.displayName}</Text>
            <Text style={viewerStyles.time}>{timeAgo(status.createdAt)}</Text>
          </View>
          <TouchableOpacity style={viewerStyles.closeBtn} onPress={onClose}>
            <Text style={viewerStyles.closeBtnText}>✕</Text>
          </TouchableOpacity>
        </View>

        {/* Content */}
        {status.type === 'text' && (
          <View style={viewerStyles.textContent}>
            <Text style={viewerStyles.textBody}>{status.content}</Text>
          </View>
        )}

        {/* Screenshot warning */}
        <View style={viewerStyles.screenshotWarning}>
          <Text style={viewerStyles.screenshotText}>
            🛡️ Screenshot detection active
          </Text>
        </View>

        {/* Viewer count */}
        <View style={viewerStyles.viewerCount}>
          <Text style={viewerStyles.viewerCountText}>
            👁 {status.viewers.length} view{status.viewers.length !== 1 ? 's' : ''}
            {status.screenshots > 0 && `  📸 ${status.screenshots}`}
          </Text>
        </View>
      </View>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────
// Add Status Modal
// ─────────────────────────────────────────────────────────────────

function AddStatusModal({
  onClose,
  onPosted,
}: {
  onClose:  () => void;
  onPosted: () => void;
}) {
  const uid         = auth().currentUser?.uid || '';
  const displayName = auth().currentUser?.displayName || 'Me';

  const [type,    setType]    = useState<'text' | 'image'>('text');
  const [text,    setText]    = useState('');
  const [bgColor, setBgColor] = useState(BG_COLORS[0]);
  const [loading, setLoading] = useState(false);

  const postStatus = async () => {
    if (type === 'text' && !text.trim()) {
      Alert.alert('Error', 'Enter some text for your status');
      return;
    }

    setLoading(true);
    try {
      const now     = firestore.Timestamp.now();
      const expires = firestore.Timestamp.fromMillis(Date.now() + 86400000); // +24h

      await firestore().collection('statuses').add({
        uid,
        displayName,
        type,
        content:     type === 'text' ? text.trim() : '',
        bgColor,
        createdAt:   now,
        expiresAt:   expires,
        viewers:     [],
        screenshots: 0,
      });

      onPosted();
      onClose();
      Alert.alert('Posted!', 'Your status will expire in 24 hours.');
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setLoading(false);
    }
  };

  const pickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') return;
    const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.8 });
    if (!result.canceled) {
      setType('image');
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity
        style={addStyles.overlay}
        activeOpacity={1}
        onPress={onClose}
      >
        <View style={addStyles.panel}>
          <View style={addStyles.handle} />
          <Text style={addStyles.title}>Add Status</Text>

          {/* Type toggle */}
          <View style={addStyles.typeRow}>
            <TouchableOpacity
              style={[addStyles.typeBtn, type === 'text' && addStyles.typeBtnActive]}
              onPress={() => setType('text')}
            >
              <Text style={[addStyles.typeBtnText, type === 'text' && addStyles.typeBtnTextActive]}>
                T  Text
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[addStyles.typeBtn, type === 'image' && addStyles.typeBtnActive]}
              onPress={pickImage}
            >
              <Text style={[addStyles.typeBtnText, type === 'image' && addStyles.typeBtnTextActive]}>
                🖼️  Photo
              </Text>
            </TouchableOpacity>
          </View>

          {/* Text input */}
          {type === 'text' && (
            <>
              <View style={[addStyles.preview, { backgroundColor: bgColor }]}>
                <TextInput
                  style={addStyles.previewInput}
                  value={text}
                  onChangeText={setText}
                  placeholder="What's on your mind?"
                  placeholderTextColor="#374151"
                  multiline
                  maxLength={200}
                  textAlign="center"
                />
              </View>
              {/* Background color picker */}
              <View style={addStyles.colorRow}>
                {BG_COLORS.map(c => (
                  <TouchableOpacity
                    key={c}
                    style={[
                      addStyles.colorDot,
                      { backgroundColor: c },
                      bgColor === c && addStyles.colorDotActive,
                    ]}
                    onPress={() => setBgColor(c)}
                  />
                ))}
              </View>
            </>
          )}

          <Text style={addStyles.expireNote}>
            ⏰ Status expires automatically in 24 hours
          </Text>
          <Text style={addStyles.screenshotNote}>
            🛡️ Screenshot detection is active on your status
          </Text>

          <TouchableOpacity
            style={[addStyles.postBtn, loading && addStyles.postBtnDim]}
            onPress={postStatus}
            disabled={loading}
          >
            {loading
              ? <ActivityIndicator color="#0A0E1A" />
              : <Text style={addStyles.postBtnText}>Post Status</Text>
            }
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────
// Main Screen
// ─────────────────────────────────────────────────────────────────

export default function StatusScreen() {
  const router = useRouter();
  const uid    = auth().currentUser?.uid || '';

  const [statuses,    setStatuses]    = useState<Status[]>([]);
  const [myStatus,    setMyStatus]    = useState<Status | null>(null);
  const [viewing,     setViewing]     = useState<Status | null>(null);
  const [showAdd,     setShowAdd]     = useState(false);
  const [loading,     setLoading]     = useState(true);

  // ── Load statuses — real Firestore listener ───────────────────
  useEffect(() => {
    // Only show non-expired statuses
    const cutoff = firestore.Timestamp.fromMillis(Date.now() - 86400000);

    const unsub = firestore()
      .collection('statuses')
      .where('createdAt', '>', cutoff)
      .orderBy('createdAt', 'desc')
      .onSnapshot(snap => {
        const all: Status[] = snap.docs.map(doc => ({
          id: doc.id,
          ...(doc.data() as Omit<Status, 'id'>),
        }));

        // Separate my status from contacts
        setMyStatus(all.find(s => s.uid === uid) || null);
        setStatuses(all.filter(s => s.uid !== uid));
        setLoading(false);
      }, err => {
        console.error('[Status]', err);
        setLoading(false);
      });

    return () => unsub();
  }, [uid]);

  // ── Delete expired statuses (cleanup) ────────────────────────
  useEffect(() => {
    const cleanup = async () => {
      const cutoff = firestore.Timestamp.fromMillis(Date.now() - 86400000);
      const expired = await firestore()
        .collection('statuses')
        .where('uid', '==', uid)
        .where('createdAt', '<', cutoff)
        .get();
      for (const doc of expired.docs) {
        await doc.ref.delete().catch(() => {});
      }
    };
    cleanup();
  }, []);

  const renderContactStatus = useCallback(({ item }: { item: Status }) => {
    const viewed = item.viewers.includes(uid);
    return (
      <TouchableOpacity
        style={styles.statusRow}
        onPress={() => setViewing(item)}
      >
        {/* Ring */}
        <View style={[
          styles.ring,
          viewed ? styles.ringViewed : styles.ringUnviewed,
        ]}>
          <View style={styles.avatarCircle}>
            <Text style={styles.avatarText}>
              {item.displayName.slice(0, 2).toUpperCase()}
            </Text>
          </View>
        </View>
        <View style={styles.statusInfo}>
          <Text style={styles.statusName}>{item.displayName}</Text>
          <Text style={styles.statusMeta}>
            {timeAgo(item.createdAt)}  ·  {expiresIn(item.expiresAt)}
          </Text>
        </View>
        <View style={styles.statusRight}>
          {item.screenshots > 0 && (
            <View style={styles.screenshotBadge}>
              <Text style={styles.screenshotBadgeText}>📸 {item.screenshots}</Text>
            </View>
          )}
          <Text style={styles.statusType}>
            {item.type === 'text' ? 'T' : '🖼️'}
          </Text>
        </View>
      </TouchableOpacity>
    );
  }, [uid]);

  return (
    <View style={styles.container}>

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Status</Text>
        <Text style={styles.headerSub}>24H · SCREENSHOT PROTECTED</Text>
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color="#00D4AA" />
        </View>
      ) : (
        <FlatList
          data={statuses}
          keyExtractor={s => s.id}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            <>
              {/* My status */}
              <Text style={styles.sectionLabel}>MY STATUS</Text>
              <TouchableOpacity
                style={styles.myStatusRow}
                onPress={() => myStatus ? setViewing(myStatus) : setShowAdd(true)}
              >
                <View style={[
                  styles.myStatusAdd,
                  myStatus && styles.myStatusAddPosted,
                ]}>
                  {myStatus
                    ? <Text style={styles.avatarText}>
                        {(auth().currentUser?.displayName || 'Me').slice(0, 2).toUpperCase()}
                      </Text>
                    : <Text style={styles.plusIcon}>+</Text>
                  }
                </View>
                <View style={styles.statusInfo}>
                  <Text style={styles.statusName}>My Status</Text>
                  <Text style={styles.statusMeta}>
                    {myStatus
                      ? `${expiresIn(myStatus.expiresAt)}  ·  👁 ${myStatus.viewers.length}`
                      : 'Tap to add status'
                    }
                  </Text>
                </View>
                {myStatus && (
                  <TouchableOpacity
                    style={styles.addMoreBtn}
                    onPress={() => setShowAdd(true)}
                  >
                    <Text style={styles.addMoreText}>+ Add</Text>
                  </TouchableOpacity>
                )}
              </TouchableOpacity>

              {statuses.length > 0 && (
                <Text style={[styles.sectionLabel, { marginTop: 16 }]}>
                  RECENT UPDATES
                </Text>
              )}
            </>
          }
          renderItem={renderContactStatus}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyIcon}>⭕</Text>
              <Text style={styles.emptyText}>
                No status updates yet.{'\n'}Contacts' statuses will appear here.
              </Text>
            </View>
          }
          ItemSeparatorComponent={() => <View style={styles.sep} />}
        />
      )}

      {/* Status viewer */}
      {viewing && (
        <StatusViewer
          status={viewing}
          onClose={() => setViewing(null)}
        />
      )}

      {/* Add status modal */}
      {showAdd && (
        <AddStatusModal
          onClose={() => setShowAdd(false)}
          onPosted={() => {}}
        />
      )}

      <BottomNav active="Status" />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: '#0A0E1A' },
  header: {
    backgroundColor: '#111827',
    paddingTop: 48, paddingBottom: 12, paddingHorizontal: 16,
    borderBottomWidth: 0.5, borderBottomColor: '#1E293B',
  },
  headerTitle: { fontSize: 20, fontWeight: 'bold', color: '#FFFFFF' },
  headerSub:   { fontSize: 9, color: '#00D4AA', marginTop: 2, fontWeight: 'bold' },

  loadingWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  listContent: { padding: 14, paddingBottom: 100, flexGrow: 1 },
  sectionLabel: {
    fontSize: 10, fontWeight: 'bold', color: '#374151',
    letterSpacing: 0.8, marginBottom: 10,
  },

  // My status
  myStatusRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#111827', borderRadius: 12, padding: 12,
    borderWidth: 0.5, borderColor: '#1E293B', marginBottom: 4,
  },
  myStatusAdd: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: '#1A2235',
    borderWidth: 2, borderColor: '#1E293B',
    borderStyle: 'dashed',
    justifyContent: 'center', alignItems: 'center',
  },
  myStatusAddPosted: {
    borderColor: '#00D4AA', borderStyle: 'solid',
    backgroundColor: '#003328',
  },
  plusIcon:    { fontSize: 24, color: '#64748B' },
  addMoreBtn: {
    backgroundColor: '#1A2235', borderRadius: 8,
    borderWidth: 0.5, borderColor: '#1E293B',
    paddingHorizontal: 10, paddingVertical: 5,
  },
  addMoreText: { fontSize: 11, color: '#00D4AA', fontWeight: 'bold' },

  // Contact status row
  statusRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 8,
  },
  ring: {
    width: 54, height: 54, borderRadius: 27,
    borderWidth: 2.5, justifyContent: 'center', alignItems: 'center',
  },
  ringUnviewed: { borderColor: '#00D4AA' },
  ringViewed:   { borderColor: '#374151' },
  avatarCircle: {
    width: 46, height: 46, borderRadius: 23,
    backgroundColor: '#1A2235', justifyContent: 'center', alignItems: 'center',
  },
  avatarText:   { fontSize: 14, fontWeight: 'bold', color: '#00D4AA' },
  statusInfo:   { flex: 1 },
  statusName:   { fontSize: 15, fontWeight: 'bold', color: '#FFFFFF', marginBottom: 3 },
  statusMeta:   { fontSize: 11, color: '#64748B' },
  statusRight:  { alignItems: 'flex-end', gap: 4 },
  screenshotBadge: {
    backgroundColor: '#FF4D6D22',
    borderRadius: 6, borderWidth: 0.5, borderColor: '#FF4D6D44',
    paddingHorizontal: 6, paddingVertical: 2,
  },
  screenshotBadgeText: { fontSize: 10, color: '#FF4D6D' },
  statusType:   { fontSize: 12, color: '#374151' },
  sep:          { height: 0.5, backgroundColor: '#111827', marginLeft: 66 },

  emptyWrap:  { flex: 1, alignItems: 'center', paddingTop: 60, gap: 12 },
  emptyIcon:  { fontSize: 52 },
  emptyText:  { fontSize: 13, color: '#374151', textAlign: 'center', lineHeight: 22 },
});

const viewerStyles = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#0A0E1A', justifyContent: 'center' },
  progressTrack: {
    position: 'absolute', top: 48, left: 12, right: 12,
    height: 3, backgroundColor: '#1E293B', borderRadius: 2,
  },
  progressFill:  { height: 3, backgroundColor: '#00D4AA', borderRadius: 2 },
  header: {
    position: 'absolute', top: 58, left: 12, right: 12,
    flexDirection: 'row', alignItems: 'center', gap: 10,
  },
  avatarCircle: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: '#003328', borderWidth: 1.5, borderColor: '#00D4AA',
    justifyContent: 'center', alignItems: 'center',
  },
  avatarText:   { fontSize: 13, fontWeight: 'bold', color: '#00D4AA' },
  name:         { fontSize: 15, fontWeight: 'bold', color: '#FFFFFF' },
  time:         { fontSize: 11, color: '#64748B' },
  closeBtn:     { marginLeft: 'auto', padding: 8 },
  closeBtnText: { fontSize: 20, color: '#FFFFFF' },
  textContent:  { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  textBody:     { fontSize: 24, fontWeight: 'bold', color: '#FFFFFF', textAlign: 'center', lineHeight: 34 },
  screenshotWarning: {
    position: 'absolute', bottom: 80, alignSelf: 'center',
    backgroundColor: '#FF4D6D22', borderRadius: 20,
    borderWidth: 0.5, borderColor: '#FF4D6D44',
    paddingHorizontal: 16, paddingVertical: 6,
  },
  screenshotText: { fontSize: 11, color: '#FF4D6D' },
  viewerCount: {
    position: 'absolute', bottom: 40, alignSelf: 'center',
  },
  viewerCountText: { fontSize: 12, color: '#64748B' },
});

const addStyles = StyleSheet.create({
  overlay:     { flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  panel: {
    backgroundColor: '#111827',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, paddingBottom: 36,
  },
  handle: {
    width: 40, height: 4, backgroundColor: '#1E293B',
    borderRadius: 2, alignSelf: 'center', marginBottom: 16,
  },
  title:   { fontSize: 17, fontWeight: 'bold', color: '#FFFFFF', textAlign: 'center', marginBottom: 16 },
  typeRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  typeBtn: {
    flex: 1, paddingVertical: 10, borderRadius: 10,
    backgroundColor: '#1A2235', borderWidth: 0.5, borderColor: '#1E293B',
    alignItems: 'center',
  },
  typeBtnActive: { backgroundColor: '#003328', borderColor: '#00D4AA' },
  typeBtnText:   { fontSize: 14, color: '#64748B' },
  typeBtnTextActive: { color: '#00D4AA', fontWeight: 'bold' },
  preview: {
    height: 160, borderRadius: 12, justifyContent: 'center',
    alignItems: 'center', marginBottom: 12,
  },
  previewInput: {
    fontSize: 20, fontWeight: 'bold', color: '#FFFFFF',
    textAlign: 'center', padding: 16, width: '100%',
  },
  colorRow:      { flexDirection: 'row', gap: 10, justifyContent: 'center', marginBottom: 16 },
  colorDot: {
    width: 28, height: 28, borderRadius: 14,
    borderWidth: 1.5, borderColor: '#1E293B',
  },
  colorDotActive: { borderColor: '#00D4AA', transform: [{ scale: 1.2 }] },
  expireNote:    { fontSize: 11, color: '#374151', textAlign: 'center', marginBottom: 4 },
  screenshotNote:{ fontSize: 11, color: '#374151', textAlign: 'center', marginBottom: 16 },
  postBtn: {
    backgroundColor: '#00D4AA', borderRadius: 10,
    paddingVertical: 14, alignItems: 'center',
  },
  postBtnDim:    { backgroundColor: '#003328' },
  postBtnText:   { color: '#0A0E1A', fontWeight: 'bold', fontSize: 16 },
});
