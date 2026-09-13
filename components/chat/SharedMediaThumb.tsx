// components/chat/SharedMediaThumb.tsx — one tile of a "Shared Media" grid.
//
// Lifted verbatim out of app/contact-info.tsx when app/group-info.tsx grew the
// same grid: decrypting an attachment thumbnail is thirty lines of real crypto
// wiring, and the second copy would have been the one that rotted. Both screens
// now render this.
//
// Decrypts encrypted attachments (recovering the per-file key from the message
// content) to a local file; renders plaintext via the auth'd /uploads URL.
// Falls back to a placeholder icon while resolving / on failure.

import { useEffect, useMemo, useState } from 'react';
import { Image, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../../constants/theme';
import { useTheme } from '../../lib/theme';
import { attachmentUrl, decryptFromChat, type Message } from '../../lib/chatService';
import { getDecryptedAttachmentUri, parseMediaContent } from '../../lib/mediaAttachments';

export default function SharedMediaThumb({ m, chatId, authHeader, size, onPress }: {
  m: Message;
  chatId?: string;
  authHeader: string | null;
  /** Tile edge in px — the caller owns the grid maths. */
  size: number;
  onPress?: () => void;
}) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [src, setSrc] = useState<{ uri: string; headers?: Record<string, string> } | null>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const aid = m.meta?.attachmentId;
      if (!aid) return;
      if (m.meta?.encrypted) {
        try {
          const plain = await decryptFromChat(String(chatId || ''), m.senderId, m.content, m.id);
          await parseMediaContent(aid, plain);
          const r = await getDecryptedAttachmentUri(aid);
          if (!cancel) setSrc(r);
        } catch { /* leave placeholder */ }
      } else if (authHeader) {
        if (!cancel) setSrc({ uri: attachmentUrl(aid), headers: { Authorization: authHeader } });
      }
    })();
    return () => { cancel = true; };
  }, [m, chatId, authHeader]);

  const inner = (
    <>
      {src
        ? <Image source={src} style={s.img} />
        : <Ionicons name={m.type === 'video' ? 'videocam' : 'image'} size={24} color={colors.textFaint} />}
      {m.type === 'video' && <View style={s.videoBadge}><Ionicons name="play" size={12} color="#fff" /></View>}
    </>
  );

  // No handler → a plain tile, which is what contact-info has always rendered.
  if (!onPress) return <View style={[s.tile, { width: size, height: size }]}>{inner}</View>;
  return (
    <TouchableOpacity
      style={[s.tile, { width: size, height: size }]}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityLabel={m.type === 'video' ? 'Shared video' : 'Shared photo'}
    >
      {inner}
    </TouchableOpacity>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  // layout-exempt: a square media tile carries no text — the image IS the content.
  tile: { borderRadius: 8, backgroundColor: c.surfaceSolid, justifyContent: 'center', alignItems: 'center', overflow: 'hidden' },
  img: { width: '100%', height: '100%' },
  videoBadge: { position: 'absolute', width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
});
