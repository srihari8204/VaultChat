// components/notes/NotesModals.tsx — the PIN gate and the smaller modals of
// app/encrypted-notes.tsx (moved out of the screen in the round-4 split).

import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { View, TouchableOpacity, FlatList, Modal, Image } from 'react-native';
import { Stack } from 'expo-router';
import { AppText as Text } from '../ui/Text';
import { AuroraBackground } from '../ui';
import { PinPad } from '../PinPad';
import { useTheme } from '../../lib/theme';
import { PIN_MAX, PIN_MIN } from '../../services/security/pinFormat';
import type { Note } from './notesModel';
import { useNotesStyles } from './notesStyles';
import { MEDIA_INK } from '../../constants/mediaChrome';

/**
 * The screen gate: the server-verified sign-in MPIN, 4–8 digits.
 *
 * An in-app keypad, NOT a TextInput. Device-proven on the Redmi: the soft
 * keyboard never opened for this gate — the field held focus while dumpsys
 * reported mShowRequested=false and the IME never bound to the app's window at
 * all, so the gate could not be passed. Android does not guarantee the IME on
 * programmatic focus (a real tap is the reliable trigger) and MIUI is strict
 * about it. components/PinPad has no IME dependency, so there is nothing left
 * to refuse.
 *
 * The pad used to have the default fixed length of 6 while the check accepted
 * 4–8, so a 4-, 5-, 7- or 8-digit MPIN could not be entered. It now takes up to
 * PIN_MAX digits with a ✓ key from PIN_MIN, like the Vault's gate.
 */
export function NotesPinGate({ pin, err, onChange, onSubmit, onCancel }: {
  pin: string; err: string | null;
  onChange: (v: string) => void; onSubmit: (v: string) => void; onCancel: () => void;
}) {
  const { colors } = useTheme();
  const s = useNotesStyles();
  return (
    <View style={[s.screen, { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }]}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      <Ionicons name="lock-closed" size={40} color={colors.primary} style={{ marginBottom: 16 }} importantForAccessibility="no" accessibilityElementsHidden />
      <Text style={{ color: colors.text, fontSize: 16, marginBottom: 16 }} accessibilityRole="header">Enter your PIN</Text>
      <Text style={{ color: colors.textDim, fontSize: 13, marginBottom: 12 }} accessibilityLabel="Enter your PIN, then tap Unlock">Enter your PIN, then tap ✓</Text>
      <PinPad
        value={pin}
        onChange={onChange}
        length={PIN_MAX}
        minLength={PIN_MIN}
        onSubmit={onSubmit}
        onComplete={onSubmit}
        error={!!err}
      />
      {!!err && <Text style={{ color: colors.danger, marginTop: 12 }} accessibilityLiveRegion="polite">{err}</Text>}
      <TouchableOpacity onPress={onCancel} style={s.textBtn} accessibilityRole="button" accessibilityLabel="Cancel and go back">
        <Text style={{ color: colors.textDim }}>Cancel</Text>
      </TouchableOpacity>
    </View>
  );
}

export function PasswordGeneratorModal({ visible, password, onRegenerate, onCopy, onClose }: {
  visible: boolean; password: string; onRegenerate: () => void; onCopy: () => void; onClose: () => void;
}) {
  const { colors } = useTheme();
  const s = useNotesStyles();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.passModal}>
        <View style={s.passCard}>
          <Text style={s.passTitle} accessibilityRole="header">Password Generator</Text>
          <View style={s.passDisplay}>
            <Text style={s.passText} selectable>{password}</Text>
          </View>
          <View style={s.passActions}>
            <TouchableOpacity style={s.passBtn} onPress={onRegenerate} accessibilityRole="button" accessibilityLabel="Regenerate password">
              <Text style={s.passBtnTxt}>Regenerate</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.passBtn, { backgroundColor: colors.primary }]} onPress={onCopy}
              accessibilityRole="button" accessibilityLabel="Copy password, clipboard clears in 30 seconds">
              <Text style={[s.passBtnTxt, { color: colors.onPrimary }]}>Copy</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity onPress={onClose} style={[s.textBtn, { alignSelf: 'center', marginTop: 12 }]} accessibilityRole="button" accessibilityLabel="Close">
            <Text style={{ color: colors.textDim, textAlign: 'center' }}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

/** Encrypted image viewer — always dark behind the photo, in both themes. */
export function ImageViewerModal({ uri, onClose }: { uri: string | null; onClose: () => void }) {
  const s = useNotesStyles();
  return (
    <Modal visible={!!uri} transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.imgViewer}>
        {uri && <Image source={{ uri }} style={s.imgViewerImg} resizeMode="contain" accessibilityLabel="Attached image" />}
        <TouchableOpacity style={s.imgViewerClose} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close image">
          {/* Fixed ink (constants/mediaChrome): this viewer is always dark behind the photo. */}
          <Text style={{ color: MEDIA_INK, fontSize: 16, fontWeight: '700' }}>Close</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

export function TrashModal({ visible, notes, onClose, onRestore, onDeleteForever }: {
  visible: boolean; notes: Note[]; onClose: () => void;
  onRestore: (id: string) => void; onDeleteForever: (id: string) => void;
}) {
  const { colors } = useTheme();
  const s = useNotesStyles();
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={s.editorScreen}>
        <View style={s.editorHeader}>
          <TouchableOpacity onPress={onClose} style={[s.textBtn, { flexDirection: 'row', alignItems: 'center', gap: 4 }]} accessibilityRole="button" accessibilityLabel="Back">
            <Ionicons name="arrow-back" size={16} color={colors.textDim} />
            <Text style={s.editorCancel}>Back</Text>
          </TouchableOpacity>
          <Text style={s.editorTitle} accessibilityRole="header">Secure Trash</Text>
          <View style={{ width: 50 }} />
        </View>
        <FlatList
          data={notes}
          keyExtractor={n => n.id}
          contentContainerStyle={{ padding: 16 }}
          renderItem={({ item: n }) => (
            <View style={s.trashCard}>
              <Text numberOfLines={1} style={s.trashTitle}>{n.title}</Text>
              <Text style={s.trashDate}>Deleted {n.deletedAt ? new Date(n.deletedAt).toLocaleDateString() : ''}</Text>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                <TouchableOpacity style={s.trashRestore} onPress={() => onRestore(n.id)} accessibilityRole="button" accessibilityLabel={`Restore ${n.title}`}>
                  <Text style={{ color: colors.primary, fontWeight: '600', fontSize: 13 }}>Restore</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.trashDelete} onPress={() => onDeleteForever(n.id)} accessibilityRole="button" accessibilityLabel={`Delete ${n.title} forever`}>
                  <Text style={{ color: colors.danger, fontWeight: '600', fontSize: 13 }}>Delete Forever</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
          ListEmptyComponent={<Text style={{ color: colors.textDim, textAlign: 'center', marginTop: 40 }}>Trash is empty</Text>}
        />
      </View>
    </Modal>
  );
}

/** Per-note lock challenge — nothing of the note renders until it passes.
 *  Same keypad and the same 4–8 digit MPIN as the screen gate. */
export function LockChallengeModal({ note, pin, err, onChange, onSubmit, onCancel }: {
  note: Note | null; pin: string; err: string | null;
  onChange: (v: string) => void; onSubmit: (v?: string) => void; onCancel: () => void;
}) {
  const { colors } = useTheme();
  const s = useNotesStyles();
  return (
    <Modal visible={!!note} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={s.passModal}>
        <View style={s.passCard}>
          <Text style={s.passTitle} accessibilityRole="header">Locked note</Text>
          <Text style={{ color: colors.textDim, textAlign: 'center', marginBottom: 12 }}>
            Enter your PIN to open “{note?.title}”
          </Text>
          <PinPad
            value={pin}
            onChange={onChange}
            length={PIN_MAX}
            minLength={PIN_MIN}
            onComplete={(v) => onSubmit(v)}
            error={!!err}
          />
          {!!err && <Text style={{ color: colors.danger, textAlign: 'center', marginBottom: 8 }} accessibilityLiveRegion="polite">{err}</Text>}
          <View style={s.passActions}>
            <TouchableOpacity style={s.passBtn} onPress={onCancel} accessibilityRole="button" accessibilityLabel="Cancel">
              <Text style={s.passBtnTxt}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.passBtn, { backgroundColor: colors.primary }]} onPress={() => onSubmit()} accessibilityRole="button" accessibilityLabel="Unlock note">
              <Text style={[s.passBtnTxt, { color: colors.onPrimary }]}>Unlock</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}
