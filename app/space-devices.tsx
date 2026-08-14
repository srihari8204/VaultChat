// app/space-devices.tsx — devices, their history, and theft protection
// (design screens 14, 15, 17 and 18 in one screen).
//
// One screen rather than four: the list, a device's detail, its alert history
// and its remote actions are the same object at different depths, and four
// screens would mean four fetches and four places to keep the status wording
// consistent.
//
// ── two things this screen is careful not to claim ──
//
// 1. THERE IS NO MAP HERE, and its absence is deliberate rather than missing.
//    A device's position travels sealed on the live-location channel; the
//    server holds none, so a "last known location" panel would have nothing
//    truthful to draw. What the server can say is when the thing last spoke,
//    and that is what is shown.
//
// 2. A REMOTE ACTION IS A REQUEST, NOT A RESULT. Lock, ring, wipe and the rest
//    need Device Admin on the handset, so the server records an intent and only
//    the DEVICE confirms it. This screen therefore shows "Waiting" until the
//    device says otherwise, and never turns an unacknowledged command into a
//    tick. A phone that is off in a drawer must not look like a phone that
//    locked.

import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity,
  Alert, TextInput, Modal, RefreshControl,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSpaceColors, spaceHeader } from '../lib/spaces/theme';
import type { Palette } from '../constants/theme';
import {
  getDevices, addDevice, getDeviceEvents, getDeviceCommands, issueDeviceCommand,
  type SpaceDevice, type DeviceEvent, type DeviceCommand,
} from '../lib/spaces/api';

const KINDS: { key: string; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'phone', label: 'Phone', icon: 'phone-portrait-outline' },
  { key: 'car', label: 'Car', icon: 'car-outline' },
  { key: 'bike', label: 'Bike', icon: 'bicycle-outline' },
  { key: 'bag', label: 'Bag', icon: 'briefcase-outline' },
  { key: 'pet', label: 'Pet', icon: 'paw-outline' },
  { key: 'other', label: 'Other', icon: 'cube-outline' },
];

// Design screen 18. `wipe` is deliberately last and styled apart.
const ACTIONS: { key: string; label: string; icon: keyof typeof Ionicons.glyphMap; danger?: boolean }[] = [
  { key: 'ring', label: 'Ring device', icon: 'volume-high-outline' },
  { key: 'lock', label: 'Lock remotely', icon: 'lock-closed-outline' },
  { key: 'message', label: 'Show a message', icon: 'chatbox-ellipses-outline' },
  { key: 'photo', label: 'Capture photo', icon: 'camera-outline' },
  { key: 'wipe', label: 'Erase everything', icon: 'trash-outline', danger: true },
];

export default function SpaceDevicesScreen() {
  const params = useLocalSearchParams<{ spaceId?: string; name?: string; groupType?: string }>();
  const colors = useSpaceColors(params.groupType);
  const spaceId = String(params.spaceId || '');

  const [devices, setDevices] = useState<SpaceDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);

  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState('phone');

  const [open, setOpen] = useState<SpaceDevice | null>(null);
  const [events, setEvents] = useState<DeviceEvent[]>([]);
  const [commands, setCommands] = useState<DeviceCommand[]>([]);
  const [msg, setMsg] = useState('');
  const [asking, setAsking] = useState(false);

  const load = useCallback(async () => {
    try { setDevices(await getDevices(spaceId)); }
    catch (e: any) { Alert.alert('Could not load devices', e?.message ?? 'Try again.'); }
    finally { setLoading(false); setRefreshing(false); }
  }, [spaceId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const openDevice = useCallback(async (d: SpaceDevice) => {
    setOpen(d); setEvents([]); setCommands([]);
    try {
      const [e, c] = await Promise.all([
        getDeviceEvents(spaceId, d.id).catch(() => [] as DeviceEvent[]),
        getDeviceCommands(spaceId, d.id).catch(() => [] as DeviceCommand[]),
      ]);
      setEvents(e); setCommands(c);
    } catch { /* the sheet still renders with what it has */ }
  }, [spaceId]);

  const onAdd = useCallback(async () => {
    const l = label.trim();
    if (!l) return;
    setBusy(true);
    try {
      // appBacked is TRUE only for a phone, because that is the only kind this
      // app can actually run on. Claiming it for a car would put a Lock button
      // on something that can never receive one.
      await addDevice(spaceId, { label: l, kind, appBacked: kind === 'phone' });
      setAdding(false); setLabel('');
      await load();
    } catch (e: any) { Alert.alert('Could not add', e?.message ?? 'Try again.'); }
    finally { setBusy(false); }
  }, [label, kind, spaceId, load]);

  const runAction = useCallback(async (d: SpaceDevice, action: string, payload?: string) => {
    setBusy(true);
    try {
      await issueDeviceCommand(spaceId, d.id, action, payload);
      setCommands(await getDeviceCommands(spaceId, d.id).catch(() => commands));
      Alert.alert(
        'Sent to the device',
        // Never "Locked." The device has not said anything yet.
        'The request is queued. It runs the next time this device connects, and this screen will show when it did.',
      );
    } catch (e: any) {
      Alert.alert('Could not send', e?.message ?? 'Try again.');
    } finally { setBusy(false); }
  }, [spaceId, commands]);

  const confirmAction = useCallback((d: SpaceDevice, a: typeof ACTIONS[number]) => {
    if (a.key === 'message') { setMsg(''); setAsking(true); return; }
    if (a.key === 'wipe') {
      Alert.alert(
        'Erase everything on this device?',
        'This cannot be undone, and it cannot be stopped once the device receives it. ' +
        'Everything on it is deleted, including anything not backed up.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Erase', style: 'destructive', onPress: () => runAction(d, 'wipe') },
        ],
      );
      return;
    }
    runAction(d, a.key);
  }, [runAction]);

  const s = styles(colors);

  if (loading) {
    return (
      <View style={[s.screen, s.centre]}>
        <Stack.Screen options={spaceHeader(colors, 'Devices')} />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <Stack.Screen
        options={{
          ...spaceHeader(colors, params.name ? `${params.name} · Devices` : 'Devices'),
          headerRight: () => (
            <TouchableOpacity onPress={() => setAdding(true)} style={{ paddingHorizontal: 8 }}>
              <Ionicons name="add" size={24} color={colors.primary} />
            </TouchableOpacity>
          ),
        }}
      />

      <ScrollView
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
      >
        {devices.length === 0 && (
          <View style={s.card}>
            <Text style={s.cardTitle}>No devices yet</Text>
            <Text style={s.muted}>
              Add a phone, a vehicle or a bag to keep track of. A phone running VaultChat can
              also be locked or made to ring remotely; anything else can be listed and have its
              alerts recorded.
            </Text>
          </View>
        )}

        {devices.map((d) => {
          const meta = KINDS.find((k) => k.key === d.kind) ?? KINDS[KINDS.length - 1];
          return (
            <TouchableOpacity key={d.id} style={s.card} onPress={() => openDevice(d)}>
              <View style={s.row}>
                <View style={[s.icon, { backgroundColor: colors.primary + '1e' }]}>
                  <Ionicons name={meta.icon} size={20} color={colors.primary} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.cardTitle} numberOfLines={1}>{d.label}</Text>
                  <Text style={s.muted} numberOfLines={1}>
                    {meta.label}
                    {d.identifier ? ` · ${d.identifier}` : ''}
                    {d.battery != null ? ` · ${d.battery}%` : ''}
                    {d.lastSeenAt ? ` · ${ago(d.lastSeenAt)}` : ' · never reported'}
                  </Text>
                </View>
                {/* Silence is the only judgement the server can make about a
                    device, so it is the only badge shown. */}
                {d.stale && (
                  <View style={[s.pill, { backgroundColor: colors.danger + '22' }]}>
                    <Text style={{ color: colors.danger, fontSize: 11, fontWeight: '700' }}>silent</Text>
                  </View>
                )}
                {d.events24h > 0 && (
                  <View style={[s.pill, { backgroundColor: colors.border }]}>
                    <Text style={{ color: colors.text, fontSize: 11 }}>{d.events24h}</Text>
                  </View>
                )}
                <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
              </View>
            </TouchableOpacity>
          );
        })}

        <Text style={s.footnote}>
          Where a device is never reaches this server — positions are end-to-end encrypted and
          shown only on the map. What is stored here is what it is, when it last reported, and
          what happened to it.
        </Text>
      </ScrollView>

      {/* ── detail: screens 15, 17, 18 ── */}
      <Modal visible={!!open} animationType="slide" onRequestClose={() => setOpen(null)}>
        <View style={s.screen}>
          <View style={s.sheetHead}>
            <TouchableOpacity onPress={() => setOpen(null)}>
              <Ionicons name="close" size={24} color={colors.text} />
            </TouchableOpacity>
            <Text style={s.sheetTitle} numberOfLines={1}>{open?.label}</Text>
          </View>

          <ScrollView contentContainerStyle={s.body}>
            <View style={s.card}>
              <Text style={s.muted}>
                {open?.lastSeenAt ? `Last reported ${ago(open.lastSeenAt)}` : 'Has never reported'}
                {open?.battery != null ? ` · battery ${open.battery}%` : ''}
              </Text>
              {open?.stale && (
                <Text style={{ color: colors.danger, fontSize: 12.5 }}>
                  This device has gone quiet. That is all the server can tell — it may be off,
                  out of signal, or simply not running the app.
                </Text>
              )}
            </View>

            {/* Theft protection (screen 18) */}
            <Text style={s.section}>PROTECTION</Text>
            {open && !open.appBacked ? (
              <View style={s.card}>
                <Text style={s.muted}>
                  Remote actions need VaultChat running on the device itself. This one is tracked
                  as an item, so its alerts and history are kept, but it cannot be locked, rung or
                  erased from here.
                </Text>
              </View>
            ) : (
              <View style={s.card}>
                {ACTIONS.map((a) => (
                  <TouchableOpacity
                    key={a.key}
                    style={s.actionRow}
                    onPress={() => open && confirmAction(open, a)}
                    disabled={busy}
                  >
                    <Ionicons name={a.icon} size={19} color={a.danger ? colors.danger : colors.text} />
                    <Text style={[s.actionText, a.danger && { color: colors.danger }]}>{a.label}</Text>
                    <Ionicons name="chevron-forward" size={15} color={colors.textDim} />
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {commands.length > 0 && (
              <View style={s.card}>
                <Text style={s.cardTitle}>Requests</Text>
                {commands.map((c) => (
                  <View key={c.id} style={s.row}>
                    <View style={[s.dot, { backgroundColor: resultColour(c.result, colors) }]} />
                    <Text style={[s.actionText, { flex: 1 }]}>{c.action}</Text>
                    <Text style={s.muted}>{resultLabel(c.result)}</Text>
                  </View>
                ))}
                <Text style={s.footnote}>
                  “Waiting” means the device has not confirmed yet. Only the device can report that
                  it acted, so nothing here is marked done on its behalf.
                </Text>
              </View>
            )}

            {/* History + alerts (screens 13 and 17) */}
            <Text style={s.section}>HISTORY</Text>
            <View style={s.card}>
              {events.length === 0 && <Text style={s.muted}>Nothing recorded yet.</Text>}
              {events.map((e) => (
                <View key={e.id} style={s.row}>
                  <View style={[s.dot, { backgroundColor: eventColour(e.kind, colors) }]} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={s.actionText} numberOfLines={2}>
                      {e.text || e.kind.replace(/_/g, ' ')}
                    </Text>
                    <Text style={s.muted}>{ago(e.at)}</Text>
                  </View>
                </View>
              ))}
            </View>
          </ScrollView>
        </View>
      </Modal>

      {/* add */}
      <Modal visible={adding} transparent animationType="fade" onRequestClose={() => setAdding(false)}>
        <View style={s.modalWrap}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>Add a device</Text>
            <TextInput style={s.input} value={label} onChangeText={setLabel} autoFocus
              placeholder="Name, e.g. Honda City" placeholderTextColor={colors.textDim} maxLength={80} />
            <View style={s.kinds}>
              {KINDS.map((k) => (
                <TouchableOpacity key={k.key} onPress={() => setKind(k.key)}
                  style={[s.kind, kind === k.key && { backgroundColor: colors.primary }]}>
                  <Text style={[s.kindText, kind === k.key && { color: '#fff' }]}>{k.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {kind !== 'phone' && (
              <Text style={s.footnote}>
                Only a phone running VaultChat can be locked or rung remotely. This will be
                tracked as an item.
              </Text>
            )}
            <View style={s.modalRow}>
              <TouchableOpacity style={s.modalBtn} onPress={() => setAdding(false)}>
                <Text style={s.muted}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.modalBtn, { backgroundColor: colors.primary }]}
                onPress={onAdd} disabled={!label.trim() || busy}>
                {busy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={s.primaryText}>Add</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* show-a-message */}
      <Modal visible={asking} transparent animationType="fade" onRequestClose={() => setAsking(false)}>
        <View style={s.modalWrap}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>Message on the lock screen</Text>
            <Text style={s.muted}>Whoever has the device will see this. A phone number helps.</Text>
            <TextInput style={s.input} value={msg} onChangeText={setMsg} autoFocus multiline
              placeholder="Lost phone — please call …" placeholderTextColor={colors.textDim} maxLength={300} />
            <View style={s.modalRow}>
              <TouchableOpacity style={s.modalBtn} onPress={() => setAsking(false)}>
                <Text style={s.muted}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.modalBtn, { backgroundColor: colors.primary }]}
                onPress={() => { const d = open; setAsking(false); if (d) runAction(d, 'message', msg.trim()); }}
                disabled={!msg.trim() || busy}>
                <Text style={s.primaryText}>Send</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function ago(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function resultLabel(r: DeviceCommand['result']): string {
  switch (r) {
    case 'executed': return 'Done';
    case 'delivered': return 'Received';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
    default: return 'Waiting';
  }
}
function resultColour(r: DeviceCommand['result'], c: Palette): string {
  switch (r) {
    case 'executed': return c.success;
    case 'failed': return c.danger;
    case 'cancelled': return c.textFaint;
    default: return '#F59E0B';
  }
}
function eventColour(kind: string, c: Palette): string {
  switch (kind) {
    case 'overspeed': case 'shock': return c.danger;
    case 'left_zone': case 'disconnected': case 'powered_off': return '#F59E0B';
    case 'entered_zone': return c.success;
    default: return c.textDim;
  }
}

const styles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  centre: { alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 10, paddingBottom: 40 },
  card: { backgroundColor: c.card, borderRadius: 14, padding: 14, gap: 8 },
  cardTitle: { color: c.text, fontSize: 15.5, fontWeight: '700' },
  muted: { color: c.textDim, fontSize: 12.5, flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  icon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  pill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  section: { color: c.textDim, fontSize: 11.5, letterSpacing: 1, marginTop: 8 },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  actionText: { color: c.text, fontSize: 14.5, flexShrink: 1 },
  sheetHead: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingTop: 54, paddingBottom: 14,
    borderBottomWidth: 1, borderBottomColor: c.border,
  },
  sheetTitle: { color: c.text, fontSize: 17, fontWeight: '700', flex: 1 },
  footnote: { color: c.textFaint, fontSize: 11.5, lineHeight: 16 },
  modalWrap: { flex: 1, backgroundColor: '#0008', alignItems: 'center', justifyContent: 'center', padding: 22 },
  modal: { width: '100%', backgroundColor: c.bg, borderRadius: 16, padding: 20, gap: 10 },
  modalTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  input: { borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 12, color: c.text, fontSize: 15 },
  kinds: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  kind: { borderWidth: 1, borderColor: c.border, borderRadius: 20, paddingHorizontal: 13, paddingVertical: 7 },
  kindText: { color: c.textDim, fontSize: 12.5 },
  modalRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  modalBtn: { paddingHorizontal: 18, paddingVertical: 12, borderRadius: 10 },
  primaryText: { color: '#fff', fontWeight: '700' },
});
