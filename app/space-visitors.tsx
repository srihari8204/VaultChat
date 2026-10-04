// app/space-visitors.tsx — visitor passes (Spaces & Operations, S4.4).
//
// Issue a time-boxed pass, and admit or sign out the person holding it.
//
// A VISITOR IS NOT A MEMBER, and this screen is where that stays true. Redeeming
// a pass logs an arrival and notifies the host; it grants no access to the
// space's members, messages, runs or location. There is deliberately no "add
// them to the space" shortcut here, because the moment that exists someone will
// use it for a courier.
//
// The code is a credential — it opens a door — so it is minted server-side with
// crypto/rand from an alphabet without I, O, 0 or 1, since it gets read aloud
// at a gate. Redemption is a conditional UPDATE, so two gates scanning the same
// code in the same second cannot both admit.

import { AppText as Text } from '../components/ui/Text';
import React, { useCallback, useMemo, useState } from 'react';
import {
  View, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity,
  Alert, TextInput, Modal, RefreshControl,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSpaceColors, spaceHeader } from '../lib/spaces/theme';
import type { SpacePalette as Palette } from '../lib/spaces/theme';
import {
  getVisitorPasses, issueVisitorPass, redeemVisitorPass, type VisitorPass,
} from '../lib/spaces/api';
import { AuroraBackground } from '../components/ui';
import { KeyboardSafe } from '../components/ui/KeyboardSafe';
import LoadError from '../components/spaces/LoadError';
import { circleMembers } from '../lib/family/circle';
import type { CircleMember } from '../lib/family/types';

const HOURS = [2, 4, 8, 24];

export default function SpaceVisitorsScreen() {
  const params = useLocalSearchParams<{ spaceId?: string; name?: string; groupType?: string }>();
  const colors = useSpaceColors(params.groupType);
  const spaceId = String(params.spaceId || '');

  const [passes, setPasses] = useState<VisitorPass[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [members, setMembers] = useState<CircleMember[]>([]);
  // Who the visitor is here to see. null = the issuer (the server's default).
  const [hostId, setHostId] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [name, setName] = useState('');
  const [hours, setHours] = useState(8);
  const [busy, setBusy] = useState(false);
  const [redeeming, setRedeeming] = useState(false);
  const [code, setCode] = useState('');

  const load = useCallback(async () => {
    try {
      setPasses(await getVisitorPasses(spaceId));
      setLoadError(null);
    } catch (e: any) {
      setLoadError(e?.message ?? 'Could not load passes.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
    // Hosts are optional to offer: without the member list the pass is issued
    // with the issuer as host, exactly as before.
    circleMembers(spaceId).then(setMembers).catch(() => {});
  }, [spaceId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // On site first, then still valid, then finished. An office looks at this
  // screen to answer "who is in the building", so that answer goes at the top.
  const ordered = useMemo(() => {
    const rank = (p: VisitorPass) => {
      if (p.redeemedAt && !p.exitedAt) return 0;          // inside now
      if (!p.redeemedAt && Date.parse(p.validTo) > Date.now()) return 1; // expected
      return 2;                                            // done or expired
    };
    return [...passes].sort((a, b) => rank(a) - rank(b) || Date.parse(b.validTo) - Date.parse(a.validTo));
  }, [passes]);

  const onIssue = useCallback(async () => {
    const visitorName = name.trim();
    if (!visitorName) return;
    setBusy(true);
    try {
      const res = await issueVisitorPass(spaceId, {
        visitorName,
        validTo: new Date(Date.now() + hours * 3600_000).toISOString(),
        ...(hostId ? { hostId } : {}),
      });
      setIssuing(false); setName(''); setHostId(null);
      await load();
      Alert.alert(
        `Pass for ${visitorName}`,
        `Code: ${res.code}\n\nGive this to them. It works once, and expires in ${hours} hours.`,
      );
    } catch (e: any) {
      Alert.alert('Could not issue', e?.message ?? 'Try again.');
    } finally {
      setBusy(false);
    }
  }, [name, hours, hostId, spaceId, load]);

  const onRedeem = useCallback(async (exit: boolean) => {
    const c = code.trim().toUpperCase();
    if (!c) return;
    setBusy(true);
    try {
      const res = await redeemVisitorPass(spaceId, c, exit);
      setRedeeming(false); setCode('');
      await load();
      Alert.alert(exit ? 'Signed out' : 'Admitted', res.visitorName ? `${res.visitorName}.` : 'Done.');
    } catch (e: any) {
      // The server answers expired, already-used and never-existed with ONE
      // message on purpose — distinguishing them turns the gate into an oracle
      // for guessing codes. Repeat it rather than inventing a more specific one.
      Alert.alert('Not valid', e?.message ?? 'That pass is not valid.');
    } finally {
      setBusy(false);
    }
  }, [code, spaceId, load]);

  const s = styles(colors);

  if (loading) {
    return (
      <View style={[s.screen, s.centre]}>
      <AuroraBackground />
        <Stack.Screen options={spaceHeader(colors, 'Visitors')} />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <Stack.Screen
        options={{
          ...spaceHeader(colors, params.name ? `${params.name} · Visitors` : 'Visitors'),
          headerRight: () => (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Issue a visitor pass" onPress={() => setIssuing(true)} style={{ paddingHorizontal: 8 }}>
              <Ionicons name="add" size={24} color={colors.primary} />
            </TouchableOpacity>
          ),
        }}
      />

      <ScrollView
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={colors.primary} />}
      >
        <TouchableOpacity style={s.scan} onPress={() => setRedeeming(true)} accessibilityRole="button">
          <Ionicons name="qr-code-outline" size={20} color={colors.primary} />
          <Text style={s.scanText}>Admit or sign out a visitor by code</Text>
        </TouchableOpacity>

        {loadError && (
          <LoadError colors={colors} title="Could not load passes" message={loadError} onRetry={() => { setLoading(true); void load(); }} />
        )}
        {!loadError && ordered.length === 0 && (
          <View style={s.card}>
            <Text style={s.cardTitle}>No passes yet</Text>
            <Text style={s.muted}>
              Issue one and give the visitor the code. A pass admits them to the building —
              it gives no access to this space’s people, messages or locations.
            </Text>
          </View>
        )}

        {ordered.map((p) => {
          const inside = !!p.redeemedAt && !p.exitedAt;
          const expired = !p.redeemedAt && Date.parse(p.validTo) < Date.now();
          return (
            <View key={p.id} style={[s.card, inside && s.inside, expired && s.spent]}>
              <View style={s.row}>
                <View style={[s.icon, { backgroundColor: (inside ? colors.success : colors.primary) + '22' }]}>
                  <Ionicons
                    name={inside ? 'walk' : p.exitedAt ? 'checkmark-done' : 'time-outline'}
                    size={18}
                    color={inside ? colors.success : colors.primary}
                  />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.cardTitle} numberOfLines={1}>{p.visitorName}</Text>
                  <Text style={s.muted} numberOfLines={1}>
                    {inside ? `On site since ${clock(p.redeemedAt!)}`
                      : p.exitedAt ? `Left at ${clock(p.exitedAt)}`
                        : expired ? 'Expired unused'
                          : `Expected · valid until ${clock(p.validTo)}`}
                  </Text>
                </View>
                {!p.redeemedAt && !expired && <Text style={s.code}>{p.code}</Text>}
              </View>
            </View>
          );
        })}

        <Text style={s.footnote}>
          A pass works once and cannot be reused. Arrivals notify the host, and every
          issue, admission and sign-out is recorded in the space’s audit log.
        </Text>
      </ScrollView>

      {/* issue */}
      <Modal visible={issuing} transparent animationType="fade" onRequestClose={() => setIssuing(false)}>
        <KeyboardSafe keyboardOnly>
        <View style={s.modalWrap}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>Issue a pass</Text>
            <TextInput
              style={s.input} value={name} onChangeText={setName} autoFocus
              placeholder="Visitor's name" placeholderTextColor={colors.textDim} maxLength={120}
            />
            <View style={s.hours}>
              {HOURS.map((h) => (
                <TouchableOpacity
                  key={h} onPress={() => setHours(h)}
                  accessibilityRole="radio" accessibilityState={{ checked: hours === h }}
                  accessibilityLabel={`Valid for ${h} hours`}
                  style={[s.hour, hours === h && { backgroundColor: colors.brandOnLight }]}
                >
                  <Text style={[s.hourText, hours === h && { color: '#fff' }]}>{h}h</Text>
                </TouchableOpacity>
              ))}
            </View>
            {members.length > 0 && (
              <>
                <Text style={s.muted}>Host — who they are here to see</Text>
                <ScrollView style={{ maxHeight: 132 }} contentContainerStyle={s.hours}>
                  {[{ id: null as string | null, name: 'Me' }, ...members.map((m) => ({ id: m.id as string | null, name: m.name }))].map((m) => (
                    <TouchableOpacity
                      key={m.id ?? 'me'} onPress={() => setHostId(m.id)}
                      accessibilityRole="radio" accessibilityState={{ checked: hostId === m.id }}
                      accessibilityLabel={`Host: ${m.name}`}
                      style={[s.hour, hostId === m.id && { backgroundColor: colors.brandOnLight }]}
                    >
                      <Text numberOfLines={1} style={[s.hourText, hostId === m.id && { color: '#fff' }]}>{m.name}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </>
            )}
            <View style={s.modalRow}>
              <TouchableOpacity style={s.modalBtn} onPress={() => setIssuing(false)} accessibilityRole="button">
                <Text style={s.muted}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.modalBtn, s.solid, (!name.trim() || busy) && s.off]}
                onPress={onIssue} disabled={!name.trim() || busy}
                accessibilityRole="button" accessibilityLabel="Issue pass"
              >
                {busy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={s.solidText}>Issue</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
        </KeyboardSafe>
      </Modal>

      {/* redeem */}
      <Modal visible={redeeming} transparent animationType="fade" onRequestClose={() => setRedeeming(false)}>
        <KeyboardSafe keyboardOnly>
        <View style={s.modalWrap}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>Visitor code</Text>
            <TextInput
              style={[s.input, s.codeInput]} value={code} onChangeText={setCode} autoFocus
              placeholder="ABC234" placeholderTextColor={colors.textDim}
              autoCapitalize="characters" maxLength={8}
            />
            <View style={s.modalRow}>
              <TouchableOpacity style={s.modalBtn} onPress={() => setRedeeming(false)} accessibilityRole="button">
                <Text style={s.muted}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.modalBtn, s.ghost, (!code.trim() || busy) && s.off]}
                onPress={() => onRedeem(true)} disabled={!code.trim() || busy}
                accessibilityRole="button" accessibilityLabel="Sign visitor out"
              >
                <Text style={s.ghostText}>Sign out</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.modalBtn, s.solid, (!code.trim() || busy) && s.off]}
                onPress={() => onRedeem(false)} disabled={!code.trim() || busy}
                accessibilityRole="button" accessibilityLabel="Admit visitor"
              >
                {busy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={s.solidText}>Admit</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
        </KeyboardSafe>
      </Modal>
    </View>
  );
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const styles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  centre: { alignItems: 'center', justifyContent: 'center' },
  body: { padding: 16, gap: 10, paddingBottom: 40 },
  scan: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderWidth: 1, borderColor: c.primary, borderRadius: 12, padding: 14,
  },
  scanText: { color: c.primary, fontWeight: '600', flex: 1 },
  card: { backgroundColor: c.glassSoft, borderRadius: 14, padding: 14, gap: 6 },
  inside: { borderWidth: 1, borderColor: c.success },
  spent: { opacity: 0.55 },
  cardTitle: { color: c.text, fontSize: 15.5, fontWeight: '700' },
  muted: { color: c.textDim, fontSize: 12.5, flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  code: { color: c.text, fontWeight: '700', letterSpacing: 2, fontVariant: ['tabular-nums'] },
  modalWrap: { flex: 1, backgroundColor: '#0008', alignItems: 'center', justifyContent: 'center', padding: 22 },
  modal: { width: '100%', backgroundColor: c.bg, borderRadius: 16, padding: 20, gap: 10 },
  modalTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  input: { borderWidth: 1, borderColor: c.glassStroke, borderRadius: 10, padding: 12, color: c.text, fontSize: 15 },
  codeInput: { fontSize: 22, letterSpacing: 6, textAlign: 'center' },
  hours: { flexDirection: 'row', gap: 8 },
  hour: { borderWidth: 1, borderColor: c.glassStroke, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7 },
  hourText: { color: c.textDim, fontSize: 13 },
  modalRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  modalBtn: { paddingHorizontal: 16, paddingVertical: 12, borderRadius: 10 },
  ghost: { borderWidth: 1, borderColor: c.glassStroke },
  ghostText: { color: c.text, fontWeight: '600' },
  solid: { backgroundColor: c.brandOnLight },
  solidText: { color: '#fff', fontWeight: '700' },
  off: { opacity: 0.4 },
  footnote: { color: c.textFaint, fontSize: 11.5, lineHeight: 16 },
});
