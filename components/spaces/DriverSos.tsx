// components/spaces/DriverSos.tsx — the driver screen's emergency alert after
// the press: kept on the phone until the office has it, and said on screen
// until then (app/space-run-driver.tsx).
//
// The storage and the sending are lib/spaces/sosOutbox (rules:
// lib/spaces/sosQueue); this is the screen's view of it. "Alert sent" is said
// only from a 2xx for this press (PressResult `sent`, or the direct send's
// answer); a delivery by a later retry is said once, app-wide, by
// sosOutbox watchSosOutcomes. A list that cannot be read is "couldn't check",
// never "nothing waiting".

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, StyleSheet, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { useFocusEffect } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { Ionicons } from '@expo/vector-icons';
import { AppText as Text } from '../ui/Text';
import type { SpacePalette as Palette } from '../../lib/spaces/theme';
import {
  queueSos, flushSos, sendUnkept, sosForThisRun, dismissSos, withdrawSos, onSosQueueChange, SosNotKept,
} from '../../lib/spaces/sosOutbox';
import { clockOf, ageText, sentText, type PendingSos } from '../../lib/spaces/sosQueue';
import { errMsg } from '../../lib/spaces/errors';

/** How often the driver screen retries an alert that has not gone yet; the
 *  app-wide beat (lib/spaces/deviceAgent) is every 2 minutes. */
const SOS_RETRY_MS = 30_000;

export function useDriverSos(spaceId: string, runId: string) {
  // This driver's alerts on this run that the server does not have yet.
  const [queue, setQueue] = useState<PendingSos[]>([]);
  // The list or the account could not be read: the last list stays, and the
  // screen says it could not check.
  const [unchecked, setUnchecked] = useState(false);
  const refresh = useCallback(() => {
    sosForThisRun(spaceId, runId)
      .then((q) => { setQueue(q); setUnchecked(false); })
      .catch(() => setUnchecked(true));
  }, [spaceId, runId]);
  useEffect(() => { refresh(); return onSosQueueChange(refresh); }, [refresh]);
  const waiting = queue.filter((e) => !e.dead);
  const dead = queue.filter((e) => !!e.dead);
  const retryWanted = waiting.length > 0 || unchecked;

  // `now` re-renders the "N min ago" with each retry.
  const [now, setNow] = useState(() => Date.now());
  useFocusEffect(useCallback(() => {
    if (!retryWanted) return;
    const t = setInterval(() => { setNow(Date.now()); void flushSos().then(refresh); }, SOS_RETRY_MS);
    return () => clearInterval(t);
  }, [retryWanted, refresh]));

  const [retrying, setRetrying] = useState(false);
  const retryNow = useCallback(async () => {
    setRetrying(true);
    try { await flushSos(); } finally { setRetrying(false); setNow(Date.now()); refresh(); }
  }, [refresh]);

  /** After the driver confirmed the panic control. */
  const sendSos = useCallback(async () => {
    // The phone could not keep it (no known account, or storage failed): send
    // it once, straight away, with a one-tap retry under the same key.
    let key = { id: '', at: 0 };
    const direct = (): void => {
      sendUnkept(spaceId, runId, key)
        .then((r) => Alert.alert('Alert sent', sentText(!!(r && r.runEnded))))
        .catch((e: unknown) => Alert.alert(
          'Alert not sent yet',
          `The office has not received it${errMsg(e) ? ` (${errMsg(e)})` : ''}, and this phone could not keep it `
          + 'to retry later. Try again when you have signal, or call your transport office.',
          [{ text: 'Later', style: 'cancel' }, { text: 'Try again', onPress: direct }],
        ));
    };
    let r: Awaited<ReturnType<typeof queueSos>>;
    try { r = await queueSos(spaceId, runId); } catch (e) {
      key = e instanceof SosNotKept ? e.key : { id: Crypto.randomUUID(), at: Date.now() };
      direct();
      return;
    }
    refresh();
    if (r.kind === 'sent') Alert.alert('Alert sent', sentText(r.runEnded));
    else if (r.kind === 'dead') Alert.alert('Alert not accepted', `${r.why} Call your transport office.`);
    else if (r.reused) {
      Alert.alert(
        'Alert still waiting',
        `Your alert from ${clockOf(r.at)} has not reached the office yet, so no second alert was added: `
        + 'crazzychat tried it again now and keeps trying while it is open.',
      );
    } else {
      Alert.alert(
        'Alert not sent yet',
        'It is raised on this device and kept on it. crazzychat keeps trying while it is open, '
        + 'including after a restart, and this screen shows it until the office has it.',
      );
    }
  }, [spaceId, runId, refresh]);

  /** The driver takes back a waiting alert (e.g. already phoned the office). */
  const withdraw = useCallback((e: PendingSos) => {
    Alert.alert(
      'Withdraw this alert?',
      `Your alert from ${clockOf(e.at)} will not be sent. Call your transport office if you still need help.`,
      [
        { text: 'Keep trying', style: 'cancel' },
        {
          text: 'Withdraw', style: 'destructive',
          onPress: () => {
            withdrawSos(e.id).then(({ mayHaveGone }) => {
              if (mayHaveGone) {
                Alert.alert('Withdrawn', 'It was being sent at that moment, so the office may still receive it.');
              }
            }).catch(() => Alert.alert('Could not withdraw', 'This phone could not update the alert. It is still waiting; try again.'));
          },
        },
      ],
    );
  }, []);

  return { sendSos, waiting, dead, unchecked, retrying, retryNow, withdraw, now };
}

/** Emergency alerts not yet with the office: said, never silent. */
export function SosNotices({ sos, colors }: { sos: ReturnType<typeof useDriverSos>; colors: Palette }) {
  const s = useMemo(() => styles(colors), [colors]);
  const { waiting, dead, unchecked, retrying, retryNow, withdraw, now } = sos;
  const tryNow = (
    <TouchableOpacity
      style={s.btn} onPress={() => { void retryNow(); }} disabled={retrying}
      accessibilityRole="button" accessibilityLabel="Try sending the emergency alert now"
      accessibilityState={{ disabled: retrying, busy: retrying }}
    >
      {retrying ? <ActivityIndicator size="small" color={colors.primary} /> : <Text style={s.btnText}>Try now</Text>}
    </TouchableOpacity>
  );
  return (
    <>
      {unchecked && (
        <View style={s.notice} accessibilityLiveRegion="polite">
          <Ionicons name="help-circle" size={18} color={colors.danger} />
          <Text style={s.text}>Couldn’t check — your alert may still be waiting.</Text>
          {tryNow}
        </View>
      )}
      {waiting.map((e) => (
        <View key={e.id} style={s.notice} accessibilityLiveRegion="polite">
          <Ionicons name="alert-circle" size={18} color={colors.danger} />
          <Text style={s.text}>
            Your emergency alert from {clockOf(e.at)} ({ageText(e.at, now)}) has not reached the office yet.
            crazzychat keeps trying while it is open.
          </Text>
          <View>
            {tryNow}
            <TouchableOpacity
              style={s.btn} onPress={() => withdraw(e)}
              accessibilityRole="button" accessibilityLabel={`Withdraw the emergency alert from ${clockOf(e.at)}`}
            >
              <Text style={s.btnText}>Withdraw</Text>
            </TouchableOpacity>
          </View>
        </View>
      ))}
      {dead.map((e) => (
        <View key={e.id} style={s.notice}>
          <Ionicons name="close-circle" size={18} color={colors.danger} />
          <Text style={s.text}>
            Emergency alert from {clockOf(e.at)} was not delivered: {e.dead} Call your transport office.
          </Text>
          <TouchableOpacity
            style={s.btn} onPress={() => { void dismissSos(e.id).catch(() => {}); }}
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
