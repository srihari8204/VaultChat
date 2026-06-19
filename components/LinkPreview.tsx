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

interface Props { url: string; }

export default function LinkPreview({ url }: Props) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [og, setOg] = useState<OGData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchOG(url).then(data => { setOg(data); setLoading(false); });
  }, [url]);

  if (loading) return <ActivityIndicator color={colors.accent} size="small" style={{ marginVertical: 6 }} />;
  if (!og || !og.title) return null;

  return (
    <TouchableOpacity style={s.card} onPress={() => Linking.openURL(url)}>
      {og.image ? <Image source={{ uri: og.image }} style={s.img} resizeMode="cover" /> : null}
      <View style={s.body}>
        <Text style={s.title} numberOfLines={2}>{og.title}</Text>
        {og.description ? <Text style={s.desc} numberOfLines={2}>{og.description}</Text> : null}
        <Text style={s.url} numberOfLines={1}>{url}</Text>
      </View>
    </TouchableOpacity>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  card:  { backgroundColor: c.surfaceSolid, borderRadius: 10, overflow: 'hidden', marginTop: 6, maxWidth: 240, borderWidth: 1, borderColor: c.border },
  img:   { width: '100%', height: 120 },
  body:  { padding: 10 },
  title: { color: c.text, fontSize: 13, fontWeight: '700', marginBottom: 4 },
  desc:  { color: c.textDim, fontSize: 11, lineHeight: 16, marginBottom: 4 },
  url:   { color: c.accent, fontSize: 10 },
});