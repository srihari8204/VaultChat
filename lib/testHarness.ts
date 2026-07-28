// ================================================================
// lib/testHarness.ts — Multi-user parallel test runner
// Runs on device — simulates parallel users via Socket.io
// ================================================================
const getSocket = () => null; // stub
const encrypt = (d: any) => d; const generateKey = () => ''; // stubs
import { BRAND_ACCENT } from '../constants/theme';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type TestUser = {
  name: string; vaultId: string; sessionKey: string;
  msgSent: number; msgReceived: number; errors: string[];
  latencies: number[]; connected: boolean;
};

export type TestResult = {
  totalSent: number; totalReceived: number; totalErrors: number;
  avgLatencyMs: number; maxLatencyMs: number; minLatencyMs: number;
  deliveryRate: number; duration: number; users: TestUser[];
};

export type TestConfig = {
  userCount: number;
  messagesPerUser: number;
  intervalMs: number;
  testType: 'round_robin' | 'random' | 'broadcast' | 'stress';
  serverUrl: string;
};

// ── Run a full parallel multi-user test ──────────────────────────
export async function runParallelTest(
  config: TestConfig,
  onProgress: (pct: number, log: string) => void
): Promise<TestResult> {
  const { userCount, messagesPerUser, intervalMs, testType, serverUrl } = config;
  const startTime = Date.now();
  const users: TestUser[] = [];

  onProgress(0, `Initialising ${userCount} test users...`);

  // Create test users
  for (let i = 0; i < userCount; i++) {
    const name = ['Alice','Bob','Charlie','Diana','Eve','Frank','Grace','Henry','Iris','Jack'][i] || `User${i+1}`;
    const vaultId = `VC-TEST-${name.toUpperCase().slice(0,4)}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
    try {
      await fetch(`${serverUrl}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, vaultId }),
      });
    } catch {}
    users.push({
      name, vaultId, sessionKey: generateKey(),
      msgSent: 0, msgReceived: 0, errors: [],
      latencies: [], connected: false,
    });
  }

  onProgress(10, `${userCount} users registered. Connecting sockets...`);

  // Connect sockets for each user
  const { io } = await import('socket.io-client');
  const sockets = users.map((u, i) => {
    const s = io(serverUrl, { transports: ['websocket'], forceNew: true });
    s.on('connect', () => {
      s.emit('identify', { vaultId: u.vaultId });
      u.connected = true;
    });
    s.on('message', (msg: any) => {
      u.msgReceived++;
    });
    s.on('disconnect', () => { u.connected = false; });
    return s;
  });

  // Wait for all connections
  await new Promise(r => setTimeout(r, 1500));
  const connectedCount = users.filter(u => u.connected).length;
  onProgress(20, `${connectedCount}/${userCount} users connected.`);

  // Run test
  const totalMessages = userCount * messagesPerUser;
  let sent = 0;

  await new Promise<void>((resolve) => {
    let userIdx = 0;
    const interval = setInterval(async () => {
      if (sent >= totalMessages) { clearInterval(interval); resolve(); return; }

      const fromUser = users[userIdx % userCount];
      let toUser: TestUser;

      if (testType === 'round_robin') {
        toUser = users[(userIdx + 1) % userCount];
      } else if (testType === 'broadcast') {
        users.forEach((target, ti) => {
          if (ti !== userIdx % userCount) {
            const msgContent = `Broadcast from ${fromUser.name} #${sent}`;
            try {
              const { ciphertext, iv, tag } = encrypt(msgContent, fromUser.sessionKey);
              sockets[userIdx % userCount].emit('send_message', {
                to: target.vaultId,
                encrypted: { ciphertext, iv, tag },
                msgId: Math.random().toString(36).slice(2),
              });
              fromUser.msgSent++;
            } catch (e: any) { fromUser.errors.push(e.message); }
          }
        });
        sent++;
        userIdx++;
        const pct = 20 + Math.round((sent / totalMessages) * 75);
        onProgress(pct, `${sent}/${totalMessages} messages sent`);
        return;
      } else {
        const rIdx = Math.floor(Math.random() * userCount);
        toUser = users[rIdx === userIdx % userCount ? (rIdx + 1) % userCount : rIdx];
      }

      const msgContent = `Test msg #${sent + 1} from ${fromUser.name} to ${toUser.name}`;
      const tStart = Date.now();

      try {
        const { ciphertext, iv, tag } = encrypt(msgContent, fromUser.sessionKey);
        sockets[userIdx % userCount].emit('send_message', {
          to: toUser.vaultId,
          encrypted: { ciphertext, iv, tag },
          msgId: Math.random().toString(36).slice(2),
        });
        fromUser.msgSent++;
        fromUser.latencies.push(Date.now() - tStart);
      } catch (e: any) {
        fromUser.errors.push(e.message);
      }

      sent++;
      userIdx++;
      const pct = 20 + Math.round((sent / totalMessages) * 75);
      onProgress(pct, `${sent}/${totalMessages} messages sent`);
    }, intervalMs);
  });

  // Wait for delivery
  await new Promise(r => setTimeout(r, 2000));
  onProgress(98, 'Collecting results...');

  // Disconnect
  sockets.forEach(s => s.disconnect());

  // Calculate results
  const allLatencies = users.flatMap(u => u.latencies);
  const totalSent     = users.reduce((s, u) => s + u.msgSent,     0);
  const totalReceived = users.reduce((s, u) => s + u.msgReceived, 0);
  const totalErrors   = users.reduce((s, u) => s + u.errors.length, 0);
  const avgLatency    = allLatencies.length ? allLatencies.reduce((a,b)=>a+b,0)/allLatencies.length : 0;
  const maxLatency    = allLatencies.length ? Math.max(...allLatencies) : 0;
  const minLatency    = allLatencies.length ? Math.min(...allLatencies) : 0;

  const result: TestResult = {
    totalSent, totalReceived, totalErrors,
    avgLatencyMs: Math.round(avgLatency),
    maxLatencyMs: maxLatency,
    minLatencyMs: minLatency,
    deliveryRate: totalSent > 0 ? Math.round((totalReceived / totalSent) * 100) : 0,
    duration: Date.now() - startTime,
    users,
  };

  await AsyncStorage.setItem('lastTestResult', JSON.stringify(result));
  onProgress(100, 'Test complete.');
  return result;
}

// ================================================================
// app/testconsole.tsx — In-app test console screen
// ================================================================
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import {
  Animated, ScrollView, StyleSheet, Text,
  TextInput, TouchableOpacity, View,
} from 'react-native';
// removed circular import

const C = {
  bg:'#020B18', primary:'#4A9FFF', accent:BRAND_ACCENT,
  yellow:'#F59E0B', red:'#EF4444', violet:'#7C3AED',
  card:'rgba(10,22,40,0.88)', border:'rgba(74,159,255,0.14)',
  dim:'rgba(255,255,255,0.5)', faint:'rgba(255,255,255,0.18)',
};

