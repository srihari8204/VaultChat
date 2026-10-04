// components/chattools/importChatsParts.tsx — the presentational pieces of
// app/import-chats.tsx (Exit Kit): chat picker, preview, done card, and the
// screen's styles. Split out of the screen file; the flow, parsing and writes
// stay in the screen. Like the screen, nothing here touches the network.

import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { type Palette, SPACING, RADIUS, brandAlpha } from '../../constants/theme';
import { Card, Button } from '../ui';
import { tint } from '../../lib/tintColor';
import type { WaMessage, WaFormat } from '../../lib/waImport';
import type { ChatSummary } from '../../lib/chatService';
import { importSkipNote } from './importSkipNote';

/** How confident we are that this export belongs to the selected contact. */
export type MatchLevel = 'phone' | 'name' | 'unverified';

export interface Parsed {
  messages: WaMessage[];
  participants: string[];
  format: WaFormat;
  unsupported: number;
  missingMedia: number;
  mediaNames: Set<string>;
  /** The export's counterpart — the person who is NOT the user. */
  counterpart: string;
  /** Sender label the user sends under, so alignment is right. */
  selfLabel: string;
}

export interface Outcome {
  imported: number; duplicates: number; unsupported: number;
  /** Media the transcript names that the archive did not contain. */
  missingMedia: number;
  mediaCopied: number; mediaSkipped: number; partial: boolean;
}

function peerLabel(c: ChatSummary): string {
  return (c.peerName?.trim() || c.name?.trim() || 'Unnamed contact');
}

// ─── Pieces ──────────────────────────────────────────────────────────

export type S = ReturnType<typeof makeImportStyles>;

export function PrivacyNote({ s, colors }: { s: S; colors: Palette }) {
  return (
    <View style={s.privacy}>
      <Ionicons name="lock-closed" size={14} color={colors.success} />
      <Text style={s.privacyTxt}>Your data stays on this device. Nothing is uploaded.</Text>
    </View>
  );
}

export function Step({ s, n, text, last }: { s: S; n: number; text: string; last?: boolean }) {
  return (
    <View style={[s.step, last && s.stepLast]}>
      <View style={s.stepNum}><Text style={s.stepNumTxt}>{n}</Text></View>
      <Text style={s.stepTxt}>{text}</Text>
    </View>
  );
}

export function Row({ s, k, v }: { s: S; k: string; v: string }) {
  return (
    <View style={s.kv}>
      <Text style={s.kvK}>{k}</Text>
      <Text style={s.kvV} numberOfLines={2}>{v}</Text>
    </View>
  );
}

export function PickChat({ s, colors, chats, error, onRetry, onPick }: {
  s: S; colors: Palette; chats: ChatSummary[] | null;
  error: boolean; onRetry: () => void;
  onPick: (chatId: string, name: string) => void;
}) {
  if (error) {
    return (
      <View style={s.center}>
        <Text style={s.h1}>{"Couldn't load your chats"}</Text>
        <Text style={s.sub} accessibilityRole="alert">Check your connection and try again.</Text>
        <Button title="Try again" onPress={onRetry} />
      </View>
    );
  }
  if (!chats) return <View style={s.center}><ActivityIndicator color={colors.primary} accessibilityLabel="Loading chats" /></View>;
  if (!chats.length) {
    return (
      <View style={s.center}>
        <Text style={s.h1}>No conversations yet</Text>
        <Text style={s.sub}>Start a chat with someone first, then import your history with them.</Text>
      </View>
    );
  }
  return (
    <>
      <Text style={s.h1}>Which conversation?</Text>
      <Text style={s.sub}>Pick the contact whose history you want to bring across. One at a time.</Text>
      <PrivacyNote s={s} colors={colors} />
      {chats.map(c => {
        // A DIRECT chat carries the other person in `peerName`; `name` is for
        // groups and is null here. Reading `name` first made every row in this
        // picker read "Unnamed" on a real device — a contact list with no
        // contacts in it. Verified on the Honor before and after.
        const who = peerLabel(c);
        return (
          <TouchableOpacity key={c.id} style={s.srcRow} activeOpacity={0.7}
            onPress={() => onPick(c.id, who)} accessibilityRole="button" accessibilityLabel={`Import into chat with ${who}`}>
            <View style={[s.srcIcon, { backgroundColor: brandAlpha(0.15) }]}>
              <Ionicons name="person" size={20} color={colors.primary} />
            </View>
            <Text style={[s.srcLabel, s.flex]} numberOfLines={1}>{who}</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
          </TouchableOpacity>
        );
      })}
    </>
  );
}

export function Preview({
  s, colors, parsed, peerName, match, ack, setAck, dateOrder, answered, onPickOrder, onConfirm, onCancel,
}: {
  s: S; colors: Palette; parsed: Parsed; peerName: string;
  match: { level: MatchLevel; because: string } | null;
  ack: boolean; setAck: (v: boolean) => void;
  dateOrder: 'DMY' | 'MDY'; answered: boolean; onPickOrder: (o: 'DMY' | 'MDY') => void;
  onConfirm: () => void; onCancel: () => void;
}) {
  const times = parsed.messages.map(m => m.tsMs);
  const range = times.length
    ? `${fmtMonth(Math.min(...times))} – ${fmtMonth(Math.max(...times))}`
    : '—';

  // Two gates, and neither can be waved through by pressing the primary button:
  // an unverified contact, and a date order the export itself could not settle.
  const needsAck = match?.level === 'unverified';
  const blocked = (needsAck && !ack) || (parsed.format.ambiguous && !answered);

  return (
    <>
      <Text style={s.h1}>Import this conversation?</Text>

      <Card style={s.summary}>
        <Row s={s} k="Source" v="WhatsApp" />
        <Row s={s} k="Contact" v={parsed.counterpart || peerName} />
        <Row s={s} k="Messages" v={parsed.messages.length.toLocaleString()} />
        <Row s={s} k="Time range" v={range} />
        <Row s={s} k="Into" v={peerName} />
      </Card>

      {match && (
        <View style={[s.match, match.level === 'phone' ? s.matchOk
                    : match.level === 'name' ? s.matchMeh : s.matchBad]}>
          <Ionicons
            name={match.level === 'phone' ? 'checkmark-circle'
                : match.level === 'name' ? 'information-circle' : 'alert-circle'}
            size={16}
            color={match.level === 'phone' ? colors.success
                 : match.level === 'name' ? colors.primary : colors.danger}
          />
          <Text style={s.matchTxt}>{match.because}</Text>
        </View>
      )}

      {needsAck && (
        <TouchableOpacity style={s.ackRow} activeOpacity={0.8} onPress={() => setAck(!ack)} accessibilityRole="checkbox" accessibilityState={{ checked: ack }}>
          <View style={[s.check, ack && s.checkOn]}>
            {ack && <Ionicons name="checkmark" size={14} color={colors.onPrimary} />}
          </View>
          <Text style={s.ackTxt}>
            Yes — this WhatsApp conversation with{' '}
            <Text style={s.strong}>{parsed.counterpart || 'this person'}</Text> belongs in my
            crazzychat chat with <Text numberOfLines={1} style={s.strong}>{peerName}</Text>.
          </Text>
        </TouchableOpacity>
      )}

      {parsed.format.ambiguous && (
        <Card style={s.warnCard}>
          <Text style={s.warnTitle}>Which date order does this export use?</Text>
          <Text style={s.warnBody}>
            Every date in this export could be read either way (e.g. 03/04 as 3 April or March 4),
            so it cannot be worked out from the file. Choosing wrong shifts every message by months.
          </Text>
          <View style={s.pillRow}>
            {([['DMY', 'Day first (03/04 = 3 Apr)'], ['MDY', 'Month first (03/04 = 4 Mar)']] as const).map(([o, label]) => {
              const on = answered && dateOrder === o;
              return (
                <TouchableOpacity key={o} style={[s.pill, on && s.pillOn]} onPress={() => onPickOrder(o)} accessibilityRole="radio" accessibilityState={{ checked: on }}>
                  <Text style={[s.pillTxt, on && s.pillTxtOn]}>{label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Card>
      )}

      {(parsed.unsupported > 0 || parsed.missingMedia > 0) && (
        <Text style={s.note}>
          {parsed.missingMedia > 0 && `${parsed.missingMedia} media file${parsed.missingMedia === 1 ? '' : 's'} referenced but not in this export`}
          {parsed.missingMedia > 0 && parsed.unsupported > 0 && ' · '}
          {parsed.unsupported > 0 && `${parsed.unsupported} line${parsed.unsupported === 1 ? '' : 's'} could not be read`}
        </Text>
      )}

      <View style={s.privacy}>
        <Ionicons name="lock-closed" size={14} color={colors.success} />
        <Text style={s.privacyTxt}>Nothing will be uploaded. Import happens on this device.</Text>
      </View>

      <Button title="Import conversation" fullWidth disabled={blocked} onPress={onConfirm} />
      <Button title="Cancel" variant="ghost" fullWidth style={s.gap} onPress={onCancel} />
    </>
  );
}

export function Done({ s, colors, outcome, peerName, onOpen, onRetry }: {
  s: S; colors: Palette; outcome: Outcome; peerName: string;
  onOpen: () => void; onRetry: () => void;
}) {
  const skipped = importSkipNote(outcome);
  return (
    <View style={s.center}>
      <View style={[s.tick, outcome.partial && { borderColor: colors.primary }]}>
        <Ionicons name={outcome.partial ? 'pause' : 'checkmark'} size={34} color={colors.primary} />
      </View>
      <Text style={s.h1}>{outcome.partial ? 'Import incomplete' : 'Conversation imported'}</Text>
      <Text style={s.sub} numberOfLines={2}>{peerName} · WhatsApp</Text>

      <Card style={s.summary}>
        <Row s={s} k="Messages imported" v={outcome.imported.toLocaleString()} />
        <Row s={s} k="Duplicates skipped" v={outcome.duplicates.toLocaleString()} />
        <Row s={s} k="Lines not read" v={outcome.unsupported.toLocaleString()} />
        <Row s={s} k="Media copied" v={`${outcome.mediaCopied}${outcome.mediaSkipped ? ` (${outcome.mediaSkipped} too large)` : ''}`} />
        {outcome.missingMedia > 0 && <Row s={s} k="Media not in the export" v={outcome.missingMedia.toLocaleString()} />}
        <Row s={s} k="Timestamps" v="Preserved as exported" />
      </Card>

      {skipped && <Text style={s.note}>{skipped}</Text>}

      {outcome.partial && (
        <Text style={s.note}>
          Everything imported so far is safe. Running the import again will only add what is missing.
        </Text>
      )}

      <Button title="Open conversation" fullWidth onPress={onOpen} />
      {outcome.partial && <Button title="Resume import" variant="ghost" fullWidth style={s.gap} onPress={onRetry} />}
    </View>
  );
}

function fmtMonth(ms: number): string {
  try { return new Date(ms).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }); }
  catch { return ''; }
}

// ─── Styles ──────────────────────────────────────────────────────────
//
// No fixed heights on anything that holds text: the whole screen scrolls, rows
// grow with dynamic type, and every name truncates rather than shoving the
// primary action off a small display.

export const makeImportStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  flex:     { flex: 1 },
  body:     { paddingHorizontal: SPACING.lg, paddingTop: SPACING.md },
  center:   { alignItems: 'center', paddingTop: SPACING.xl },

  h1:       { color: c.text, fontSize: 22, fontWeight: '900', textAlign: 'center', marginBottom: SPACING.sm },
  sub:      { color: c.textDim, fontSize: 14, lineHeight: 20, textAlign: 'center', marginBottom: SPACING.md },
  strong:   { color: c.text, fontWeight: '800' },
  label:    { color: c.textFaint, fontSize: 11, fontWeight: '800', letterSpacing: 0.8,
              marginTop: SPACING.lg, marginBottom: SPACING.sm },
  note:     { color: c.textFaint, fontSize: 12, lineHeight: 17, textAlign: 'center', marginBottom: SPACING.md },
  detail:   { color: c.textFaint, fontSize: 11, textAlign: 'center', marginBottom: SPACING.sm },
  reassure: { color: c.success, fontSize: 13, fontWeight: '700', textAlign: 'center', marginBottom: SPACING.md },
  gap:      { marginTop: SPACING.sm },

  privacy:    { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, alignSelf: 'center',
                backgroundColor: c.glassSoft, borderRadius: RADIUS.pill ?? 999,
                paddingHorizontal: SPACING.md, paddingVertical: SPACING.xs, marginBottom: SPACING.lg },
  privacyTxt: { color: c.textDim, fontSize: 12, flexShrink: 1 },

  srcRow:   { flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
              backgroundColor: c.glassSoft, borderRadius: RADIUS.lg ?? 16, borderWidth: 1, borderColor: c.glassStroke,
              paddingHorizontal: SPACING.md, paddingVertical: SPACING.md, marginBottom: SPACING.sm },
  srcRowOff:{ opacity: 0.55 },
  srcIcon:  { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  srcLabel: { color: c.text, fontSize: 16, fontWeight: '800' },
  srcHint:  { color: c.textFaint, fontSize: 12, marginTop: 2, lineHeight: 16 },
  soon:     { backgroundColor: c.glassSoft, borderRadius: 999, paddingHorizontal: SPACING.sm, paddingVertical: 3 },
  soonTxt:  { color: c.textDim, fontSize: 11, fontWeight: '700' },

  stepCard: { marginBottom: SPACING.lg },
  step:     { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.md,
              paddingVertical: SPACING.sm, borderBottomWidth: 1, borderBottomColor: c.hairline },
  stepNum:  { width: 22, height: 22, borderRadius: 11, backgroundColor: brandAlpha(0.18),
              alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  stepNumTxt:{ color: c.primary, fontSize: 11, fontWeight: '900' },
  stepLast: { borderBottomWidth: 0 },
  stepTxt:  { color: c.text, fontSize: 14, lineHeight: 20, flex: 1 },

  busySrc:  { color: c.text, fontSize: 18, fontWeight: '800', marginTop: SPACING.lg },
  busyNote: { color: c.textDim, fontSize: 14, marginTop: SPACING.xs, textAlign: 'center' },
  busyCount:{ color: c.textFaint, fontSize: 12, marginTop: SPACING.xs },
  bar:      { height: 6, borderRadius: 3, backgroundColor: c.glassSoft, width: '100%',
              marginTop: SPACING.md, overflow: 'hidden' },
  barFill:  { height: 6, borderRadius: 3, backgroundColor: c.primary },

  summary:  { marginBottom: SPACING.md },
  kv:       { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between',
              gap: SPACING.md, paddingVertical: SPACING.sm },
  kvK:      { color: c.textDim, fontSize: 13, flexShrink: 0 },
  kvV:      { color: c.text, fontSize: 13, fontWeight: '700', flexShrink: 1, textAlign: 'right' },

  match:    { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.xs, borderRadius: RADIUS.md ?? 12,
              padding: SPACING.md, marginBottom: SPACING.md, borderWidth: 1 },
  // tint(): follows the theme's success/danger whatever their colour format.
  matchOk:  { backgroundColor: tint(c.success, 0.10), borderColor: tint(c.success, 0.35) },
  matchMeh: { backgroundColor: brandAlpha(0.10), borderColor: brandAlpha(0.35) },
  matchBad: { backgroundColor: tint(c.danger, 0.10),  borderColor: tint(c.danger, 0.35) },
  matchTxt: { color: c.text, fontSize: 13, lineHeight: 18, flex: 1 },

  ackRow:   { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.md, marginBottom: SPACING.md },
  check:    { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: c.glassStroke,
              alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  checkOn:  { backgroundColor: c.primary, borderColor: c.primary },
  ackTxt:   { color: c.text, fontSize: 13, lineHeight: 19, flex: 1 },

  warnCard: { marginBottom: SPACING.md, borderColor: brandAlpha(0.4) },
  warnTitle:{ color: c.text, fontSize: 14, fontWeight: '800', marginBottom: SPACING.xs },
  warnBody: { color: c.textDim, fontSize: 13, lineHeight: 19 },
  pillRow:  { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, marginTop: SPACING.md },
  pill:     { borderWidth: 1, borderColor: c.glassStroke, borderRadius: 999, minHeight: 44, justifyContent: 'center',
              paddingHorizontal: SPACING.md, paddingVertical: SPACING.xs },
  pillOn:   { borderColor: c.primary, backgroundColor: brandAlpha(0.15) },
  pillTxt:  { color: c.textDim, fontSize: 12, fontWeight: '700' },
  pillTxtOn:{ color: c.text },

  tick:     { width: 76, height: 76, borderRadius: 38, backgroundColor: brandAlpha(0.15),
              borderWidth: 2, borderColor: c.success, alignItems: 'center', justifyContent: 'center',
              marginBottom: SPACING.md },
  failIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: tint(c.danger, 0.12),
              alignItems: 'center', justifyContent: 'center', marginBottom: SPACING.md },
});
