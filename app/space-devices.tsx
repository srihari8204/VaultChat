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

import { AppText as Text } from '../components/ui/Text';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity,
  Alert, TextInput, Modal, RefreshControl,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSpaceColors, spaceHeader } from '../lib/spaces/theme';
import type { SpacePalette as Palette } from '../lib/spaces/theme';
import {
  getDevices, addDevice, updateDevice, getDeviceEvents, getDeviceCommands, issueDeviceCommand,
  type SpaceDevice, type DeviceEvent, type DeviceCommand,
} from '../lib/spaces/api';
import { getCachedUser } from '../lib/api';
import { bindThisPhone, unbindThisPhone, isBoundHere } from '../lib/spaces/deviceAgent';
import LoadError from '../components/spaces/LoadError';
import { AuroraBackground } from '../components/ui';
import { KeyboardSafe } from '../components/ui/KeyboardSafe';
import ChatDoorButton from '../components/spaces/ChatDoorButton';
import DeviceDetailSheet, { ago } from '../components/spaces/DeviceDetailSheet';

const KINDS: { key: string; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'phone', label: 'Phone', icon: 'phone-portrait-outline' },
  { key: 'car', label: 'Car', icon: 'car-outline' },
  { key: 'bike', label: 'Bike', icon: 'bicycle-outline' },
  { key: 'bag', label: 'Bag', icon: 'briefcase-outline' },
  { key: 'pet', label: 'Pet', icon: 'paw-outline' },
  { key: 'other', label: 'Other', icon: 'cube-outline' },
];

/** A thrown error's own words, when it has any. */
const errorText = (e: unknown) => (e instanceof Error && e.message) || undefined;

export default function SpaceDevicesScreen() {
  const params = useLocalSearchParams<{ spaceId?: string; name?: string; groupType?: string; perms?: string }>();
  const colors = useSpaceColors(params.groupType);
  const spaceId = String(params.spaceId || '');

  const [devices, setDevices] = useState<SpaceDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [myId, setMyId] = useState('');
  // Whether the open device is registered as THIS handset (bindings are local).
  const [boundHere, setBoundHere] = useState(false);
  const [isThisPhone, setIsThisPhone] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);

  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState('phone');

  const [open, setOpen] = useState<SpaceDevice | null>(null);
  const [events, setEvents] = useState<DeviceEvent[]>([]);
  const [commands, setCommands] = useState<DeviceCommand[]>([]);
  const [detailError, setDetailError] = useState<string | null>(null);
  // Which device the detail sheet last asked about. Opening A then B quickly
  // must not let A's late answers overwrite B's history.
  const openReq = useRef(0);

  const load = useCallback(async () => {
    try { setDevices(await getDevices(spaceId)); setLoadError(null); }
    catch (e) { setLoadError(errorText(e) ?? 'Could not load devices.'); }
    finally { setLoading(false); setRefreshing(false); }
  }, [spaceId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => {
    getCachedUser().then((u: { id?: string | number } | null) => setMyId(u?.id != null ? String(u.id) : '')).catch(() => {});
  }, []);

  const openDevice = useCallback(async (d: SpaceDevice) => {
    const req = ++openReq.current;
    setOpen(d); setEvents([]); setCommands([]); setBoundHere(false); setDetailError(null);
    isBoundHere(spaceId, d.id).then((b) => { if (req === openReq.current) setBoundHere(b); }).catch(() => {});
    // Each part fails on its own, and a failure is SAID: an empty history on a
    // theft screen must mean "nothing happened", never "could not ask".
    const failed: string[] = [];
    const [e, c] = await Promise.all([
      getDeviceEvents(spaceId, d.id).catch(() => { failed.push('history'); return [] as DeviceEvent[]; }),
      getDeviceCommands(spaceId, d.id).catch(() => { failed.push('requests'); return [] as DeviceCommand[]; }),
    ]);
    if (req !== openReq.current) return; // another device was opened since
    setEvents(e); setCommands(c);
    setDetailError(failed.length ? `Could not load this device’s ${failed.join(' or ')}.` : null);
  }, [spaceId]);

  const closeDevice = useCallback(() => { openReq.current++; setOpen(null); }, []);

  const onAdd = useCallback(async () => {
    const l = label.trim();
    if (!l) return;
    setBusy(true);
    try {
      // appBacked is TRUE only for a phone, because that is the only kind this
      // app can actually run on. Claiming it for a car would put a Lock button
      // on something that can never receive one.
      const { id } = await addDevice(spaceId, { label: l, kind, appBacked: kind === 'phone' });
      // The server cannot tell which handset a row is, so THIS phone remembers
      // it registered itself — that is what lets it collect its commands.
      if (kind === 'phone' && isThisPhone && myId) {
        await bindThisPhone({ spaceId, deviceId: id, ownerId: myId, label: l });
      }
      setAdding(false); setLabel(''); setIsThisPhone(true);
      await load();
    } catch (e) { Alert.alert('Could not add', errorText(e) ?? 'Try again.'); }
    finally { setBusy(false); }
  }, [label, kind, spaceId, load, isThisPhone, myId]);

  const toggleThisPhone = useCallback(async (d: SpaceDevice) => {
    try {
      if (boundHere) await unbindThisPhone({ spaceId, deviceId: d.id });
      else await bindThisPhone({ spaceId, deviceId: d.id, ownerId: myId, label: d.label });
      setBoundHere(!boundHere);
    } catch (e) { Alert.alert('Could not update this phone', errorText(e) ?? 'Try again.'); }
  }, [boundHere, spaceId, myId]);

  const archiveDevice = useCallback((d: SpaceDevice) => {
    Alert.alert(
      `Remove ${d.label}?`,
      'It disappears from this space’s device list. Its history is kept on the server.',
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Remove', style: 'destructive',
          onPress: async () => {
            try {
              await updateDevice(spaceId, d.id, { archived: true });
            } catch (e) { Alert.alert('Could not remove', errorText(e) ?? 'Try again.'); return; }
            // The device IS removed now. Forgetting it on this phone is a
            // separate, local step, and its failure must not read as "not removed".
            closeDevice();
            try { await unbindThisPhone({ spaceId, deviceId: d.id }); }
            catch {
              Alert.alert('Removed', `${d.label} is removed from this space. This phone could not clear its own saved link to it, so it may keep trying to report for it.`);
            }
            await load();
          },
        },
      ],
    );
  }, [spaceId, load, closeDevice]);

  const onRename = useCallback(async (l: string): Promise<boolean> => {
    if (!open || l === open.label) return true;
    setBusy(true);
    try {
      await updateDevice(spaceId, open.id, { label: l });
      setOpen({ ...open, label: l });
      await load();
      return true;
    } catch (e) { Alert.alert('Could not rename', errorText(e) ?? 'Try again.'); return false; }
    finally { setBusy(false); }
  }, [open, spaceId, load]);

  const runAction = useCallback(async (d: SpaceDevice, action: string, payload?: string): Promise<boolean> => {
    const req = openReq.current;
    setBusy(true);
    try {
      await issueDeviceCommand(spaceId, d.id, action, payload);
      const fresh = await getDeviceCommands(spaceId, d.id).catch(() => null);
      if (fresh && req === openReq.current) setCommands(fresh); // still this device's sheet
      Alert.alert(
        'Sent to the device',
        // Never "Done." The device has not said anything yet.
        'The request is queued. The phone carries it out the next time crazzychat is open on it, and this screen will show when it did.',
      );
      return true;
    } catch (e) {
      Alert.alert('Could not send', errorText(e) ?? 'Try again.');
      return false;
    } finally { setBusy(false); }
  }, [spaceId]);

  const confirmAction = useCallback((d: SpaceDevice, key: string) => {
    if (key === 'wipe') {
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
    void runAction(d, key);
  }, [runAction]);

  const s = useMemo(() => styles(colors), [colors]);
  const canManage = !!open && (open.ownerId === myId || String(params.perms || '').split(',').includes('view_space_ops'));

  if (loading) {
    return (
      <View style={[s.screen, s.centre]}>
      <AuroraBackground />
        <Stack.Screen options={spaceHeader(colors, 'Devices')} />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <AuroraBackground />
      <Stack.Screen
        options={{
          ...spaceHeader(colors, params.name ? `${params.name} · Devices` : 'Devices'),
          // The add button sits NEXT TO the chat door, not in place of it.
          headerRight: () => (
            <View style={s.headerActions}>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Add a device" onPress={() => setAdding(true)} style={s.hit}>
                <Ionicons name="add" size={24} color={colors.primary} />
              </TouchableOpacity>
              {!!spaceId && (
                <ChatDoorButton
                  colors={colors} chat={{ id: spaceId, name: params.name }}
                  fallbackTitle="Devices" accessibilityLabel="Open the space chat"
                />
              )}
            </View>
          ),
        }}
      />

      <ScrollView
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
      >
        {loadError && (
          <LoadError colors={colors} title="Could not load devices" message={loadError} onRetry={() => { setLoading(true); void load(); }} />
        )}
        {!loadError && devices.length === 0 && (
          <View style={s.card}>
            <Text style={s.cardTitle}>No devices yet</Text>
            <Text style={s.muted}>
              Add a phone, a vehicle or a bag to keep track of. A phone running crazzychat can
              also be made to ring or show a message remotely; anything else can be listed and
              have its alerts recorded.
            </Text>
          </View>
        )}

        {devices.map((d) => {
          const meta = KINDS.find((k) => k.key === d.kind) ?? KINDS[KINDS.length - 1];
          return (
            <TouchableOpacity
              key={d.id} style={s.card} onPress={() => openDevice(d)}
              accessibilityRole="button"
              accessibilityLabel={`${d.label}, ${meta.label}${d.stale ? ', silent' : ''}`}
            >
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

      {/* ── detail: screens 15, 17, 18 (its dialogs are nested inside it) ── */}
      <DeviceDetailSheet
        colors={colors} device={open} events={events} commands={commands}
        detailError={detailError} boundHere={boundHere} busy={busy}
        isOwner={!!open && open.ownerId === myId} canManage={canManage}
        onClose={closeDevice}
        onRetry={() => { if (open) void openDevice(open); }}
        onToggleThisPhone={() => { if (open) void toggleThisPhone(open); }}
        onAction={(key) => { if (open) confirmAction(open, key); }}
        onSendMessage={(text) => (open ? runAction(open, 'message', text) : Promise.resolve(false))}
        onRename={onRename}
        onArchive={() => { if (open) archiveDevice(open); }}
      />

      {/* add */}
      <Modal visible={adding} transparent animationType="fade" onRequestClose={() => setAdding(false)}>
        <KeyboardSafe keyboardOnly>
        <View style={s.modalWrap}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>Add a device</Text>
            <TextInput style={s.input} value={label} onChangeText={setLabel} autoFocus
              accessibilityLabel="Device name"
              placeholder="Name, e.g. Honda City" placeholderTextColor={colors.textDim} maxLength={80} />
            <View style={s.kinds}>
              {KINDS.map((k) => (
                <TouchableOpacity key={k.key} onPress={() => setKind(k.key)}
                  accessibilityRole="radio" accessibilityState={{ checked: kind === k.key }}
                  accessibilityLabel={k.label}
                  style={[s.kind, kind === k.key && { backgroundColor: colors.brandOnLight }]}>
                  {/* White ink on the solid brandOnLight fill (deep blue in both schemes). */}
                  <Text style={[s.kindText, kind === k.key && { color: colors.onBrand }]}>{k.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {kind === 'phone' ? (
              <TouchableOpacity
                style={s.actionRow} onPress={() => setIsThisPhone((v) => !v)}
                accessibilityRole="checkbox" accessibilityState={{ checked: isThisPhone }}
              >
                <Ionicons name={isThisPhone ? 'checkbox' : 'square-outline'} size={19} color={isThisPhone ? colors.primary : colors.textDim} />
                <Text style={[s.actionText, { flex: 1 }]}>This is the phone I am using</Text>
              </TouchableOpacity>
            ) : (
              <Text style={s.footnote}>
                Only a phone running crazzychat can be rung remotely. This will be
                tracked as an item.
              </Text>
            )}
            <View style={s.modalRow}>
              <TouchableOpacity style={s.modalBtn} onPress={() => setAdding(false)} accessibilityRole="button" disabled={busy} accessibilityState={{ disabled: busy }}>
                <Text style={s.muted}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.modalBtn, { backgroundColor: colors.brandOnLight }, (!label.trim() || busy) && s.off]}
                onPress={onAdd} disabled={!label.trim() || busy}
                accessibilityRole="button" accessibilityLabel="Add device"
                accessibilityState={{ disabled: !label.trim() || busy, busy }}>
                {busy ? <ActivityIndicator size="small" color={colors.onBrand} /> : <Text style={s.primaryText}>Add</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
        </KeyboardSafe>
      </Modal>
    </View>
  );
}

const styles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  centre: { alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 10, paddingBottom: 40 },
  card: { backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, gap: 8 },
  cardTitle: { color: c.text, fontSize: 15.5, fontWeight: '700' },
  muted: { color: c.textDim, fontSize: 12.5, flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  icon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  pill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  actionText: { color: c.text, fontSize: 14.5, flexShrink: 1 },
  footnote: { color: c.textFaint, fontSize: 11.5, lineHeight: 16 },
  // A fixed dark scrim behind the dialog, the same in both schemes.
  modalWrap: { flex: 1, backgroundColor: '#0008', alignItems: 'center', justifyContent: 'center', padding: 22 },
  modal: { width: '100%', backgroundColor: c.bg, borderRadius: 16, padding: 20, gap: 10 },
  modalTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  input: { borderWidth: 1, borderColor: c.glassStroke, borderRadius: 10, padding: 12, color: c.text, fontSize: 15 },
  kinds: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  kind: {
    borderWidth: 1, borderColor: c.glassStroke, borderRadius: 22, paddingHorizontal: 14,
    minHeight: 44, justifyContent: 'center',
  },
  kindText: { color: c.textDim, fontSize: 12.5 },
  modalRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  modalBtn: { paddingHorizontal: 18, minHeight: 44, minWidth: 64, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  off: { opacity: 0.5 },
  hit: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  primaryText: { color: c.onBrand, fontWeight: '700' },
});
