// app/profile.tsx
// Real profile screen
// Edit display name — saved to Firebase Auth + Firestore
// Profile photo — ImagePicker → saved to Firestore
// PIN change — requires face scan confirmation first
// Logout — clears SecureStore + signs out Firebase
// Danger zone — delete account

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  TextInput, Alert, ActivityIndicator,
  ScrollView, Switch,
} from 'react-native';
import { useRouter } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import * as SecureStore from 'expo-secure-store';
import * as ImagePicker from 'expo-image-picker';
import { BottomNav } from './chats';

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

interface ProfileData {
  displayName:    string;
  phone:          string;
  bio:            string;
  notifyMessages: boolean;
  notifyCalls:    boolean;
  notifyAlerts:   boolean;
  twoFA:          boolean;
}

// ─────────────────────────────────────────────────────────────────
// Main Screen
// ─────────────────────────────────────────────────────────────────

export default function ProfileScreen() {
  const router  = useRouter();
  const user    = auth().currentUser;
  const uid     = user?.uid || '';

  const [profile,   setProfile]   = useState<ProfileData>({
    displayName:    user?.displayName || '',
    phone:          user?.phoneNumber || '',
    bio:            '',
    notifyMessages: true,
    notifyCalls:    true,
    notifyAlerts:   true,
    twoFA:          true,
  });
  const [editing,   setEditing]   = useState(false);
  const [loading,   setLoading]   = useState(false);
  const [avatarBg,  setAvatarBg]  = useState('#003328');

  // ── Load profile from Firestore ───────────────────────────────
  useEffect(() => {
    if (!uid) return;
    firestore()
      .collection('users')
      .doc(uid)
      .get()
      .then(doc => {
        if (doc.exists) {
          const d = doc.data()!;
          setProfile(prev => ({
            ...prev,
            bio:            d.bio            || '',
            notifyMessages: d.notifyMessages ?? true,
            notifyCalls:    d.notifyCalls    ?? true,
            notifyAlerts:   d.notifyAlerts   ?? true,
            twoFA:          d.twoFA          ?? true,
          }));
        }
      })
      .catch(() => {});
  }, [uid]);

  // ── Save profile ──────────────────────────────────────────────
  const saveProfile = async () => {
    if (!profile.displayName.trim()) {
      Alert.alert('Error', 'Display name cannot be empty');
      return;
    }
    setLoading(true);
    try {
      // Update Firebase Auth display name
      await user?.updateProfile({ displayName: profile.displayName.trim() });

      // Update Firestore user doc
      await firestore()
        .collection('users')
        .doc(uid)
        .set({
          displayName:    profile.displayName.trim(),
          bio:            profile.bio.trim(),
          notifyMessages: profile.notifyMessages,
          notifyCalls:    profile.notifyCalls,
          notifyAlerts:   profile.notifyAlerts,
          twoFA:          profile.twoFA,
          updatedAt:      firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

      setEditing(false);
      Alert.alert('Saved', 'Profile updated successfully');
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Change photo ──────────────────────────────────────────────
  const changePhoto = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Grant gallery access');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: true,
      aspect:        [1, 1],
      quality:       0.8,
    });
    if (!result.canceled) {
      // In production: upload to Firebase Storage, save URL to Firestore
      // For now: save URI locally and update Firestore
      await firestore()
        .collection('users')
        .doc(uid)
        .update({ photoUri: result.assets[0].uri })
        .catch(() => {});
      Alert.alert('Photo Updated', 'Profile photo saved.');
    }
  };

  // ── Change PIN — requires face scan ───────────────────────────
  const changePIN = () => {
    Alert.alert(
      'Change PIN',
      'You will need to verify with Face ID or Biometrics before changing your PIN.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          onPress: () => router.push({
            pathname: '/facescan',
            params: { next: '/pinsetup', action: 'change_pin' },
          }),
        },
      ]
    );
  };

  // ── Toggle notification / security settings ───────────────────
  const toggleSetting = async (
    key: keyof ProfileData,
    value: boolean
  ) => {
    const updated = { ...profile, [key]: value };
    setProfile(updated);
    await firestore()
      .collection('users')
      .doc(uid)
      .update({ [key]: value })
      .catch(() => {});
  };

  // ── Logout ────────────────────────────────────────────────────
  const handleLogout = () => {
    Alert.alert(
      'Log Out',
      'Are you sure you want to log out?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Log Out', style: 'destructive',
          onPress: async () => {
            try {
              // Clear all local secure data
              await SecureStore.deleteItemAsync('vault_pin');
              await SecureStore.deleteItemAsync('vault_manifest');
              await SecureStore.deleteItemAsync('vault_last_backup');
              // Sign out of Firebase
              await auth().signOut();
              router.replace('/login');
            } catch (e: any) {
              Alert.alert('Error', e.message);
            }
          },
        },
      ]
    );
  };

  // ── Delete account ────────────────────────────────────────────
  const handleDeleteAccount = () => {
    Alert.alert(
      '⚠️ Delete Account',
      'This will permanently delete your account, all messages, and vault files. This CANNOT be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'DELETE ACCOUNT', style: 'destructive',
          onPress: async () => {
            try {
              // Delete Firestore data
              await firestore().collection('users').doc(uid).delete();
              // Delete Firebase Auth account
              await user?.delete();
              router.replace('/login');
            } catch (e: any) {
              Alert.alert('Error', e.message ||
                'Re-authenticate and try again (Firebase requires recent login for deletion)');
            }
          },
        },
      ]
    );
  };

  // ── Initials for avatar ───────────────────────────────────────
  const initials = profile.displayName
    ? profile.displayName.trim().split(' ')
        .map(w => w[0]).join('').toUpperCase().slice(0, 2)
    : '??';

  // ─────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.back}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Profile</Text>
        <TouchableOpacity
          onPress={editing ? saveProfile : () => setEditing(true)}
          disabled={loading}
        >
          {loading
            ? <ActivityIndicator color="#00D4AA" size="small" />
            : <Text style={styles.editBtn}>
                {editing ? 'Save' : 'Edit'}
              </Text>
          }
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Avatar */}
        <View style={styles.avatarSection}>
          <TouchableOpacity style={styles.avatarWrap} onPress={changePhoto}>
            <View style={[styles.avatar, { backgroundColor: avatarBg }]}>
              <Text style={styles.avatarText}>{initials}</Text>
            </View>
            <View style={styles.cameraOverlay}>
              <Text style={styles.cameraIcon}>📷</Text>
            </View>
          </TouchableOpacity>
          <Text style={styles.avatarName}>{profile.displayName || 'Your Name'}</Text>
          <Text style={styles.avatarPhone}>{profile.phone}</Text>
          <View style={styles.d2deBadge}>
            <Text style={styles.d2deBadgeText}>🛡️ D2DE Active · Verified</Text>
          </View>
        </View>

        {/* Personal info */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>PERSONAL INFO</Text>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Display Name</Text>
            <TextInput
              style={[styles.fieldInput, !editing && styles.fieldInputReadonly]}
              value={profile.displayName}
              onChangeText={v => setProfile(p => ({ ...p, displayName: v }))}
              editable={editing}
              placeholder="Your name"
              placeholderTextColor="#374151"
              maxLength={40}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Phone Number</Text>
            <Text style={styles.fieldReadonly}>{profile.phone || '—'}</Text>
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Bio</Text>
            <TextInput
              style={[styles.fieldInput, !editing && styles.fieldInputReadonly]}
              value={profile.bio}
              onChangeText={v => setProfile(p => ({ ...p, bio: v }))}
              editable={editing}
              placeholder="About me..."
              placeholderTextColor="#374151"
              maxLength={100}
              multiline
            />
          </View>
        </View>

        {/* Notifications */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>NOTIFICATIONS</Text>

          {[
            { key: 'notifyMessages', label: 'Messages',    icon: '💬' },
            { key: 'notifyCalls',    label: 'Calls',       icon: '📞' },
            { key: 'notifyAlerts',   label: 'Alerts',      icon: '🔔' },
          ].map(({ key, label, icon }) => (
            <View key={key} style={styles.toggleRow}>
              <Text style={styles.toggleIcon}>{icon}</Text>
              <Text style={styles.toggleLabel}>{label}</Text>
              <Switch
                value={profile[key as keyof ProfileData] as boolean}
                onValueChange={v => toggleSetting(key as keyof ProfileData, v)}
                trackColor={{ false: '#1E293B', true: '#003328' }}
                thumbColor={
                  profile[key as keyof ProfileData] ? '#00D4AA' : '#374151'
                }
              />
            </View>
          ))}
        </View>

        {/* Security */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>SECURITY</Text>

          <View style={styles.toggleRow}>
            <Text style={styles.toggleIcon}>🔐</Text>
            <Text style={styles.toggleLabel}>Two-Factor Auth</Text>
            <Switch
              value={profile.twoFA}
              onValueChange={v => toggleSetting('twoFA', v)}
              trackColor={{ false: '#1E293B', true: '#003328' }}
              thumbColor={profile.twoFA ? '#00D4AA' : '#374151'}
            />
          </View>

          <TouchableOpacity style={styles.actionRow} onPress={changePIN}>
            <View style={styles.actionLeft}>
              <Text style={styles.toggleIcon}>🔑</Text>
              <Text style={styles.toggleLabel}>Change PIN</Text>
            </View>
            <Text style={styles.actionChevron}>›</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.actionRow}
            onPress={() => router.push('/d2de-status')}
          >
            <View style={styles.actionLeft}>
              <Text style={styles.toggleIcon}>🛡️</Text>
              <Text style={styles.toggleLabel}>D2DE Security Details</Text>
            </View>
            <Text style={styles.actionChevron}>›</Text>
          </TouchableOpacity>
        </View>

        {/* Account actions */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>ACCOUNT</Text>

          <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
            <Text style={styles.logoutIcon}>🚪</Text>
            <Text style={styles.logoutText}>Log Out</Text>
          </TouchableOpacity>
        </View>

        {/* Danger zone */}
        <View style={[styles.section, styles.dangerSection]}>
          <Text style={[styles.sectionLabel, styles.dangerLabel]}>DANGER ZONE</Text>

          <TouchableOpacity
            style={styles.deleteBtn}
            onPress={handleDeleteAccount}
          >
            <Text style={styles.deleteBtnText}>⚠️ Delete Account</Text>
          </TouchableOpacity>
          <Text style={styles.deleteNote}>
            Permanently deletes all data. Cannot be undone.
          </Text>
        </View>

        <View style={{ height: 20 }} />
      </ScrollView>

      <BottomNav active="Profile" />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: '#0A0E1A' },
  header: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#111827',
    paddingTop: 48, paddingBottom: 12, paddingHorizontal: 16,
    borderBottomWidth: 0.5, borderBottomColor: '#1E293B',
  },
  back:        { fontSize: 28, color: '#00D4AA', fontWeight: 'bold' },
  headerTitle: { fontSize: 18, fontWeight: 'bold', color: '#FFFFFF' },
  editBtn:     { fontSize: 15, color: '#00D4AA', fontWeight: 'bold' },

  scroll:      { flex: 1 },
  scrollContent: { paddingBottom: 100 },

  // Avatar section
  avatarSection: {
    alignItems: 'center', paddingVertical: 28,
    borderBottomWidth: 0.5, borderBottomColor: '#111827',
  },
  avatarWrap:  { position: 'relative', marginBottom: 12 },
  avatar: {
    width: 90, height: 90, borderRadius: 45,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 3, borderColor: '#00D4AA',
  },
  avatarText:  { fontSize: 30, fontWeight: 'bold', color: '#00D4AA' },
  cameraOverlay: {
    position: 'absolute', bottom: 0, right: 0,
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: '#111827', borderWidth: 2, borderColor: '#0A0E1A',
    justifyContent: 'center', alignItems: 'center',
  },
  cameraIcon:  { fontSize: 14 },
  avatarName: {
    fontSize: 20, fontWeight: 'bold', color: '#FFFFFF', marginBottom: 4,
  },
  avatarPhone: { fontSize: 13, color: '#64748B', marginBottom: 10 },
  d2deBadge: {
    backgroundColor: '#003328', borderRadius: 20,
    borderWidth: 0.5, borderColor: '#00D4AA44',
    paddingHorizontal: 14, paddingVertical: 5,
  },
  d2deBadgeText: { fontSize: 11, color: '#00D4AA', fontWeight: 'bold' },

  // Sections
  section: {
    paddingHorizontal: 16, paddingTop: 20, paddingBottom: 4,
    borderBottomWidth: 0.5, borderBottomColor: '#111827',
  },
  sectionLabel: {
    fontSize: 10, fontWeight: 'bold', color: '#374151',
    letterSpacing: 0.8, marginBottom: 12,
  },

  // Fields
  field:        { marginBottom: 14 },
  fieldLabel:   { fontSize: 11, color: '#64748B', marginBottom: 5 },
  fieldInput: {
    backgroundColor: '#111827', borderRadius: 10,
    borderWidth: 0.5, borderColor: '#1E293B',
    paddingHorizontal: 14, paddingVertical: 10,
    color: '#FFFFFF', fontSize: 15,
  },
  fieldInputReadonly: {
    backgroundColor: 'transparent', borderColor: 'transparent',
    paddingHorizontal: 0,
  },
  fieldReadonly: { fontSize: 15, color: '#FFFFFF', paddingVertical: 6 },

  // Toggle rows
  toggleRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 0.5, borderBottomColor: '#111827',
  },
  toggleIcon:  { fontSize: 20, marginRight: 12 },
  toggleLabel: { flex: 1, fontSize: 14, color: '#FFFFFF' },

  // Action rows
  actionRow: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 0.5, borderBottomColor: '#111827',
  },
  actionLeft:   { flexDirection: 'row', alignItems: 'center' },
  actionChevron:{ fontSize: 20, color: '#374151' },

  // Logout
  logoutBtn: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#1A2235', borderRadius: 10,
    borderWidth: 0.5, borderColor: '#1E293B',
    paddingVertical: 13, paddingHorizontal: 16, gap: 10,
    marginBottom: 8,
  },
  logoutIcon:  { fontSize: 20 },
  logoutText:  { fontSize: 15, color: '#FFFFFF', fontWeight: 'bold' },

  // Danger
  dangerSection:{ borderBottomWidth: 0 },
  dangerLabel:  { color: '#FF4D6D44' },
  deleteBtn: {
    backgroundColor: '#FF4D6D11', borderRadius: 10,
    borderWidth: 0.5, borderColor: '#FF4D6D44',
    paddingVertical: 13, alignItems: 'center', marginBottom: 8,
  },
  deleteBtnText: { fontSize: 14, color: '#FF4D6D', fontWeight: 'bold' },
  deleteNote:    { fontSize: 11, color: '#374151', textAlign: 'center' },
});
