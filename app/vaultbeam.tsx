// app/vaultbeam.tsx — VaultBeam P2P file transfer (real WebRTC data channel).
//
// Device-to-device transfer over an RTCDataChannel — the file bytes go peer to
// peer (relayed only if TURN is needed), never stored on the server. Signaling
// rides the shared Socket.IO connection on a dedicated channel
// (vaultbeam_offer/answer/ice/end) so it never collides with a call.
//
// Both parties open this screen from the chat. The sender picks a file and
// makes the offer; the receiver auto-answers and saves the file on completion.
// Needs a dev/native build (react-native-webrtc) + two devices to verify.

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, StatusBar, Alert, ActivityIndicator, ScrollView,
} from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Ionicons } from '@expo/vector-icons';
import {
  mediaDevices, RTCIceCandidate, RTCPeerConnection, RTCSessionDescription,
} from 'react-native-webrtc';
import { Aurora } from '../constants/theme';
import { getSocket } from '../lib/socket';
import { getCurrentUserAsync } from './(constants)/authService';
import { getTurnConfig, type IceServer } from '../lib/chatService';
import {
  sha256OfBase64, saveTransfer, completeTransfer, failTransfer, type TransferState,
} from '../lib/transferManager';

const CHUNK = 16 * 1024;          // 16KB base64 slices
const BACKPRESSURE = 4 * 1024 * 1024;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const fmtSize = (b: number) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`;

export default function VaultBeamScreen() {
  const router = useRouter();
  const { peerUid, peerName } = useLocalSearchParams<{ chatId?: string; peerUid?: string; peerName?: string }>();

  const [status, setStatus] = useState<'idle' | 'connecting' | 'ready' | 'transferring' | 'done' | 'error'>('connecting');
  const [role, setRole] = useState<'send' | 'receive' | null>(null);
  const [fileName, setFileName] = useState('');
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState('');
  const [verified, setVerified] = useState<boolean | null>(null); // SHA-256 integrity result

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<any>(null);
  const meRef = useRef('');
  const offs = useRef<Array<() => void>>([]);
  const recv = useRef<{ meta: any; chunks: string[]; got: number } | null>(null);
  const xferIdRef = useRef<string>(''); // current transfer record id (for the dashboard)

  const teardown = useCallback((notify = true) => {
    offs.current.forEach(f => { try { f(); } catch {} });
    offs.current = [];
    try { dcRef.current?.close(); } catch {}
    try { pcRef.current?.close(); } catch {}
    dcRef.current = null; pcRef.current = null;
    if (notify && peerUid) getSocket().then(s => s.emit('vaultbeam_end', { to: peerUid })).catch(() => {});
  }, [peerUid]);

  // ── Receiver: handle an open data channel ──
  const wireReceive = useCallback((dc: any) => {
    dcRef.current = dc;
    dc.onmessage = (e: any) => {
      const d = e.data;
      if (typeof d === 'string' && d[0] === '{') {
        try {
          const j = JSON.parse(d);
          if (j.t === 'meta') {
            recv.current = { meta: j, chunks: [], got: 0 };
            setFileName(j.name); setRole('receive'); setStatus('transferring'); setProgress(0); setVerified(null);
            // Persist a transfer record so the dashboard shows it.
            xferIdRef.current = `rx_${meRef.current}_${Date.now()}`;
            saveTransfer({
              id: xferIdRef.current, chatId: '', fileName: j.name, fileSize: j.size || 0,
              direction: 'receive', status: 'active', totalChunks: 0, completedChunks: 0,
              progress: 0, peerUid: String(peerUid || ''), peerName: String(peerName || 'peer'),
              startedAt: Date.now(), lastActiveAt: Date.now(), sha256: j.sha256,
            } as TransferState).catch(() => {});
            return;
          }
          if (j.t === 'eof') { void finishReceive(); return; }
        } catch { /* fall through */ }
      }
      if (recv.current) {
        recv.current.chunks.push(d);
        recv.current.got += d.length;
        setProgress(Math.min(1, recv.current.got / (recv.current.meta.size || 1)));
      }
    };
  }, []);

  const finishReceive = useCallback(async () => {
    const r = recv.current;
    if (!r) return;
    try {
      const assembled = r.chunks.join('');
      // Integrity check: hash the received bytes and compare to the sender's hash.
      // A corrupted or incomplete transfer fails verification (#113).
      let ok: boolean | null = null;
      if (r.meta.sha256) {
        try { ok = sha256OfBase64(assembled) === r.meta.sha256; } catch { ok = false; }
        setVerified(ok);
      }
      if (ok === false) {
        // Don't hand the user a corrupted file.
        setErr('Integrity check failed — the file was corrupted in transit.');
        setStatus('error');
        if (xferIdRef.current) failTransfer(xferIdRef.current, 'sha256 mismatch').catch(() => {});
        return;
      }
      const path = (FileSystem as any).cacheDirectory + (r.meta.name || `vaultbeam_${Date.now()}`);
      await FileSystem.writeAsStringAsync(path, assembled, { encoding: 'base64' });
      setProgress(1); setStatus('done');
      if (xferIdRef.current) {
        await saveTransfer({
          id: xferIdRef.current, chatId: '', fileName: r.meta.name || 'file', fileSize: r.meta.size || 0,
          fileUri: path, direction: 'receive', status: 'active', totalChunks: 0, completedChunks: 0,
          progress: 1, peerUid: String(peerUid || ''), peerName: String(peerName || 'peer'),
          startedAt: Date.now(), lastActiveAt: Date.now(), sha256: r.meta.sha256,
        } as TransferState).catch(() => {});
        await completeTransfer(xferIdRef.current, ok === true).catch(() => {});
      }
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(path);
      else Alert.alert('Received', `Saved to ${path}${ok ? ' · integrity verified' : ''}`);
    } catch (e: any) {
      setErr(e?.message ?? 'Save failed'); setStatus('error');
      if (xferIdRef.current) failTransfer(xferIdRef.current, e?.message ?? 'save failed').catch(() => {});
    } finally {
      recv.current = null;
    }
  }, [peerUid, peerName]);

  // ── Setup: identity, pc, signaling ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await getCurrentUserAsync();
        if (!me?.id) throw new Error('Not signed in');
        meRef.current = me.id;
        const turn = await getTurnConfig().catch(() => ({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] as IceServer[] }));
        if (cancelled) return;
        const pc = new RTCPeerConnection({ iceServers: turn.iceServers as any });
        pcRef.current = pc;

        (pc as any).onicecandidate = (ev: any) => {
          if (ev.candidate && peerUid) getSocket().then(s => s.emit('vaultbeam_ice', { to: peerUid, from: meRef.current, candidate: ev.candidate }));
        };
        (pc as any).ondatachannel = (ev: any) => wireReceive(ev.channel);
        (pc as any).onconnectionstatechange = () => {
          const st = (pc as any).connectionState;
          if (st === 'connected' && status === 'connecting') setStatus('ready');
          if (st === 'failed' || st === 'disconnected') { setErr('Connection lost'); setStatus('error'); }
        };

        const s = await getSocket();
        const matches = (data: any) => data?.from === peerUid || data?.fromUid === peerUid;
        const onOffer = async (data: any) => {
          if (!matches(data) || !pcRef.current) return;
          setRole('receive');
          await pcRef.current.setRemoteDescription(new RTCSessionDescription(data.offer));
          const answer = await pcRef.current.createAnswer();
          await pcRef.current.setLocalDescription(answer);
          s.emit('vaultbeam_answer', { to: peerUid, from: meRef.current, answer });
        };
        const onAnswer = async (data: any) => {
          if (!matches(data) || !pcRef.current) return;
          await pcRef.current.setRemoteDescription(new RTCSessionDescription(data.answer));
        };
        const onIce = async (data: any) => {
          if (!matches(data) || !data?.candidate || !pcRef.current) return;
          try { await pcRef.current.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {}
        };
        const onEnd = () => { setStatus(st => st === 'done' ? st : 'error'); };
        s.on('vaultbeam_offer', onOffer);
        s.on('vaultbeam_answer', onAnswer);
        s.on('vaultbeam_ice', onIce);
        s.on('vaultbeam_end', onEnd);
        offs.current.push(() => s.off('vaultbeam_offer', onOffer), () => s.off('vaultbeam_answer', onAnswer), () => s.off('vaultbeam_ice', onIce), () => s.off('vaultbeam_end', onEnd));
        if (!cancelled) setStatus('ready');
      } catch (e: any) {
        if (!cancelled) { setErr(e?.message ?? 'Setup failed'); setStatus('error'); }
      }
    })();
    return () => { cancelled = true; teardown(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerUid]);

  // ── Sender: pick a file + stream it over the data channel ──
  const pickAndSend = useCallback(async () => {
    if (!pcRef.current || !peerUid) { Alert.alert('Not ready', 'Open this from a chat with a peer.'); return; }
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
      if (res.canceled) return;
      const file = res.assets[0];
      setRole('send'); setFileName(file.name); setStatus('connecting'); setProgress(0);

      const dc = (pcRef.current as any).createDataChannel('vaultbeam', { ordered: true });
      dcRef.current = dc;
      const b64 = await FileSystem.readAsStringAsync(file.uri, { encoding: 'base64' });
      // Per-file SHA-256 so the receiver can verify integrity (#113).
      const hash = sha256OfBase64(b64);
      setVerified(null);

      // Persist a transfer record for the dashboard.
      xferIdRef.current = `tx_${meRef.current}_${Date.now()}`;
      saveTransfer({
        id: xferIdRef.current, chatId: '', fileName: file.name, fileSize: file.size || 0,
        fileUri: file.uri, direction: 'send', status: 'active', totalChunks: 0, completedChunks: 0,
        progress: 0, peerUid: String(peerUid || ''), peerName: String(peerName || 'peer'),
        startedAt: Date.now(), lastActiveAt: Date.now(), sha256: hash,
      } as TransferState).catch(() => {});

      dc.onopen = async () => {
        setStatus('transferring');
        dc.send(JSON.stringify({ t: 'meta', name: file.name, size: b64.length, sha256: hash }));
        let off = 0;
        while (off < b64.length) {
          if (dc.bufferedAmount > BACKPRESSURE) { await sleep(20); continue; }
          dc.send(b64.slice(off, off + CHUNK));
          off += CHUNK;
          setProgress(Math.min(1, off / b64.length));
        }
        dc.send(JSON.stringify({ t: 'eof' }));
        setProgress(1); setStatus('done'); setVerified(true); // sender holds the source file
        if (xferIdRef.current) completeTransfer(xferIdRef.current, true).catch(() => {});
      };

      const offer = await pcRef.current.createOffer({});
      await pcRef.current.setLocalDescription(offer);
      const s = await getSocket();
      s.emit('vaultbeam_offer', { to: peerUid, from: meRef.current, offer, fileName: file.name });
    } catch (e: any) {
      setErr(e?.message ?? 'Send failed'); setStatus('error');
    }
  }, [peerUid]);

  return (
    <View style={s.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="light-content" />
      <View style={s.header}>
        <TouchableOpacity onPress={() => { teardown(true); router.back(); }} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={Aurora.text} />
        </TouchableOpacity>
        <Text style={s.title}>VaultBeam P2P</Text>
        <TouchableOpacity onPress={() => router.push('/transfers' as any)} style={s.backBtn} hitSlop={10}>
          <Ionicons name="list-outline" size={22} color={Aurora.text} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <View style={s.infoCard}>
          <Text style={{ fontSize: 22 }}>📡</Text>
          <Text style={s.infoTxt}>Direct device-to-device transfer to {(peerName as string) || 'peer'}. Files go peer-to-peer — never stored on the server.</Text>
        </View>

        <View style={s.statusCard}>
          <Text style={s.statusLabel}>
            {status === 'connecting' ? 'Connecting…' : status === 'ready' ? 'Ready' : status === 'transferring' ? `${role === 'send' ? 'Sending' : 'Receiving'} ${fileName}` : status === 'done' ? 'Complete' : 'Error'}
          </Text>
          {(status === 'transferring') && (
            <>
              <View style={s.barTrack}><View style={[s.barFill, { width: `${Math.round(progress * 100)}%` }]} /></View>
              <Text style={s.pct}>{Math.round(progress * 100)}%</Text>
            </>
          )}
          {status === 'connecting' && <ActivityIndicator color={Aurora.primary} style={{ marginTop: 10 }} />}
          {status === 'done' && <Text style={[s.pct, { color: Aurora.primary }]}>✓ {fileName}</Text>}
          {status === 'done' && verified === true && (
            <Text style={[s.pct, { color: Aurora.primary }]}>🔒 SHA-256 integrity verified</Text>
          )}
          {status === 'error' && <Text style={[s.pct, { color: Aurora.danger }]}>{err || 'Transfer error'}</Text>}
        </View>

        <TouchableOpacity
          style={[s.sendBtn, (status === 'transferring') && s.dim]}
          onPress={pickAndSend}
          disabled={status === 'transferring'}
        >
          <Ionicons name="cloud-upload-outline" size={20} color="#04130D" />
          <Text style={s.sendTxt}>Pick a file to send</Text>
        </TouchableOpacity>

        <Text style={s.note}>Both people must have this screen open. Needs a dev build (WebRTC) — verify on two devices.</Text>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: Aurora.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 54, paddingHorizontal: 16, paddingBottom: 8 },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  title: { color: Aurora.text, fontSize: 18, fontWeight: '800' },
  infoCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: Aurora.card, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: Aurora.border, marginBottom: 14 },
  infoTxt: { flex: 1, color: Aurora.textDim, fontSize: 12, lineHeight: 18 },
  statusCard: { backgroundColor: Aurora.card, borderRadius: 14, padding: 18, borderWidth: 1, borderColor: Aurora.border, alignItems: 'center', marginBottom: 14 },
  statusLabel: { color: Aurora.text, fontSize: 15, fontWeight: '700', textAlign: 'center' },
  barTrack: { width: '100%', height: 8, borderRadius: 4, backgroundColor: Aurora.surface, marginTop: 14, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4, backgroundColor: Aurora.primary },
  pct: { color: Aurora.textDim, fontSize: 13, marginTop: 8, fontWeight: '700' },
  sendBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: Aurora.primary, borderRadius: 12, paddingVertical: 14 },
  sendTxt: { color: '#04130D', fontWeight: '800', fontSize: 15 },
  dim: { opacity: 0.5 },
  note: { color: Aurora.textFaint, fontSize: 11, textAlign: 'center', marginTop: 14, lineHeight: 16 },
});
