// app/import-chats.tsx — Exit Kit. Bring ONE conversation across, on this device.
//
// Design: openspec/changes/whatsapp-exit-kit.
//
// The product rule is the architecture here, not a label on it: this screen is
// built around a single target chatId and there is no code path that iterates
// conversations. That is deliberate. A bulk importer has to guess which export
// belongs to which contact, and a wrong guess writes one person's private history
// into another person's chat — silently, and irreversibly as far as the user is
// concerned. One conversation, one export, one confirmation, every time.
//
// Nothing here touches the network. The parser is pure and unreachable from the
// API layer, this file and its flow hook (components/chattools/useImportFlow)
// import neither, and lib/waImport.selftest.ts fails the build's check if this
// file or its parts ever gain a way off the device.

import React, { useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { SPACING } from '../constants/theme';
import { IMPORT_SOURCES } from '../constants/importSources';
import { useTheme } from '../lib/theme';
import { Header, Card, Button, AuroraBackground } from '../components/ui';
import { type WaFailure } from '../lib/waImport';
import {
  Done, PickChat, Preview, PrivacyNote, Step, makeImportStyles,
} from '../components/chattools/importChatsParts';
import { useImportFlow } from '../components/chattools/useImportFlow';

// The source list and its icons/tints come from constants/importSources, so the
// picker and the mark drawn on every imported message can never disagree about
// what WhatsApp (or Telegram, or Snapchat) looks like.

// ─── Flow (components/chattools/useImportFlow) ───────────────────────

const FAIL_COPY: Record<WaFailure, { title: string; body: string }> = {
  'not-an-archive':     { title: 'That file could not be read',
                          body: 'It does not look like a WhatsApp export. Pick the .zip WhatsApp produced, not a screenshot or a renamed file.' },
  'no-transcript':      { title: 'No conversation in that file',
                          body: 'The archive opened, but there is no chat transcript inside it.' },
  'unsupported-format': { title: 'Unrecognised export format',
                          body: 'The transcript did not match any WhatsApp format this version knows. Nothing was imported.' },
  'empty':              { title: 'Nothing to import',
                          body: 'That export contains no messages.' },
  'group-export':       { title: 'That is a group export',
                          body: 'It contains messages from more than two people, so it cannot go into a one-to-one chat. Importing it here would put other people’s messages in this conversation.' },
  'too-large':          { title: 'That export is too large',
                          body: 'The transcript exceeds the size this can safely read on a phone.' },
  'suspicious-archive': { title: 'That archive was refused',
                          body: 'It contains entries that are malformed or unsafe to open. Nothing was read from it.' },
};

// ─── Screen ──────────────────────────────────────────────────────────

export default function ImportChatsScreen() {
  const { colors } = useTheme();
  const s = useMemo(() => makeImportStyles(colors), [colors]);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ chatId?: string; peerName?: string }>();

  const {
    chatId, setChatId, peerName, setPeerName, stage, setStage, setSource,
    busyNote, failure, directChats, setDirectChats, chatsErr, setChatsErr,
    parsed, match, ackMismatch, setAckMismatch,
    dateOrder, setDateOrder, dateOrderAnswered, setDateOrderAnswered,
    progress, outcome, resumable, fileRef,
    runParse, pickFile, cancelParse, runImport, cancel,
  } = useImportFlow({ chatId: String(params.chatId ?? ''), peerName: String(params.peerName ?? '') });

  // ── render ────────────────────────────────────────────────────────

  const title = stage === 'pick-chat' ? 'Import a conversation' : 'Exit Kit';

  return (
    <View style={s.screen}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      <Header title={title} border />
      <ScrollView
        style={s.flex}
        contentContainerStyle={[s.body, { paddingBottom: insets.bottom + SPACING.xl }]}
        keyboardShouldPersistTaps="handled"
      >
        {stage === 'pick-chat' && (
          <PickChat
            s={s} colors={colors} chats={directChats}
            error={chatsErr} onRetry={() => { setChatsErr(false); setDirectChats(null); }}
            onPick={(c, name) => { setChatId(c); setPeerName(name); setStage('pick-source'); }}
          />
        )}

        {stage === 'pick-source' && (
          <>
            <Text style={s.h1}>Import one conversation at a time</Text>
            <Text style={s.sub}>
              Bringing <Text style={s.strong} numberOfLines={1}>{peerName}</Text>’s history into crazzychat.
              To import someone else, come back and do it separately.
            </Text>
            <PrivacyNote s={s} colors={colors} />

            {resumable && (
              <Card style={s.warnCard}>
                <Text style={s.warnTitle}>Import incomplete</Text>
                <Text style={s.warnBody}>
                  A previous import of this conversation did not finish. Running it again is safe —
                  messages already imported will not be duplicated.
                </Text>
              </Card>
            )}

            <Text style={s.label}>WHERE ARE THE MESSAGES NOW?</Text>
            {IMPORT_SOURCES.map(src => (
              <TouchableOpacity
                key={src.origin}
                activeOpacity={src.ready ? 0.7 : 1}
                disabled={!src.ready}
                onPress={() => { setSource(src.origin); setStage('pick-file'); }}
                style={[s.srcRow, !src.ready && s.srcRowOff]}
                accessibilityRole="button"
                accessibilityLabel={src.ready ? src.label : `${src.label}, coming next`}
                accessibilityState={{ disabled: !src.ready }}
              >
                <View style={[s.srcIcon, { backgroundColor: src.tint + '22' }]}>
                  <Ionicons name={src.icon} size={22} color={src.ready ? src.tint : colors.textFaint} />
                </View>
                <View style={s.flex}>
                  <Text style={[s.srcLabel, !src.ready && { color: colors.textDim }]} numberOfLines={1}>
                    {src.label}
                  </Text>
                  <Text style={s.srcHint} numberOfLines={2}>{src.hint}</Text>
                </View>
                {src.ready
                  ? <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
                  : <View style={s.soon}><Text style={s.soonTxt}>Coming next</Text></View>}
              </TouchableOpacity>
            ))}
          </>
        )}

        {stage === 'pick-file' && (
          <>
            <Text style={s.h1}>Select your WhatsApp export</Text>
            <Card style={s.stepCard}>
              <Step s={s} n={1} text="In WhatsApp, open your chat with this contact." />
              <Step s={s} n={2} text="Tap ⋮ → More → Export chat." />
              <Step s={s} n={3} text="Choose “With media” or “Without media”, then save the .zip." />
              <Step s={s} n={4} text="Come back here and pick that file." last />
            </Card>
            <PrivacyNote s={s} colors={colors} />
            <Button title="Choose export file" icon="document-attach-outline" fullWidth onPress={pickFile} />
            <Button title="Back" variant="ghost" fullWidth style={s.gap} onPress={() => setStage('pick-source')} />
          </>
        )}

        {(stage === 'reading' || stage === 'matching') && (
          <View style={s.center}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={s.busySrc}>WhatsApp export</Text>
            <Text style={s.busyNote}>{busyNote}</Text>
            <Button title="Cancel" variant="ghost" style={s.gap} onPress={cancelParse} />
          </View>
        )}

        {stage === 'preview' && parsed && (
          <Preview
            s={s} colors={colors} parsed={parsed} peerName={peerName} match={match}
            ack={ackMismatch} setAck={setAckMismatch}
            dateOrder={dateOrder} answered={dateOrderAnswered}
            onPickOrder={(o) => {
              setDateOrder(o); setDateOrderAnswered(true);
              const f = fileRef.current;
              if (f) void runParse(f.uri, f.size, o);   // failures land in its own catch
            }}
            onConfirm={runImport} onCancel={() => setStage('pick-source')}
          />
        )}

        {stage === 'importing' && (
          <View style={s.center}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={s.busySrc} numberOfLines={1}>{peerName}</Text>
            <Text style={s.busyNote}>{busyNote}</Text>
            {progress.total > 0 && (
              <>
                <View
                  style={s.bar}
                  accessible
                  accessibilityRole="progressbar"
                  accessibilityLabel="Import progress"
                  accessibilityValue={{ min: 0, max: progress.total, now: progress.done }}
                >
                  <View style={[s.barFill, { width: `${Math.round((progress.done / progress.total) * 100)}%` }]} />
                </View>
                <Text style={s.busyCount}>
                  {progress.done.toLocaleString()} of {progress.total.toLocaleString()}
                </Text>
              </>
            )}
            <Button title="Cancel" variant="ghost" style={s.gap} onPress={cancel} />
          </View>
        )}

        {stage === 'done' && outcome && (
          <Done
            s={s} colors={colors} outcome={outcome} peerName={peerName}
            onOpen={() => router.replace({ pathname: '/chat' as any, params: { chatId } })}
            onRetry={() => setStage('pick-file')}
          />
        )}

        {stage === 'failed' && failure && (
          <View style={s.center}>
            <View style={s.failIcon}><Ionicons name="alert-circle-outline" size={34} color={colors.danger} /></View>
            <Text numberOfLines={1} style={s.h1}>{FAIL_COPY[failure.reason].title}</Text>
            <Text style={s.sub}>{FAIL_COPY[failure.reason].body}</Text>
            {!!failure.detail && <Text style={s.detail} numberOfLines={3}>{failure.detail}</Text>}
            <Text style={s.reassure}>Nothing was imported and nothing was uploaded.</Text>
            <Button title="Choose a different file" fullWidth style={s.gap} onPress={() => setStage('pick-file')} />
            <Button title="Back" variant="ghost" fullWidth onPress={() => setStage('pick-source')} />
          </View>
        )}
      </ScrollView>
    </View>
  );
}
