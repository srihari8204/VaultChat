// app/alerts.tsx
// Real security alerts from Firestore
// Types: screenshot / breach / jailbreak / login / system
// Real-time listener — badge updates instantly
// Tap to mark read, long-press to delete
// Filter: All / Unread / Security / System

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  FlatList, Alert, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import { BottomNav } from './chats';

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

type AlertType   = 'screenshot' | 'breach' | 'jailbreak' | 'login' | 'system' | 'frida' | 'root';
type AlertFilter = 'All' | 'Unread' | 'Security' | 'System';

interface SecurityAlert {
  id:        string;
  type:      AlertType;
  message:   string;
  detail:    string;
  createdAt: any;
  read:      boolean;
  severity:  'high' | 'medium' | 'low';
}

const FILTERS: AlertFilter[] = ['All', 'Unread', 'Security', 'System'];

// ─────────────────────────────────────────────────────────────────
// Config per alert type
// ─────────────────────────────────────────────────────────────────

const ALERT_CONFIG: Record<AlertType, {
  icon: string; color: string; label: string;
}> = {
  screenshot: { icon: '📸', color: '#F97316', label: 'Screenshot' },
  breach:     { icon: '🌑', color: '#FF4D6D', label: 'Data Breach' },
  jailbreak:  { icon: '⚠️', color: '#FF4D6D', label: 'Jailbreak' },
  frida:      { icon: '🔴', color: '#FF4D6D', label: 'Frida Detected' },
  root:       { icon: '⛔', color: '#FF4D6D', label: 'Root Detected' },
  login:      { icon: '🔐', color: '#3B82F6', label: 'Login' },
  system:     { icon: '🛡️', color: '#00D4AA', label: 'System' },
};

function formatAlertTime(ts: any): string {
  if (!ts) return '';
  const d: Date = ts.toDate ? ts.toDate() : new Date(ts);
  const diff = Date.now() - d.getTime();
  const m    = Math.floor(diff / 60000);
  const h    = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (m < 1)   return 'just now';
  if (m < 60)  return `${m}m ago`;
  if (h < 24)  return `${h}h ago`;
  if (days < 7)return `${days}d ago`;
  return d.toLocaleDateString([], { day: '2-digit', month: 'short' });
}

// ─────────────────────────────────────────────────────────────────
// Main Screen
// ─────────────────────────────────────────────────────────────────

export default function AlertsScreen() {
  const router = useRouter();
  const uid    = auth().currentUser?.uid || '';

  const [alerts,  setAlerts]  = useState<SecurityAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter,  setFilter]  = useState<AlertFilter>('All');

  // ── Real-time listener ────────────────────────────────────────
  useEffect(() => {
    if (!uid) return;

    const unsub = firestore()
      .collection('users')
      .doc(uid)
      .collection('alerts')
      .orderBy('createdAt', 'desc')
      .limit(200)
      .onSnapshot(snap => {
        const data: SecurityAlert[] = snap.docs.map(doc => ({
          id: doc.id,
          ...(doc.data() as Omit<SecurityAlert, 'id'>),
        }));
        setAlerts(data);
        setLoading(false);
      }, err => {
        console.error('[Alerts]', err);
        setLoading(false);
      });

    return () => unsub();
  }, [uid]);

  // ── Filter ────────────────────────────────────────────────────
  const SECURITY_TYPES: AlertType[] = ['screenshot', 'breach', 'jailbreak', 'frida', 'root'];
  const SYSTEM_TYPES:   AlertType[] = ['login', 'system'];

  const filtered = alerts.filter(a => {
    switch (filter) {
      case 'Unread':   return !a.read;
      case 'Security': return SECURITY_TYPES.includes(a.type);
      case 'System':   return SYSTEM_TYPES.includes(a.type);
      default:         return true;
    }
  });

  const unreadCount = alerts.filter(a => !a.read).length;

  // ── Mark read ─────────────────────────────────────────────────
  const markRead = async (alert: SecurityAlert) => {
    if (alert.read) return;
    await firestore()
      .collection('users').doc(uid)
      .collection('alerts').doc(alert.id)
      .update({ read: true })
      .catch(() => {});
  };

  // ── Mark all read ─────────────────────────────────────────────
  const markAllRead = async () => {
    const unread = alerts.filter(a => !a.read);
    const batch  = firestore().batch();
    unread.forEach(a => {
      const ref = firestore()
        .collection('users').doc(uid)
        .collection('alerts').doc(a.id);
      batch.update(ref, { read: true });
    });
    await batch.commit().catch(() => {});
  };

  // ── Delete alert ──────────────────────────────────────────────
  const deleteAlert = (alert: SecurityAlert) => {
    Alert.alert('Delete Alert', 'Remove this alert?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: () => {
          firestore()
            .collection('users').doc(uid)
            .collection('alerts').doc(alert.id)
            .delete()
            .catch(() => {});
        },
      },
    ]);
  };

  // ── Clear all ─────────────────────────────────────────────────
  const clearAll = () => {
    Alert.alert('Clear All Alerts', 'Delete all alerts? This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear All', style: 'destructive',
        onPress: async () => {
          const batch = firestore().batch();
          alerts.forEach(a => {
            const ref = firestore()
              .collection('users').doc(uid)
              .collection('alerts').doc(a.id);
            batch.delete(ref);
          });
          await batch.commit().catch(() => {});
        },
      },
    ]);
  };

  // ── Render row ────────────────────────────────────────────────
  const renderAlert = useCallback(({ item }: { item: SecurityAlert }) => {
    const cfg = ALERT_CONFIG[item.type] || ALERT_CONFIG.system;

    return (
      <TouchableOpacity
        style={[styles.alertRow, !item.read && styles.alertRowUnread]}
        onPress={() => markRead(item)}
        onLongPress={() => deleteAlert(item)}
        activeOpacity={0.7}
      >
        {/* Severity bar */}
        <View style={[
          styles.severityBar,
          {
            backgroundColor:
              item.severity === 'high'   ? '#FF4D6D' :
              item.severity === 'medium' ? '#F97316' : '#374151',
          },
        ]} />

        {/* Icon */}
        <View style={[styles.alertIcon, { backgroundColor: cfg.color + '22' }]}>
          <Text style={styles.alertIconText}>{cfg.icon}</Text>
        </View>

        {/* Content */}
        <View style={styles.alertContent}>
          <View style={styles.alertTop}>
            <Text style={[styles.alertType, { color: cfg.color }]}>
              {cfg.label}
            </Text>
            <Text style={styles.alertTime}>{formatAlertTime(item.createdAt)}</Text>
          </View>
          <Text style={styles.alertMessage} numberOfLines={2}>
            {item.message}
          </Text>
          {item.detail ? (
            <Text style={styles.alertDetail} numberOfLines={1}>
              {item.detail}
            </Text>
          ) : null}
        </View>

        {/* Unread dot */}
        {!item.read && <View style={styles.unreadDot} />}
      </TouchableOpacity>
    );
  }, [uid]);

  // ─────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>

      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Security Alerts</Text>
          <Text style={styles.headerSub}>REAL-TIME THREAT MONITOR</Text>
        </View>
        {unreadCount > 0 && (
          <TouchableOpacity style={styles.markAllBtn} onPress={markAllRead}>
            <Text style={styles.markAllText}>Mark all read</Text>
          </TouchableOpacity>
        )}
        {alerts.length > 0 && (
          <TouchableOpacity style={styles.clearBtn} onPress={clearAll}>
            <Text style={styles.clearBtnText}>🗑️</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Filter tabs */}
      <View style={styles.tabs}>
        {FILTERS.map(f => (
          <TouchableOpacity
            key={f}
            style={[styles.tab, filter === f && styles.tabActive]}
            onPress={() => setFilter(f)}
          >
            <Text style={[styles.tabText, filter === f && styles.tabTextActive]}>
              {f}
            </Text>
            {f === 'Unread' && unreadCount > 0 && (
              <View style={styles.tabBadge}>
                <Text style={styles.tabBadgeText}>{unreadCount}</Text>
              </View>
            )}
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color="#00D4AA" />
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={a => a.id}
          renderItem={renderAlert}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyIcon}>🛡️</Text>
              <Text style={styles.emptyTitle}>All Clear</Text>
              <Text style={styles.emptyText}>
                {filter === 'Unread'
                  ? 'No unread alerts'
                  : 'No security alerts'}
              </Text>
            </View>
          }
        />
      )}

      <BottomNav active="Alerts" />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#0A0E1A' },
  header: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#111827',
    paddingTop: 48, paddingBottom: 12, paddingHorizontal: 16,
    borderBottomWidth: 0.5, borderBottomColor: '#1E293B',
    gap: 8,
  },
  headerTitle:  { fontSize: 18, fontWeight: 'bold', color: '#FFFFFF' },
  headerSub:    { fontSize: 9, color: '#00D4AA', marginTop: 2, fontWeight: 'bold' },
  markAllBtn: {
    marginLeft: 'auto', backgroundColor: '#1A2235',
    borderRadius: 8, borderWidth: 0.5, borderColor: '#1E293B',
    paddingHorizontal: 10, paddingVertical: 5,
  },
  markAllText:  { fontSize: 11, color: '#00D4AA' },
  clearBtn: {
    width: 32, height: 32, backgroundColor: '#1A2235',
    borderRadius: 8, borderWidth: 0.5, borderColor: '#1E293B',
    justifyContent: 'center', alignItems: 'center',
  },
  clearBtnText: { fontSize: 16 },

  // Tabs
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: 0.5, borderBottomColor: '#1E293B',
  },
  tab: {
    flex: 1, alignItems: 'center', paddingVertical: 11,
    flexDirection: 'row', justifyContent: 'center', gap: 5,
  },
  tabActive:     { borderBottomWidth: 2, borderBottomColor: '#00D4AA' },
  tabText:       { fontSize: 12, color: '#64748B' },
  tabTextActive: { color: '#00D4AA', fontWeight: 'bold' },
  tabBadge: {
    backgroundColor: '#FF4D6D', borderRadius: 7,
    minWidth: 14, height: 14,
    justifyContent: 'center', alignItems: 'center', paddingHorizontal: 3,
  },
  tabBadgeText:  { fontSize: 8, color: '#FFFFFF', fontWeight: 'bold' },

  loadingWrap:   { flex: 1, justifyContent: 'center', alignItems: 'center' },
  listContent:   { padding: 12, paddingBottom: 100, flexGrow: 1 },

  alertRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#0D1117',
    borderRadius: 12, padding: 12, gap: 10,
    borderWidth: 0.5, borderColor: '#1E293B',
    overflow: 'hidden',
  },
  alertRowUnread: {
    backgroundColor: '#111827',
    borderColor: '#1E293B',
  },
  severityBar: {
    position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
  },
  alertIcon: {
    width: 44, height: 44, borderRadius: 10,
    justifyContent: 'center', alignItems: 'center',
  },
  alertIconText: { fontSize: 22 },
  alertContent:  { flex: 1 },
  alertTop: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', marginBottom: 4,
  },
  alertType:    { fontSize: 11, fontWeight: 'bold' },
  alertTime:    { fontSize: 10, color: '#374151' },
  alertMessage: { fontSize: 13, color: '#FFFFFF', lineHeight: 18, marginBottom: 2 },
  alertDetail:  { fontSize: 11, color: '#374151' },
  unreadDot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: '#00D4AA',
    position: 'absolute', top: 12, right: 12,
  },
  sep: { height: 6 },

  emptyWrap:  { flex: 1, alignItems: 'center', paddingTop: 80, gap: 10 },
  emptyIcon:  { fontSize: 52 },
  emptyTitle: { fontSize: 18, fontWeight: 'bold', color: '#FFFFFF' },
  emptyText:  { fontSize: 13, color: '#374151' },
});
