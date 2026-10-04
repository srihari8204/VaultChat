// components/notes/useNoteAttachments.ts — app/encrypted-notes.tsx's attach and
// open handlers (moved out of the screen; behaviour unchanged apart from typed
// catches). Every file is sealed with the notes key before it touches disk
// (lib/notesAttachments). The system pickers and the share sheet go through
// the screen's `withSystemUi` bracket so they do not trigger its re-lock.

import { useState, type Dispatch, type SetStateAction } from 'react';
import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import {
  addAttachment, closeOpenedAttachments, isImage, openAttachment, type NoteAttachment,
} from '../../lib/notesAttachments';
import { permissionDenied } from '../../lib/permissionDenied';

interface Options {
  withSystemUi: <T>(fn: () => Promise<T>) => Promise<T>;
  setAttachments: Dispatch<SetStateAction<NoteAttachment[]>>;
  /** Show a decrypted image copy in the screen's viewer. */
  onImage: (uri: string) => void;
  /** False until the stored notes have opened: attaching would mint a key. */
  canAttach: () => boolean;
}

const messageOf = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export function useNoteAttachments({ withSystemUi, setAttachments, onImage, canAttach }: Options) {
  const [attaching, setAttaching] = useState(false);

  const attachImage = async () => {
    const perm = await withSystemUi(() => ImagePicker.requestMediaLibraryPermissionsAsync());
    if (!perm.granted) { permissionDenied('Permission needed', 'Allow photo access to attach an image.', perm.canAskAgain); return; }
    const res = await withSystemUi(() => ImagePicker.launchImageLibraryAsync({ quality: 0.9 }));
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    setAttaching(true);
    try {
      const att = await addAttachment(a.uri, a.fileName ?? `image_${Date.now()}.jpg`, a.mimeType ?? 'image/jpeg');
      setAttachments(prev => [...prev, att]);
    } catch (e: unknown) {
      Alert.alert('Could not attach', messageOf(e, 'Try again'));
    } finally { setAttaching(false); }
  };

  const attachFile = async () => {
    const res = await withSystemUi(() => DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true }));
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    setAttaching(true);
    try {
      const att = await addAttachment(a.uri, a.name, a.mimeType ?? 'application/octet-stream');
      setAttachments(prev => [...prev, att]);
    } catch (e: unknown) {
      Alert.alert('Could not attach', messageOf(e, 'Try again'));
    } finally { setAttaching(false); }
  };

  const addAttachmentMenu = () => {
    if (!canAttach()) return;
    Alert.alert('Add attachment', 'Encrypted with your notes key before it touches disk.', [
      { text: 'Photo / Image', onPress: attachImage },
      { text: 'File', onPress: attachFile },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const openAttachmentFile = async (att: NoteAttachment) => {
    try {
      const uri = await openAttachment(att);
      if (!uri) { Alert.alert('Could not open', 'This attachment is unavailable or corrupted.'); return; }
      if (isImage(att)) { onImage(uri); return; }   // the viewer deletes it on close
      try {
        if (await Sharing.isAvailableAsync()) await withSystemUi(() => Sharing.shareAsync(uri, { mimeType: att.mime, dialogTitle: att.name }));
        else Alert.alert('Cannot open', 'This device has no app to open the file with.');
      } finally {
        // ponytail: the decrypted copy goes as soon as the share sheet returns
        // (as app/vault.tsx does). A target that reads the file lazily, after
        // the sheet closes, would find it gone; keep it longer only if a device
        // check shows one.
        await closeOpenedAttachments();
      }
    } catch (e: unknown) {
      Alert.alert('Could not open', messageOf(e, 'This attachment could not be opened. Try again.'));
    }
  };

  return { attaching, addAttachmentMenu, openAttachmentFile };
}
