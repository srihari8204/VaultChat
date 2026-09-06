// components/LinkPreview.tsx
// Renders an OG link preview card when a URL is in the message

import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet, Linking, ActivityIndicator } from 'react-native';
import { api } from '../lib/api';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';

interface OGData { title: string; description: string; image: string; url: string; }

// Extract the first URL from text.
export function extractUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s]+/);
  return m ? m[0] : null;
}

// Real Open Graph fetch via our own backend (SSRF-guarded; no third party sees
// the user's links, and no demo "sample" key).
async function fetchOG(url: string): Promise<OGData | null> {
  try {
    const data = await api<OGData>(`/link/preview?url=${encodeURIComponent(url)}`);
    return data && data.title ? data : null;
  } catch { return null; }
}

interface Props {
  url: string;
  /** Sender-embedded E2EE preview (F5): resolved on the SENDER's device and
   *  carried inside the encrypted payload. When present we render from it
   *  directly — no fetch, so neither this device nor the server ever touches
   *  the URL. Without it (legacy messages), fall back to the old
   *  server-proxied OG fetch. */
  data?: { u: string; t: string; d?: string; i?: string } | null;
}

export default function LinkPreview({ url, data }: Props) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [og, setOg] = useState<OGData | null>(null);
  const [loading, setLoading] = useState(!data);

  useEffect(() => {
    if (data) return;                       // embedded preview — never fetch
    fetchOG(url).then(d => { setOg(d); setLoading(false); });
  }, [url, data]);

  const title = data?.t ?? og?.title;
  const desc  = data?.d ?? og?.description;
  const image = data?.i ?? og?.image;
  const href  = data?.u ?? url;

  if (!data && loading) return <ActivityIndicator color={colors.accent} size="small" style={{ marginVertical: 6 }} />;
  if (!title) return null;

  return (
    <TouchableOpacity style={s.card} onPress={() => Linking.openURL(href)}>
      {image ? <Image source={{ uri: image }} style={s.img} resizeMode="cover" /> : null}
      <View style={s.body}>
        <Text style={s.title} numberOfLines={2}>{title}</Text>
        {desc ? <Text style={s.desc} numberOfLines={2}>{desc}</Text> : null}
        <Text style={s.url} numberOfLines={1}>{href}</Text>
      </View>
    </TouchableOpacity>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  card:  { backgroundColor: c.surfaceSolid, borderRadius: 10, overflow: 'hidden', marginTop: 6, maxWidth: 240, borderWidth: 1, borderColor: c.glassStroke },
  img:   { width: '100%', height: 120 },
  body:  { padding: 10 },
  title: { color: c.text, fontSize: 13, fontWeight: '700', marginBottom: 4 },
  desc:  { color: c.textDim, fontSize: 11, lineHeight: 16, marginBottom: 4 },
  url:   { color: c.accent, fontSize: 10 },
});