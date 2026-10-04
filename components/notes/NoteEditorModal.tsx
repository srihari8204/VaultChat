// components/notes/NoteEditorModal.tsx — the note editor of app/encrypted-notes.tsx
// (moved out of the screen in the round-4 split). Saving, attaching and the
// draft/discard rules stay in the screen; this renders the fields.

import { Ionicons } from '@expo/vector-icons';
import React, { useEffect } from 'react';
import { View, TouchableOpacity, TextInput, Modal, ScrollView, ActivityIndicator, Alert } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { AppText as Text } from '../ui/Text';
import { KeyboardSafe } from '../ui/KeyboardSafe';
import { useDatePicker } from '../ui/useDatePicker';
import { useTheme } from '../../lib/theme';
import { isImage, prettySize, type NoteAttachment } from '../../lib/notesAttachments';
import { CATEGORIES, TAG_COLORS } from './notesModel';
import { mdStyles, useNotesStyles } from './notesStyles';
import type { NoteEditor } from './useNoteEditor';

export function NoteEditorModal({
  visible, ed, isEdit, canSave, attaching, onCancel, onSave, onAttach, onOpenAttachment, onCopy,
}: {
  visible: boolean;
  ed: NoteEditor;
  isEdit: boolean;
  /** False while the stored notes could not be opened (saving would overwrite them). */
  canSave: boolean;
  attaching: boolean;
  onCancel: () => void;
  onSave: () => void;
  onAttach: () => void;
  onOpenAttachment: (att: NoteAttachment) => void;
  onCopy: (text: string) => void;
}) {
  const { colors } = useTheme();
  const s = useNotesStyles();
  const f = ed.fields;
  // inModal: on iOS the sheet is drawn inline over this Modal instead of as a
  // second Modal, which can present behind the first (useDatePicker header).
  const picker = useDatePicker(undefined, { inModal: true });
  const closePicker = picker.close;
  useEffect(() => { if (!visible) closePicker(); }, [visible, closePicker]);

  // Removing only detaches it from the draft; the encrypted file is deleted
  // when the note is SAVED without it. Deleting immediately meant Cancel left
  // the saved note pointing at a file that no longer existed.
  const removeAttachment = (att: NoteAttachment) => {
    ed.setAttachments(prev => prev.filter(x => x.id !== att.id));
  };

  // Reminder: date, then time (one picker on both platforms). A moment that
  // has already passed is refused, as before.
  const pickReminder = () => {
    const base = f.reminder ?? Date.now() + 60 * 60 * 1000;
    picker.open(new Date(base), (at) => {
      if (at.getTime() <= Date.now()) { Alert.alert('Pick a future time', 'That moment has already passed.'); return; }
      ed.setReminder(at.getTime());
    }, 'datetime');
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
    <KeyboardSafe keyboardOnly>
    <View style={s.editorScreen}>
      <View style={s.editorHeader}>
        <TouchableOpacity onPress={onCancel} accessibilityRole="button" accessibilityLabel="Cancel editing" style={s.textBtn}>
          <Text style={s.editorCancel}>Cancel</Text>
        </TouchableOpacity>
        <Text style={s.editorTitle} accessibilityRole="header">{isEdit ? 'Edit Note' : 'New Note'}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <TouchableOpacity onPress={() => ed.setPreview(p => !p)} style={s.textBtn} accessibilityRole="button"
            accessibilityLabel={ed.preview ? 'Back to editing' : 'Preview formatting'}>
            <Text style={[s.editorCancel, ed.preview && { color: colors.primary }]}>{ed.preview ? 'Edit' : 'Preview'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onSave} disabled={!canSave} style={s.textBtn} accessibilityRole="button" accessibilityLabel="Save note" accessibilityState={{ disabled: !canSave }}>
            <Text style={s.editorSave}>Save</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView style={s.editorBody}>
        <TextInput style={s.editorTitleInput} placeholder="Title" placeholderTextColor={colors.textFaint} value={f.title} onChangeText={ed.setTitle} accessibilityLabel="Title" />

        {/* Category picker */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 8 }}>
          {CATEGORIES.map(cat => (
            <TouchableOpacity key={cat.key} hitSlop={4} style={[s.edCatChip, f.category === cat.key && { backgroundColor: cat.color + '20', borderColor: cat.color }]} onPress={() => ed.setCategory(cat.key)}
              accessibilityRole="radio" accessibilityLabel={`Category ${cat.name}`} accessibilityState={{ checked: f.category === cat.key, selected: f.category === cat.key }}>
              <Text style={{ fontSize: 14 }} importantForAccessibility="no" accessibilityElementsHidden>{cat.icon}</Text>
              <Text numberOfLines={1} style={[s.edCatTxt, f.category === cat.key && { color: cat.color }]}>{cat.name}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Markdown content (#142): edit with a formatting toolbar, or preview rendered */}
        {ed.preview ? (
          <View style={s.mdPreview}>
            {f.content.trim()
              ? <Markdown style={mdStyles(colors)}>{f.content}</Markdown>
              : <Text style={{ color: colors.textFaint }}>Nothing to preview yet.</Text>}
          </View>
        ) : (
          <>
            <View style={s.mdBar}>
              {([
                ['B', 'Bold', () => ed.wrapSelection('**', '**')],
                ['I', 'Italic', () => ed.wrapSelection('_', '_')],
                ['H', 'Heading', () => ed.prefixLine('# ')],
                ['• List', 'List item', () => ed.prefixLine('- ')],
                ['❝', 'Quote', () => ed.prefixLine('> ')],
                ['‹›', 'Code', () => ed.wrapSelection('`', '`')],
                ['🔗', 'Link', () => ed.wrapSelection('[', '](https://)')],
              ] as [string, string, () => void][]).map(([label, name, fn]) => (
                <TouchableOpacity key={label} style={s.mdBtn} onPress={fn} accessibilityRole="button" accessibilityLabel={name}>
                  <Text style={s.mdBtnTxt}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TextInput
              style={s.editorContent}
              placeholder="Note content… (Markdown supported — tap Preview)"
              placeholderTextColor={colors.textFaint}
              accessibilityLabel="Note content"
              value={f.content}
              onChangeText={ed.setContent}
              onSelectionChange={(e) => ed.setSel(e.nativeEvent.selection)}
              multiline
              textAlignVertical="top"
            />
          </>
        )}

        {/* Attachments (encrypted) */}
        <View style={s.edSection}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={s.edLabel}>Attachments {f.attachments.length > 0 ? `(${f.attachments.length})` : ''}</Text>
            <TouchableOpacity onPress={onAttach} disabled={attaching || !canSave} style={s.attachBtn} accessibilityRole="button" accessibilityLabel="Attach a file" accessibilityState={{ disabled: attaching || !canSave, busy: attaching }}>
              {attaching ? <ActivityIndicator size="small" color={colors.primary} /> : <Text style={s.attachBtnTxt}>＋ Attach</Text>}
            </TouchableOpacity>
          </View>
          <Text style={s.attachHint}>Encrypted with your notes key before it’s written to disk.</Text>
          {f.attachments.map(att => (
            <View key={att.id} style={s.attachRow}>
              <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 10 }} onPress={() => onOpenAttachment(att)}
                accessibilityRole="button" accessibilityLabel={`Open ${att.name}, ${prettySize(att.size)}`}>
                <Ionicons name={isImage(att) ? 'image-outline' : 'attach-outline'} size={20} color={colors.textDim} />
                <View style={{ flex: 1 }}>
                  <Text style={s.attachName} numberOfLines={1}>{att.name}</Text>
                  <Text style={s.attachMeta}>{prettySize(att.size)} · tap to open</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => removeAttachment(att)} hitSlop={14} accessibilityRole="button" accessibilityLabel={`Remove ${att.name}`}>
                <Ionicons name="close" size={16} color={colors.danger} />
              </TouchableOpacity>
            </View>
          ))}
        </View>

        {/* Tags */}
        <View style={s.edSection}>
          <Text style={s.edLabel}>Tags & Color Labels</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            {TAG_COLORS.map((c, i) => (
              <TouchableOpacity hitSlop={8} key={c} style={[s.colorDot, { backgroundColor: c }, f.tagColor === c && s.colorDotActive]} onPress={() => ed.setTagColor(c)}
                accessibilityRole="radio" accessibilityLabel={`Tag colour ${i + 1} of ${TAG_COLORS.length}`} accessibilityState={{ checked: f.tagColor === c, selected: f.tagColor === c }} />
            ))}
          </ScrollView>
          <TextInput style={s.tagInput} placeholder="Add tag (press enter)" placeholderTextColor={colors.textFaint} accessibilityLabel="Add tag"
            onSubmitEditing={(e) => { if (e.nativeEvent.text.trim()) { ed.setTags([...f.tags, e.nativeEvent.text.trim()]); } }}
            blurOnSubmit={false}
          />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {f.tags.map((t, i) => (
              <TouchableOpacity key={`${t}-${i}`} hitSlop={6} style={[s.tag, s.tagChip, { backgroundColor: f.tagColor + '20' }]} onPress={() => ed.setTags(f.tags.filter((_, j) => j !== i))}
                accessibilityRole="button" accessibilityLabel={`Remove tag ${t}`}>
                <Text style={[s.tagTxt, { color: f.tagColor }]}>{t} {'\u2715'}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Toggles */}
        <View style={s.edSection}>
          <TouchableOpacity style={s.edToggle} onPress={() => ed.setSensitive(v => !v)}
            accessibilityRole="switch" accessibilityLabel="Sensitive field" accessibilityState={{ checked: f.sensitive }}>
            <Ionicons name={f.sensitive ? 'eye-off-outline' : 'eye-outline'} size={20} color={colors.textDim} />
            <Text style={s.edToggleTxt}>Sensitive Field {f.sensitive ? '(ON)' : '(OFF)'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.edToggle} onPress={() => ed.setLocked(l => !l)}
            accessibilityRole="switch" accessibilityLabel="PIN lock this note" accessibilityState={{ checked: f.locked }}>
            <Ionicons name={f.locked ? 'lock-closed-outline' : 'lock-open-outline'} size={20} color={colors.textDim} />
            <Text style={s.edToggleTxt}>PIN Lock {f.locked ? '(ON)' : '(OFF)'}</Text>
          </TouchableOpacity>

          {/* Reminder (feature #12) — armed as an OS alarm on save. The
              picker is the app's shared one (components/ui/useDatePicker):
              Android's native dialogs; on iOS an overlay drawn inside this
              Modal (inModal), where the row used to say Android-only. */}
          <View style={s.edToggle}>
            <TouchableOpacity style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 }} onPress={pickReminder}
              accessibilityRole="button" accessibilityLabel={f.reminder ? `Reminder ${new Date(f.reminder).toLocaleString()}. Change` : 'Set a reminder'}>
              <Ionicons name="alarm-outline" size={20} color={colors.textDim} />
              <Text style={s.edToggleTxt}>
                {f.reminder ? `Reminder ${new Date(f.reminder).toLocaleString()}` : 'Reminder (none)'}
              </Text>
            </TouchableOpacity>
            {!!f.reminder && (
              <TouchableOpacity onPress={() => ed.setReminder(undefined)} hitSlop={14} accessibilityRole="button" accessibilityLabel="Clear reminder">
                <Ionicons name="close" size={16} color={colors.danger} />
              </TouchableOpacity>
            )}
          </View>
          {!!f.reminder && (f.locked || f.sensitive) && (
            <Text style={s.attachHint}>
              The alert will not show this note’s title on your lock screen.
            </Text>
          )}
        </View>

        {/* Copy button for passwords */}
        {f.content.length > 0 && f.category === 'passwords' && (
          <TouchableOpacity style={s.copyBtn} onPress={() => onCopy(f.content)} accessibilityRole="button" accessibilityLabel="Copy note, clipboard clears in 30 seconds">
            <Text style={s.copyBtnTxt}>Copy (auto-clears in 30s)</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </View>
    </KeyboardSafe>
    {/* Last child of the editor's Modal: the iOS sheet is an absolute overlay
        over the editor, not a nested Modal (📱 check on a device). */}
    {picker.element}
    </Modal>
  );
}
