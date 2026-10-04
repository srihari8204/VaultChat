// components/spaces/DeviceDetailSheet.tsx — one device's detail, history and
// remote actions (design screens 15, 17 and 18), split out of
// app/space-devices.tsx.
//
// The show-a-message and rename dialogs are an overlay INSIDE this
// full-screen Modal, not a second Modal: on iOS a Modal presented while
// another is up may not stack above it, so the dialog might never appear.
// An absolute-fill view in the same window has no presentation to get wrong
// (the useDatePicker `inModal` approach).

import React, { useMemo, useState } from 'react';
import {
  View, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity, TextInput, Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text } from '../ui/Text';
import { KeyboardSafe } from '../ui/KeyboardSafe';
import LoadError from './LoadError';
import type { SpacePalette as Palette } from '../../lib/spaces/theme';
import type { SpaceDevice, DeviceEvent, DeviceCommand } from '../../lib/spaces/api';

// Design screen 18. `wipe` is deliberately last and styled apart.
// `supported` = the phone-side agent (lib/spaces/deviceCommands.ts) can carry
// it out. The rest need Device Admin, which the app does not hold, so they are
// shown but not offered: a Lock button that can only ever report "Failed" is a
// promise the phone cannot keep.
export const DEVICE_ACTIONS: { key: string; label: string; icon: keyof typeof Ionicons.glyphMap; danger?: boolean; supported?: boolean }[] = [
  { key: 'ring', label: 'Ring device', icon: 'volume-high-outline', supported: true },
  { key: 'lock', label: 'Lock remotely', icon: 'lock-closed-outline' },
  { key: 'message', label: 'Show a message', icon: 'chatbox-ellipses-outline', supported: true },
  { key: 'photo', label: 'Capture photo', icon: 'camera-outline' },
  { key: 'wipe', label: 'Erase everything', icon: 'trash-outline', danger: true },
];

export function ago(iso: string): string {
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
    default: return c.warning;
  }
}
/** The words for eventColour's tone, for the row's spoken label. */
function eventSeverity(kind: string): string {
  switch (kind) {
    case 'overspeed': case 'shock': return 'Alert: ';
    case 'left_zone': case 'disconnected': case 'powered_off': return 'Warning: ';
    default: return '';
  }
}

function eventColour(kind: string, c: Palette): string {
  switch (kind) {
    case 'overspeed': case 'shock': return c.danger;
    case 'left_zone': case 'disconnected': case 'powered_off': return c.warning;
    case 'entered_zone': return c.success;
    default: return c.textDim;
  }
}

export default function DeviceDetailSheet({
  colors, device, events, commands, detailError, boundHere, busy, isOwner, canManage,
  onClose, onRetry, onToggleThisPhone, onAction, onSendMessage, onRename, onArchive,
}: {
  colors: Palette;
  /** The open device, or null when the sheet is closed. */
  device: SpaceDevice | null;
  events: DeviceEvent[];
  commands: DeviceCommand[];
  detailError: string | null;
  boundHere: boolean;
  busy: boolean;
  isOwner: boolean;
  /** Owner or view_space_ops: may rename and remove. Presentation only. */
  canManage: boolean;
  onClose: () => void;
  onRetry: () => void;
  onToggleThisPhone: () => void;
  /** Every action except `message`, which this sheet collects text for. */
  onAction: (key: string) => void;
  /** Resolves true when sent; the dialog stays open (text kept) on false. */
  onSendMessage: (text: string) => Promise<boolean>;
  onRename: (label: string) => Promise<boolean>;
  onArchive: () => void;
}) {
  const insets = useSafeAreaInsets();
  const s = useMemo(() => styles(colors), [colors]);
  const [dialog, setDialog] = useState<'message' | 'rename' | null>(null);
  const [text, setText] = useState('');

  const open = device;
  const closeDialog = () => setDialog(null);
  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    const ok = dialog === 'message' ? await onSendMessage(t) : await onRename(t);
    if (ok) setDialog(null);
  };

  return (
    // Android Back closes the open dialog first, then the sheet.
    <Modal visible={!!open} animationType="slide" onRequestClose={dialog ? closeDialog : onClose}>
      <View style={[s.screen, { backgroundColor: colors.bg }]}>
        {/* Hidden from screen readers while a dialog is up (Android has no
            accessibilityViewIsModal), so focus cannot wander behind it. */}
        <View style={s.screen} importantForAccessibility={dialog ? 'no-hide-descendants' : 'auto'}>
        <View style={[s.sheetHead, { paddingTop: insets.top + 12 }]}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={s.hit}>
            <Ionicons name="close" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={s.sheetTitle} numberOfLines={1} accessibilityRole="header">{open?.label}</Text>
        </View>

        <ScrollView contentContainerStyle={[s.body, { paddingBottom: 40 + insets.bottom }]}>
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
          <Text style={s.section} accessibilityRole="header">PROTECTION</Text>
          {open && !open.appBacked ? (
            <View style={s.card}>
              <Text style={s.muted}>
                Remote actions need crazzychat running on the device itself. This one is tracked
                as an item, so its alerts and history are kept, but it cannot be locked, rung or
                erased from here.
              </Text>
            </View>
          ) : (
            <View style={s.card}>
              {/* Only the handset that registered as this device collects its
                  commands; the server cannot tell phones apart. */}
              {open && isOwner && (
                <TouchableOpacity
                  style={s.actionRow} onPress={onToggleThisPhone}
                  accessibilityRole="switch" accessibilityState={{ checked: boundHere }}
                  accessibilityLabel="This is the phone I am using"
                >
                  <Ionicons name={boundHere ? 'checkbox' : 'square-outline'} size={19} color={boundHere ? colors.primary : colors.textDim} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.actionText}>This is the phone I am using</Text>
                    <Text style={s.muted}>
                      {boundHere
                        ? 'This phone reports in and carries out requests while crazzychat is open.'
                        : 'Turn on, on the phone itself, so it can receive requests.'}
                    </Text>
                  </View>
                </TouchableOpacity>
              )}
              {DEVICE_ACTIONS.map((a) => (
                <TouchableOpacity
                  key={a.key}
                  style={[s.actionRow, !a.supported && { opacity: 0.5 }]}
                  onPress={() => {
                    if (a.key === 'message') { setText(''); setDialog('message'); }
                    else onAction(a.key);
                  }}
                  disabled={busy || !a.supported}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: busy || !a.supported }}
                  accessibilityHint={a.supported ? undefined : 'Not available on crazzychat phones yet'}
                >
                  <Ionicons name={a.icon} size={19} color={a.danger ? colors.danger : colors.text} />
                  <View style={{ flex: 1 }}>
                    <Text style={[s.actionText, a.danger && { color: colors.danger }]}>{a.label}</Text>
                    {!a.supported && <Text style={s.muted}>Needs device admin — not available yet</Text>}
                  </View>
                  {a.supported && <Ionicons name="chevron-forward" size={15} color={colors.textDim} />}
                </TouchableOpacity>
              ))}
            </View>
          )}

          {commands.length > 0 && (
            <View style={s.card}>
              <Text style={s.cardTitle}>Requests</Text>
              {commands.map((c) => (
                <View key={c.id} style={s.row} accessible accessibilityLabel={`${c.action}: ${resultLabel(c.result)}`}>
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

          {open && canManage && (
            <TouchableOpacity
              style={[s.card, s.row]} onPress={() => { setText(open.label); setDialog('rename'); }}
              accessibilityRole="button" accessibilityLabel={`Rename ${open.label}`}
            >
              <Ionicons name="create-outline" size={19} color={colors.text} />
              <Text style={s.actionText}>Rename</Text>
            </TouchableOpacity>
          )}

          {open && canManage && (
            <TouchableOpacity
              style={[s.card, s.row]} onPress={onArchive}
              accessibilityRole="button" accessibilityLabel={`Remove ${open.label} from this space`}
            >
              <Ionicons name="archive-outline" size={19} color={colors.danger} />
              <Text style={[s.actionText, { color: colors.danger }]}>Remove from this space</Text>
            </TouchableOpacity>
          )}

          {detailError && open && (
            <LoadError colors={colors} message={detailError} onRetry={onRetry} />
          )}

          {/* History + alerts (screens 13 and 17) */}
          <Text style={s.section} accessibilityRole="header">HISTORY</Text>
          <View style={s.card}>
            {events.length === 0 && !detailError && <Text style={s.muted}>Nothing recorded yet.</Text>}
            {events.map((e) => (
              <View
                key={e.id} style={s.row} accessible
                // The dot's colour is said too: it is the event's severity.
                accessibilityLabel={`${eventSeverity(e.kind)}${e.text || e.kind.replace(/_/g, ' ')}, ${ago(e.at)}`}
              >
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

        {/* show-a-message / rename — an overlay in this Modal, not a nested Modal. */}
        {dialog !== null && (
          <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
          <KeyboardSafe keyboardOnly>
            <View style={s.modalWrap}>
              <View style={s.modal}>
                <Text style={s.modalTitle} accessibilityRole="header">
                  {dialog === 'message' ? 'Show a message' : 'Rename device'}
                </Text>
                {dialog === 'message' && (
                  <Text style={s.muted}>Whoever has the phone sees this when crazzychat is open on it. A phone number helps.</Text>
                )}
                <TextInput
                  style={s.input} value={text} onChangeText={setText} autoFocus
                  multiline={dialog === 'message'}
                  maxLength={dialog === 'message' ? 300 : 80}
                  accessibilityLabel={dialog === 'message' ? 'Message to show on the phone' : 'New device name'}
                  placeholder={dialog === 'message' ? 'Lost phone — please call …' : 'Name, e.g. Honda City'}
                  placeholderTextColor={colors.textDim}
                />
                <View style={s.modalRow}>
                  <TouchableOpacity style={s.modalBtn} onPress={closeDialog} accessibilityRole="button" disabled={busy} accessibilityState={{ disabled: busy }}>
                    <Text style={s.muted}>Cancel</Text>
                  </TouchableOpacity>
                  {/* Stays open while sending, so a failure keeps the typed text. */}
                  <TouchableOpacity
                    style={[s.modalBtn, { backgroundColor: colors.brandOnLight }, (!text.trim() || busy) && s.off]}
                    onPress={submit} disabled={!text.trim() || busy}
                    accessibilityRole="button"
                    accessibilityLabel={dialog === 'message' ? 'Send message' : 'Save name'}
                    accessibilityState={{ disabled: !text.trim() || busy, busy }}
                  >
                    {/* White ink on the solid brandOnLight fill (deep blue in both schemes, 6.3:1). */}
                    {busy ? <ActivityIndicator size="small" color={colors.onBrand} />
                      : <Text style={s.primaryText}>{dialog === 'message' ? 'Send' : 'Save'}</Text>}
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </KeyboardSafe>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  body: { padding: 16, gap: 10, paddingBottom: 40 },
  card: { backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, gap: 8 },
  cardTitle: { color: c.text, fontSize: 15.5, fontWeight: '700' },
  muted: { color: c.textDim, fontSize: 12.5, flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  section: { color: c.textDim, fontSize: 11.5, letterSpacing: 1, marginTop: 8 },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  actionText: { color: c.text, fontSize: 14.5, flexShrink: 1 },
  sheetHead: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingBottom: 14,
    borderBottomWidth: 1, borderBottomColor: c.glassStroke,
  },
  sheetTitle: { color: c.text, fontSize: 17, fontWeight: '700', flex: 1 },
  footnote: { color: c.textFaint, fontSize: 11.5, lineHeight: 16 },
  // The theme's scrim (Palette.scrim) behind the dialog.
  modalWrap: { flex: 1, backgroundColor: c.scrim, alignItems: 'center', justifyContent: 'center', padding: 22 },
  modal: { width: '100%', backgroundColor: c.bg, borderRadius: 16, padding: 20, gap: 10 },
  modalTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  input: { borderWidth: 1, borderColor: c.glassStroke, borderRadius: 10, padding: 12, color: c.text, fontSize: 15 },
  modalRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  modalBtn: { paddingHorizontal: 18, minHeight: 44, minWidth: 64, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  off: { opacity: 0.5 },
  hit: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: c.onBrand, fontWeight: '700' },
});
