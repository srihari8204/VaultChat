// components/spaces/DriverSos.tsx — the driver screen's emergency alert after
// the press: kept on the phone until the office has it, and said on screen
// until then (app/space-run-driver.tsx).
//
// The panic button used to retry only while its Alert was open: a driver who
// dismissed it, or whose app was closed, lost the alert. The storage and the
// sending are lib/spaces/sosOutbox (rules: lib/spaces/sosQueue); this is the
// screen's view of it.

import React, { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { View, StyleSheet, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { AppText as Text } from '../ui/Text';
import type { SpacePalette as Palette } from '../../lib/spaces/theme';
import { fileIncident } from '../../lib/spaces/api';
import { queueSos, flushSos, sosForThisRun, dismissSos, onSosQueueChange } from '../../lib/spaces/sosOutbox';
import type { PendingSos } from '../../lib/spaces/sosQueue';

/** How often the driver screen retries an alert that has not gone yet; the
 *  app-wide beat (lib/spaces/deviceAgent) is every 2 minutes. */
const SOS_RETRY_MS = 30_000;

export function useDriverSos(spaceId: string, runId: string, myId: MutableRefObject<string>) {
  // This driver's alerts on this run that the server does not have yet.
  const [queue, setQueue] = useState<PendingSos[]>([]);
  const refresh = useCallback(() => {
    sosForThisRun(spaceId, runId).then(setQueue).catch(() => {});
  }, [spaceId, runId]);
  useEffect(() => { refresh(); return onSosQueueChange(refresh); }, [refresh]);
  const waiting = queue.filter((e) => !e.dead);
  const dead = queue.filter((e) => !!e.dead);
  const hasWaiting = waiting.length > 0;

  useFocusEffect(useCallback(() => {
    if (!hasWaiting) return;
    const t = setInterval(() => { void flushSos(); }, SOS_RETRY_MS);
    return () => clearInterval(t);
  }, [hasWaiting]));

  // Say so when a waiting alert finally reaches the office. `told`: alerts the
  // driver has seen as waiting (banner or "not sent yet"); `announced`: alerts
  // already confirmed as sent, so one delivery is never confirmed twice.
  const told = useRef(new Set<string>());
  const announced = useRef(new Set<string>());
  const confirmSent = useCallback((id: string) => {
    if (announced.current.has(id)) return;
    announced.current.add(id);
    Alert.alert('Alert sent', 'The office has your emergency alert.');
  }, []);
  useEffect(() => {
    const present = new Map(queue.map((e) => [e.id, e]));
    for (const id of [...told.current]) {
      const e = present.get(id);
      if (!e) { told.current.delete(id); confirmSent(id); } else if (e.dead) told.current.delete(id);
    }
    for (const e of queue) if (!e.dead) told.current.add(e.id);
  }, [queue, confirmSent]);

  const [retrying, setRetrying] = useState(false);
  const retryNow = useCallback(async () => {
    setRetrying(true);
    try { await flushSos(); } finally { setRetrying(false); }
  }, []);

  /** After the driver confirmed the panic control. */
  const sendSos = useCallback(async () => {
    // The phone could not keep it: send it straight away, with the one-tap
    // retry, as before the outbox existed.
    const direct = (): void => {
      fileIncident(spaceId, { category: 'sos', runId, note: '' })
        .then(() => Alert.alert('Alert sent', 'The office has been alerted.'))
        .catch(() => Alert.alert(
          'Alert not sent yet',
          'It is raised on this device, but the office has not received it, and this phone could not keep it to retry later. Try again when you have signal.',
          [{ text: 'Later', style: 'cancel' }, { text: 'Try again', onPress: direct }],
        ));
    };
    let r: Awaited<ReturnType<typeof queueSos>>;
    try { r = await queueSos(spaceId, runId, myId.current); } catch { direct(); return; }
    if (r.sent) confirmSent(r.id);
    else if (r.dead) Alert.alert('Alert not accepted', `${r.dead} Call your transport office.`);
    else {
      told.current.add(r.id);
      Alert.alert(
        'Alert not sent yet',
        'It is raised on this device and kept on it. crazzychat keeps trying while it is open, '
        + 'including after a restart, and this screen shows it until the office has it.',
      );
    }
  }, [spaceId, runId, myId, confirmSent]);

  return { sendSos, waiting, dead, retrying, retryNow };
}

/** Emergency alerts not yet with the office: said, never silent. */
export function SosNotices({ sos, colors }: { sos: ReturnType<typeof useDriverSos>; colors: Palette }) {
  const s = useMemo(() => styles(colors), [colors]);
  const { waiting, dead, retrying, retryNow } = sos;
  return (
    <>
      {waiting.length > 0 && (
        <View style={s.notice} accessibilityLiveRegion="polite">
          <Ionicons name="alert-circle" size={18} color={colors.danger} />
          <Text style={s.text}>
            {waiting.length === 1 ? 'Your emergency alert has' : `${waiting.length} emergency alerts have`} not
            reached the office yet. crazzychat keeps trying while it is open.
          </Text>
          <TouchableOpacity
            style={s.btn} onPress={() => { void retryNow(); }} disabled={retrying}
            accessibilityRole="button" accessibilityLabel="Try sending the emergency alert now"
            accessibilityState={{ disabled: retrying, busy: retrying }}
          >
            {retrying ? <ActivityIndicator size="small" color={colors.primary} /> : <Text style={s.btnText}>Try now</Text>}
          </TouchableOpacity>
        </View>
      )}
      {dead.map((e) => (
        <View key={e.id} style={s.notice}>
          <Ionicons name="close-circle" size={18} color={colors.danger} />
          <Text style={s.text}>
            Emergency alert from {new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} was
            not delivered: {e.dead} Call your transport office.
          </Text>
          <TouchableOpacity
            style={s.btn} onPress={() => { void dismissSos(e.id); }}
            accessibilityRole="button" accessibilityLabel="Dismiss the undelivered alert notice"
          >
            <Text style={s.btnText}>Dismiss</Text>
          </TouchableOpacity>
        </View>
      ))}
    </>
  );
}

const styles = (c: Palette) => StyleSheet.create({
  // The driver screen's notice, outlined in danger: this one is about an emergency.
  notice: {
    flexDirection: 'row', gap: 8, alignItems: 'center', padding: 12, borderRadius: 10,
    backgroundColor: c.glassSoft, borderWidth: 1, borderColor: c.danger,
  },
  text: { color: c.text, flex: 1 },
  btn: { minHeight: 44, minWidth: 44, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' },
  btnText: { color: c.primary, fontWeight: '700' },
});
