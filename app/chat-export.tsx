// @ts-nocheck
// app/chat-export.tsx — Export Chat as Text/HTML
// Pulls messages from Firestore, formats, shares via system share sheet
// Options: Text, HTML with styling

import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  StatusBar, Alert, ActivityIndicator, Share,
} from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

const C = { bg: '#020B18', accent: '#4A9FFF', green: '#10B981', card: '#0A1628' };

export default function ChatExportScreen() {
  const { chatId, peerName } = useLocalSearchParams();
  const myUid = auth().currentUser?.uid || '';
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState('');
  const [msgCount, setMsgCount] = useState(0);

  const fetchMessages = async () => {
    const snap = await firestore().collection('chats').doc(chatId)
      .collection('messages')
      .orderBy('createdAt', 'asc')
      .get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  };

  const formatTime = (ts) => {
    if (!ts?.toDate) return '';
    return ts.toDate().toLocaleString();
  };

  const exportAsText = async () => {
    setExporting(true);
    setProgress('Fetching messages...');
    try {
      const msgs = await fetchMessages();
      setMsgCount(msgs.length);
      setProgress('Formatting ' + msgs.length + ' messages...');

      let text = 'VaultChat Export - ' + (peerName || 'Chat') + '\n';
      text += 'Exported: ' + new Date().toLocaleString() + '\n';
      text += 'Messages: ' + msgs.length + '\n';
      text += '='.repeat(50) + '\n\n';

      for (const msg of msgs) {
        const sender = msg.senderId === myUid ? 'You' : (peerName || 'Peer');
        const time = formatTime(msg.createdAt);
        const type = msg.msgType || 'text';

        if (type === 'text') {
          text += '[' + time + '] ' + sender + ': ' + (msg.plaintext || msg.ciphertext || '[encrypted]') + '\n';
        } else if (type === 'image') {
          text += '[' + time + '] ' + sender + ': [Image] ' + (msg.mediaUrl || '') + '\n';
        } else if (type === 'video') {
          text += '[' + time + '] ' + sender + ': [Video] ' + (msg.filename || '') + '\n';
        } else if (type === 'audio') {
          text += '[' + time + '] ' + sender + ': [Audio ' + (msg.audioDuration || '') + 's]\n';
        } else if (type === 'file') {
          text += '[' + time + '] ' + sender + ': [File] ' + (msg.filename || '') + '\n';
        } else if (type === 'poll') {
          text += '[' + time + '] ' + sender + ': [Poll] ' + (msg.pollData?.question || '') + '\n';
        } else {
          text += '[' + time + '] ' + sender + ': [' + type + ']\n';
        }

        if (msg.isForwarded) text += '  (Forwarded)\n';
        if (msg.isEdited) text += '  (Edited)\n';
        if (msg.isDeleted) text += '  (Deleted)\n';
      }

      setProgress('Saving file...');
      const filename = 'VaultChat_' + (peerName || 'chat').replace(/[^a-zA-Z0-9]/g, '_') + '_' + Date.now() + '.txt';
      const filePath = FileSystem.documentDirectory + filename;
      await FileSystem.writeAsStringAsync(filePath, text, { encoding: FileSystem.EncodingType.UTF8 });

      setProgress('');
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(filePath, { mimeType: 'text/plain' });
      } else {
        await Share.share({ message: text });
      }
    } catch (e) { Alert.alert('Export Failed', e.message); }
    setExporting(false);
  };

  const exportAsHTML = async () => {
    setExporting(true);
    setProgress('Fetching messages...');
    try {
      const msgs = await fetchMessages();
      setMsgCount(msgs.length);
      setProgress('Building HTML...');

      let html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>VaultChat Export</title>';
      html += '<style>body{font-family:-apple-system,sans-serif;background:#03030E;color:#E0E0F0;max-width:600px;margin:0 auto;padding:16px}';
      html += '.header{text-align:center;padding:20px;border-bottom:1px solid #222;margin-bottom:20px}';
      html += '.header h1{color:#4A9FFF;margin:0}.header p{color:#666;font-size:12px}';
      html += '.msg{margin:4px 0;padding:8px 12px;border-radius:14px;max-width:80%}';
      html += '.mine{background:#003D2A;margin-left:auto;border-bottom-right-radius:2px}';
      html += '.peer{background:#111127;margin-right:auto;border-bottom-left-radius:2px}';
      html += '.time{color:#555;font-size:10px;margin-top:4px;text-align:right}';
      html += '.sender{color:#4A9FFF;font-size:11px;font-weight:700;margin-bottom:2px}';
      html += '.meta{color:#666;font-size:10px;font-style:italic}';
      html += '</style></head><body>';
      html += '<div class="header"><h1>VaultChat</h1><p>Chat with ' + (peerName || 'Unknown') + '</p>';
      html += '<p>' + msgs.length + ' messages | Exported ' + new Date().toLocaleString() + '</p></div>';

      for (const msg of msgs) {
        const isMine = msg.senderId === myUid;
        const cls = isMine ? 'mine' : 'peer';
        const sender = isMine ? 'You' : (peerName || 'Peer');
        const type = msg.msgType || 'text';

        html += '<div class="msg ' + cls + '">';
        if (!isMine) html += '<div class="sender">' + sender + '</div>';

        if (type === 'text') {
          html += '<div>' + (msg.plaintext || msg.ciphertext || '[encrypted]').replace(/</g, '&lt;').replace(/\n/g, '<br>') + '</div>';
        } else if (type === 'image' && msg.mediaUrl) {
          html += '<div>[Image]</div>';
        } else if (type === 'video') {
          html += '<div>[Video: ' + (msg.filename || 'video') + ']</div>';
        } else if (type === 'audio') {
          html += '<div>[Audio ' + (msg.audioDuration || '?') + 's]</div>';
        } else if (type === 'file') {
          html += '<div>[File: ' + (msg.filename || 'file') + ']</div>';
        } else if (type === 'poll') {
          html += '<div>[Poll: ' + (msg.pollData?.question || '') + ']</div>';
        } else {
          html += '<div>[' + type + ']</div>';
        }

        html += '<div class="time">' + formatTime(msg.createdAt) + '</div>';
        if (msg.isEdited) html += '<div class="meta">(edited)</div>';
        if (msg.isForwarded) html += '<div class="meta">(forwarded)</div>';
        html += '</div>';
      }

      html += '</body></html>';

      setProgress('Saving...');
      const filename = 'VaultChat_' + (peerName || 'chat').replace(/[^a-zA-Z0-9]/g, '_') + '_' + Date.now() + '.html';
      const filePath = FileSystem.documentDirectory + filename;
      await FileSystem.writeAsStringAsync(filePath, html, { encoding: FileSystem.EncodingType.UTF8 });

      setProgress('');
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(filePath, { mimeType: 'text/html' });
      }
    } catch (e) { Alert.alert('Export Failed', e.message); }
    setExporting(false);
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Export Chat', headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff' }} />
      <View style={s.container}>
        <StatusBar barStyle="light-content" />

        <View style={s.infoCard}>
          <Text style={{ fontSize: 28 }}>{"\uD83D\uDCE4"}</Text>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={s.infoTitle}>Export {peerName || 'Chat'}</Text>
            <Text style={s.infoDesc}>Save your conversation as a file you can share or keep as backup.</Text>
          </View>
        </View>

        <TouchableOpacity style={s.exportBtn} onPress={exportAsText} disabled={exporting}>
          <View style={s.exportIcon}><Text style={{ fontSize: 24 }}>{"\uD83D\uDCC4"}</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={s.exportTitle}>Export as Text</Text>
            <Text style={s.exportDesc}>Plain text file (.txt) — lightweight, universal</Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity style={s.exportBtn} onPress={exportAsHTML} disabled={exporting}>
          <View style={s.exportIcon}><Text style={{ fontSize: 24 }}>{"\uD83C\uDF10"}</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={s.exportTitle}>Export as HTML</Text>
            <Text style={s.exportDesc}>Styled web page (.html) — looks like real chat</Text>
          </View>
        </TouchableOpacity>

        {exporting && (
          <View style={s.progressBox}>
            <ActivityIndicator color={C.accent} />
            <Text style={s.progressTxt}>{progress}</Text>
            {msgCount > 0 && <Text style={s.progressCount}>{msgCount} messages</Text>}
          </View>
        )}

        <View style={s.noteBox}>
          <Text style={s.noteTitle}>Privacy Note</Text>
          <Text style={s.noteDesc}>Exported files are NOT encrypted. Only export chats you&apos;re comfortable saving in plain text. The export happens entirely on your device.</Text>
        </View>
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, padding: 16 },
  infoCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 14, padding: 16, marginBottom: 20, borderWidth: 1, borderColor: '#111' },
  infoTitle: { color: '#fff', fontSize: 16, fontWeight: '800' },
  infoDesc: { color: '#666', fontSize: 12, marginTop: 2 },
  exportBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 14, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: '#111' },
  exportIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#111', justifyContent: 'center', alignItems: 'center', marginRight: 14 },
  exportTitle: { color: '#E0E0F0', fontSize: 15, fontWeight: '700' },
  exportDesc: { color: '#666', fontSize: 12, marginTop: 2 },
  progressBox: { alignItems: 'center', padding: 20, marginTop: 10 },
  progressTxt: { color: '#888', fontSize: 13, marginTop: 8 },
  progressCount: { color: '#555', fontSize: 11, marginTop: 4 },
  noteBox: { marginTop: 24, backgroundColor: '#FF3C6E10', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#FF3C6E22' },
  noteTitle: { color: '#FF3C6E', fontSize: 12, fontWeight: '800', marginBottom: 4 },
  noteDesc: { color: '#888', fontSize: 11, lineHeight: 18 },
});
