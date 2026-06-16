// app/chat-export.tsx — Export Chat as Text/HTML (Postgres-backed).
//
// Pulls the full message history via GET /chats/:id/messages (keyset
// pagination), formats it on-device, and shares via the system sheet.
// Nothing leaves the device except through the user-initiated share.

import React, { useState , useMemo} from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, StatusBar, Alert, ActivityIndicator, Share,
} from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { getMessages, type Message } from '../lib/chatService';
import { getCurrentUserAsync } from './(constants)/authService';

const PAGE = 200;

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function ChatExportScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const params = useLocalSearchParams<{ chatId?: string; id?: string; peerName?: string }>();
  const chatId = String(params.chatId ?? params.id ?? '');
  const peerName = (params.peerName as string) || 'Chat';

  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState('');
  const [msgCount, setMsgCount] = useState(0);

  // Fetch every message (oldest→newest) by walking the keyset cursor.
  const fetchAll = async (): Promise<Message[]> => {
    const all: Message[] = [];
    let before: number | undefined;
    for (let i = 0; i < 500; i++) {
      const page = await getMessages(chatId, { before, limit: PAGE });
      all.push(...page);
      setMsgCount(all.length);
      if (page.length < PAGE) break;
      before = page[page.length - 1].id; // oldest id in this (desc) page
    }
    all.sort((a, b) => a.id - b.id);
    return all;
  };

  const fmtTime = (iso: string) => { try { return new Date(iso).toLocaleString(); } catch { return ''; } };

  const senderLabel = (m: Message, myId: string) => (m.senderId === myId ? 'You' : peerName);

  const bodyOf = (m: Message): string => {
    if (m.deletedAt) return '[deleted]';
    switch (m.type) {
      case 'text': return m.content || '';
      case 'image': return '[Image]' + (m.content ? ' ' + m.content : '');
      case 'video': return '[Video]' + (m.content ? ' ' + m.content : '');
      case 'audio': return '[Voice message]';
      case 'file': return '[File]' + (m.content ? ' ' + m.content : '');
      case 'location': return '[Location]';
      case 'sticker': return '[Sticker ' + (m.content || '') + ']';
      case 'poll': return '[Poll] ' + (m.content || '');
      default: return '[' + m.type + ']';
    }
  };

  const shareFile = async (filePath: string, mime: string, fallback: string) => {
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(filePath, { mimeType: mime });
    else await Share.share({ message: fallback });
  };

  const writeFile = async (ext: string, content: string) => {
    const name = 'VaultChat_' + peerName.replace(/[^a-zA-Z0-9]/g, '_') + '_' + Date.now() + '.' + ext;
    const filePath = FileSystem.documentDirectory + name;
    await FileSystem.writeAsStringAsync(filePath, content, { encoding: FileSystem.EncodingType.UTF8 });
    return filePath;
  };

  const guard = async (fn: (msgs: Message[], myId: string) => Promise<void>) => {
    if (!chatId) { Alert.alert('Export failed', 'Missing chat id.'); return; }
    setExporting(true);
    setProgress('Fetching messages…');
    setMsgCount(0);
    try {
      const me = await getCurrentUserAsync();
      const msgs = await fetchAll();
      setProgress('Formatting ' + msgs.length + ' messages…');
      await fn(msgs, me?.id ?? '');
      setProgress('');
    } catch (e: any) {
      Alert.alert('Export failed', e?.message ?? 'Something went wrong');
    } finally {
      setExporting(false);
    }
  };

  const exportAsText = () => guard(async (msgs, myId) => {
    let text = 'VaultChat Export - ' + peerName + '\n';
    text += 'Exported: ' + new Date().toLocaleString() + '\n';
    text += 'Messages: ' + msgs.length + '\n' + '='.repeat(50) + '\n\n';
    for (const m of msgs) {
      text += '[' + fmtTime(m.createdAt) + '] ' + senderLabel(m, myId) + ': ' + bodyOf(m) + '\n';
      if (m.editedAt) text += '  (edited)\n';
    }
    setProgress('Saving file…');
    const filePath = await writeFile('txt', text);
    await shareFile(filePath, 'text/plain', text);
  });

  const exportAsHTML = () => guard(async (msgs, myId) => {
    const esc = (str: string) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">';
    html += '<title>VaultChat Export</title><style>';
    html += 'body{font-family:-apple-system,Segoe UI,sans-serif;background:#0A0A0F;color:#fff;max-width:600px;margin:0 auto;padding:16px}';
    html += '.header{text-align:center;padding:20px;border-bottom:1px solid #222;margin-bottom:20px}';
    html += '.header h1{color:#10B981;margin:0}.header p{color:#888;font-size:12px}';
    html += '.msg{margin:4px 0;padding:8px 12px;border-radius:14px;max-width:80%;word-wrap:break-word}';
    html += '.mine{background:#10B98122;margin-left:auto;border-bottom-right-radius:2px}';
    html += '.peer{background:#1a1a22;margin-right:auto;border-bottom-left-radius:2px}';
    html += '.time{color:#666;font-size:10px;margin-top:4px;text-align:right}';
    html += '.sender{color:#06B6D4;font-size:11px;font-weight:700;margin-bottom:2px}';
    html += '.meta{color:#777;font-size:10px;font-style:italic}';
    html += '</style></head><body>';
    html += '<div class="header"><h1>VaultChat</h1><p>Chat with ' + esc(peerName) + '</p>';
    html += '<p>' + msgs.length + ' messages | Exported ' + new Date().toLocaleString() + '</p></div>';
    for (const m of msgs) {
      const isMine = m.senderId === myId;
      html += '<div class="msg ' + (isMine ? 'mine' : 'peer') + '">';
      if (!isMine) html += '<div class="sender">' + esc(senderLabel(m, myId)) + '</div>';
      html += '<div>' + esc(bodyOf(m)).replace(/\n/g, '<br>') + '</div>';
      html += '<div class="time">' + fmtTime(m.createdAt) + '</div>';
      if (m.editedAt) html += '<div class="meta">(edited)</div>';
      html += '</div>';
    }
    html += '</body></html>';
    setProgress('Saving file…');
    const filePath = await writeFile('html', html);
    await shareFile(filePath, 'text/html', 'VaultChat export');
  });

  return (
    <View style={s.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="light-content" />

      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Export Chat</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={s.body}>
        <View style={s.infoCard}>
          <Ionicons name="share-outline" size={26} color={colors.primary} />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={s.infoTitle}>Export {peerName}</Text>
            <Text style={s.infoDesc}>Save your conversation as a file you can share or keep as backup.</Text>
          </View>
        </View>

        <TouchableOpacity style={s.exportBtn} onPress={exportAsText} disabled={exporting} activeOpacity={0.8}>
          <View style={s.exportIcon}><Ionicons name="document-text-outline" size={22} color={colors.accent} /></View>
          <View style={{ flex: 1 }}>
            <Text style={s.exportTitle}>Export as Text</Text>
            <Text style={s.exportDesc}>Plain text file (.txt) — lightweight, universal</Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity style={s.exportBtn} onPress={exportAsHTML} disabled={exporting} activeOpacity={0.8}>
          <View style={s.exportIcon}><Ionicons name="globe-outline" size={22} color={colors.accent} /></View>
          <View style={{ flex: 1 }}>
            <Text style={s.exportTitle}>Export as HTML</Text>
            <Text style={s.exportDesc}>Styled web page (.html) — looks like a real chat</Text>
          </View>
        </TouchableOpacity>

        {exporting && (
          <View style={s.progressBox}>
            <ActivityIndicator color={colors.primary} />
            <Text style={s.progressTxt}>{progress}</Text>
            {msgCount > 0 && <Text style={s.progressCount}>{msgCount} messages</Text>}
          </View>
        )}

        <View style={s.noteBox}>
          <Text style={s.noteTitle}>Privacy Note</Text>
          <Text style={s.noteDesc}>Exported files are NOT encrypted. Only export chats you&apos;re comfortable saving in plain text. The export happens entirely on your device.</Text>
        </View>
      </View>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 54, paddingHorizontal: 16, paddingBottom: 8 },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  body: { flex: 1, padding: 16 },
  infoCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.card, borderRadius: 14, padding: 16, marginBottom: 20, borderWidth: 1, borderColor: c.border },
  infoTitle: { color: c.text, fontSize: 16, fontWeight: '800' },
  infoDesc: { color: c.textDim, fontSize: 12, marginTop: 2, lineHeight: 18 },
  exportBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.card, borderRadius: 14, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: c.border },
  exportIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: c.surface, justifyContent: 'center', alignItems: 'center', marginRight: 14 },
  exportTitle: { color: c.text, fontSize: 15, fontWeight: '700' },
  exportDesc: { color: c.textDim, fontSize: 12, marginTop: 2 },
  progressBox: { alignItems: 'center', padding: 20, marginTop: 10 },
  progressTxt: { color: c.textDim, fontSize: 13, marginTop: 8 },
  progressCount: { color: c.textFaint, fontSize: 11, marginTop: 4 },
  noteBox: { marginTop: 24, backgroundColor: 'rgba(239,68,68,0.06)', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: 'rgba(239,68,68,0.22)' },
  noteTitle: { color: c.danger, fontSize: 12, fontWeight: '800', marginBottom: 4 },
  noteDesc: { color: c.textDim, fontSize: 11, lineHeight: 18 },
});
