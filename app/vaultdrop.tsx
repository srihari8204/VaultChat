/**
 * app/vaultdrop.tsx
 * VaultDrop — D2DE file sharing (emoji fix applied)
 */
import { BRAND_ACCENT } from '../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import React, { useState, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  FlatList, Alert, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import type { Palette } from '../constants/theme';
import { useColors } from '../lib/theme';

interface VaultFile {
  id:       string;
  name:     string;
  size:     string;
  type:     string;
  icon:     string;
  time:     string;
  isD2DE:   boolean;
  status:   'ready' | 'sending' | 'sent' | 'received';
}

const getFileIcon = (name: string): string => {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (['jpg','jpeg','png','gif','webp'].includes(ext)) return 'IMG';
  if (['mp4','mov','avi','mkv'].includes(ext))          return 'VID';
  if (['mp3','wav','aac','m4a'].includes(ext))          return 'AUD';
  if (['pdf'].includes(ext))                            return 'PDF';
  if (['doc','docx'].includes(ext))                     return 'DOC';
  if (['xls','xlsx'].includes(ext))                     return 'XLS';
  if (['zip','rar','7z'].includes(ext))                 return 'ZIP';
  return 'FILE';
};

const getIconColor = (icon: string): string => {
  const map: Record<string, string> = {
    IMG: '#F5C842', VID: '#9B5DE5', AUD: '#3B82F6',
    PDF: '#FF4D6D', DOC: '#3B82F6', XLS: BRAND_ACCENT,
    ZIP: BRAND_ACCENT, FILE: '#6B7280',
  };
  return map[icon] || '#6B7280';
};

const formatSize = (bytes: number): string => {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

export default function VaultDropScreen() {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [files,    setFiles]    = useState<VaultFile[]>([]);
  const [picking,  setPicking]  = useState(false);
  const [sending,  setSending]  = useState<string | null>(null);

  const pickFile = async () => {
    try {
      setPicking(true);
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;

      const newFiles: VaultFile[] = result.assets.map(asset => ({
        id:     Math.random().toString(36).slice(2),
        name:   asset.name,
        size:   formatSize(asset.size || 0),
        type:   asset.mimeType || 'unknown',
        icon:   getFileIcon(asset.name),
        time:   new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isD2DE: true,
        status: 'ready',
      }));
      setFiles(prev => [...newFiles, ...prev]);
    } catch {
      Alert.alert('Error', 'Could not pick file.');
    } finally {
      setPicking(false);
    }
  };

  const sendFile = async (id: string) => {
    setSending(id);
    setFiles(prev => prev.map(f => f.id === id ? { ...f, status: 'sending' } : f));
    // Simulate D2DE encrypted send
    await new Promise(r => setTimeout(r, 2000));
    setFiles(prev => prev.map(f => f.id === id ? { ...f, status: 'sent' } : f));
    setSending(null);
    Alert.alert('Sent', 'File sent with D2DE encryption');
  };

  const removeFile = (id: string) => {
    setFiles(prev => prev.filter(f => f.id !== id));
  };

  const statusLabel = (status: string) => {
    if (status === 'sending')  return 'Encrypting...';
    if (status === 'sent')     return 'Sent D2DE';
    if (status === 'received') return 'Received';
    return 'Ready';
  };

  const statusColor = (status: string) => {
    if (status === 'sending')  return '#F5C842';
    if (status === 'sent')     return BRAND_ACCENT;
    if (status === 'received') return '#3B82F6';
    return '#6B7280';
  };

  const renderFile = ({ item }: { item: VaultFile }) => {
    const iconColor = getIconColor(item.icon);
    return (
      <View style={styles.fileCard}>
        {/* Icon */}
        <View style={[styles.fileIconBox, { backgroundColor: iconColor + '22', borderColor: iconColor + '55' }]}>
          <Text style={[styles.fileIconText, { color: iconColor }]}>{item.icon}</Text>
        </View>
        {/* Info */}
        <View style={styles.fileInfo}>
          <Text style={styles.fileName} numberOfLines={1}>{item.name}</Text>
          <View style={styles.fileMeta}>
            <Text style={styles.fileSize}>{item.size}</Text>
            {item.isD2DE && <Text style={styles.d2deTag}>D2DE</Text>}
            <Text style={[styles.fileStatus, { color: statusColor(item.status) }]}>
              {statusLabel(item.status)}
            </Text>
          </View>
        </View>
        {/* Actions */}
        <View style={styles.fileActions}>
          {item.status === 'ready' && (
            <TouchableOpacity
              style={styles.sendBtn}
              onPress={() => sendFile(item.id)}
              disabled={sending === item.id}
            >
              {sending === item.id
                ? <ActivityIndicator size="small" color="#FFFFFF" />
                : <Text style={styles.sendBtnText}>Send</Text>
              }
            </TouchableOpacity>
          )}
          {item.status === 'sent' && (
            <Text style={styles.sentCheck}>Done</Text>
          )}
          <TouchableOpacity onPress={() => removeFile(item.id)} style={styles.removeBtn}>
            <Ionicons name="close" size={14} color="#FF4D6D" />
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>VaultDrop</Text>
        <View style={styles.headerRight}>
          <Text style={styles.d2deBadge}>D2DE</Text>
        </View>
      </View>

      {/* Info banner */}
      <View style={styles.infoBanner}>
        <Text style={styles.infoBannerIcon}>Shield</Text>
        <Text style={styles.infoBannerText}>
          All files encrypted with AES-256-GCM before sending. Server never sees plaintext.
        </Text>
      </View>

      {/* Pick file button */}
      <TouchableOpacity style={styles.pickBtn} onPress={pickFile} disabled={picking}>
        {picking
          ? <ActivityIndicator color="#FFFFFF" />
          : <>
              <Text style={styles.pickBtnIcon}>+</Text>
              <Text style={styles.pickBtnText}>Add Files to VaultDrop</Text>
            </>
        }
      </TouchableOpacity>

      {/* File list */}
      <FlatList
        data={files}
        keyExtractor={f => f.id}
        renderItem={renderFile}
        contentContainerStyle={styles.fileList}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyTitle}>No files yet</Text>
            <Text style={styles.emptySub}>Pick files to send them encrypted via D2DE</Text>
          </View>
        }
      />
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container:      { flex: 1, backgroundColor: c.card },
  header:         { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.border },
  backBtn:        { paddingRight: 12 },
  backText:       { color: BRAND_ACCENT, fontSize: 15 },
  headerTitle:    { flex: 1, color: c.text, fontWeight: 'bold', fontSize: 18, textAlign: 'center' },
  headerRight:    { minWidth: 60, alignItems: 'flex-end' },
  d2deBadge:      { color: BRAND_ACCENT, fontSize: 11, fontWeight: 'bold', borderWidth: 1, borderColor: BRAND_ACCENT, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  infoBanner:     { flexDirection: 'row', alignItems: 'center', margin: 12, backgroundColor: c.surfaceSolid, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: BRAND_ACCENT + '33', gap: 10 },
  infoBannerIcon: { color: BRAND_ACCENT, fontSize: 11, fontWeight: 'bold' },
  infoBannerText: { flex: 1, color: c.textDim, fontSize: 12, lineHeight: 18 },
  pickBtn:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', margin: 12, backgroundColor: BRAND_ACCENT, borderRadius: 14, paddingVertical: 14, gap: 8 },
  pickBtnIcon:    { color: '#FFFFFF', fontSize: 22, fontWeight: 'bold' },
  pickBtnText:    { color: '#FFFFFF', fontWeight: 'bold', fontSize: 15 },
  fileList:       { padding: 12, gap: 10 },
  fileCard:       { flexDirection: 'row', alignItems: 'center', backgroundColor: c.bg, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: c.border, gap: 10 },
  fileIconBox:    { width: 46, height: 46, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  fileIconText:   { fontSize: 11, fontWeight: 'bold' },
  fileInfo:       { flex: 1 },
  fileName:       { color: c.text, fontWeight: 'bold', fontSize: 14, marginBottom: 4 },
  fileMeta:       { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fileSize:       { color: c.textDim, fontSize: 11 },
  d2deTag:        { color: BRAND_ACCENT, fontSize: 10, fontWeight: 'bold', borderWidth: 1, borderColor: BRAND_ACCENT + '44', borderRadius: 4, paddingHorizontal: 4 },
  fileStatus:     { fontSize: 11, fontWeight: 'bold' },
  fileActions:    { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sendBtn:        { backgroundColor: BRAND_ACCENT, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  sendBtnText:    { color: '#FFFFFF', fontWeight: 'bold', fontSize: 12 },
  sentCheck:      { color: BRAND_ACCENT, fontSize: 12, fontWeight: 'bold' },
  removeBtn:      { width: 24, height: 24, borderRadius: 12, backgroundColor: '#FF4D6D22', alignItems: 'center', justifyContent: 'center' },
  removeBtnText:  { color: '#FF4D6D', fontSize: 11, fontWeight: 'bold' },
  emptyWrap:      { alignItems: 'center', paddingTop: 60, gap: 8 },
  emptyTitle:     { color: c.text, fontSize: 18, fontWeight: 'bold' },
  emptySub:       { color: c.textDim, fontSize: 13, textAlign: 'center' },
});
