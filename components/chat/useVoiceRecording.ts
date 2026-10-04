// components/chat/useVoiceRecording.ts — the composer's voice-message flow:
// start, the elapsed-time ticker, discard, and stop-and-send through the media
// outbox. Moved out of app/chat.tsx unchanged; the recording state is local to
// it, `sending` and the enqueue stay the screen's.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import type { MediaType } from '../../lib/sendMedia';
import {
  cancel as recCancel,
  elapsedMs as recElapsed,
  isActive as recIsActive,
  start as recStart,
  stop as recStop,
} from '../../lib/voiceRecorder';

type Enqueue = (
  type: MediaType,
  file: { uri: string; filename: string; mime: string },
  opts?: { caption?: string; viewOnce?: boolean; metaExtra?: Record<string, any> },
) => Promise<void>;

export function useVoiceRecording({ sending, setSending, editingId, enqueueMediaOptimistic }: {
  sending: boolean;
  setSending: (v: boolean) => void;
  editingId: number | null;
  enqueueMediaOptimistic: Enqueue;
}) {
  const [recording, setRecording] = useState(false);
  const [recElapsedMs, setRecElapsedMs] = useState(0);
  const recTimerRef = useRef<any>(null);

  // ── Voice message: start / stop / cancel ─────────────────
  const startRecording = useCallback(async () => {
    if (recording || recIsActive() || sending || editingId != null) return;
    try {
      await recStart();
      setRecording(true);
      setRecElapsedMs(0);
      recTimerRef.current = setInterval(() => setRecElapsedMs(recElapsed()), 200);
    } catch (e: any) {
      Alert.alert('Cannot record', e?.message ?? 'Microphone unavailable');
    }
  }, [recording, sending, editingId]);

  const cancelRecording = useCallback(async () => {
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
    setRecording(false);
    setRecElapsedMs(0);
    try { await recCancel(); } catch {}
  }, []);

  const stopAndSendRecording = useCallback(async () => {
    if (!recording) return;
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
    setRecording(false);
    setSending(true);
    try {
      const r = await recStop();
      if (!r) { setSending(false); return; }
      // Minimum 500ms to count as a real voice message (avoid stray taps).
      if (r.durationMs < 500) {
        setSending(false);
        setRecElapsedMs(0);
        Alert.alert('Too short', 'Record for at least half a second to send a voice message.');
        return;
      }
      await enqueueMediaOptimistic('audio',
        { uri: r.uri, filename: r.filename, mime: r.mime },
        // Pre-computed 0..1 amplitude bars (length up to 32) so the bubble
        // renders without re-parsing the audio file.
        { metaExtra: { durationMs: r.durationMs, waveform: r.waveform } },
      );
      setRecElapsedMs(0);
    } catch (e: any) {
      Alert.alert('Voice send failed', e?.message ?? 'Try again');
    } finally {
      setSending(false);
    }
  }, [recording, enqueueMediaOptimistic, setSending]);

  // Clean up the timer + any active recording on unmount
  useEffect(() => {
    return () => {
      if (recTimerRef.current) clearInterval(recTimerRef.current);
      if (recIsActive()) recCancel().catch(() => {});
    };
  }, []);

  return { recording, recElapsedMs, startRecording, cancelRecording, stopAndSendRecording };
}
