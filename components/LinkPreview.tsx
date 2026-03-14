// components/LinkPreview.tsx
// Renders an OG link preview card when a URL is in the message

import React, { useEffect, useState } from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet, Linking, ActivityIndicator } from 'react-native';

interface OGData { title: string; description: string; image: string; url: string; }

// Extract URLs from text
export function extractUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s]+/);
  return m ? m[0] : null;
}

async function fetchOG(url: string): Promise<OGData | null> {
  try {
    // Use a free OG parser proxy (no key needed)
    const res  = await fetch(`https://opengraph.io/api/1.1/site/${encodeURIComponent(url)}?app_id=sample_id`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    const og   = data.openGraph ?? data.htmlInferred ?? {};
    return {
      title:       og.title ?? '',
      description: og.description ?? '',
      image:       og.image?.url ?? og.image ?? '',
      url,
    };
  } catch { return null; }
}

interface Props { url: string; }

export default function LinkPreview({ url }: Props) {
  const [og, setOg] = useState<OGData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchOG(url).then(data => { setOg(data); setLoading(false); });
  }, [url]);

  if (loading) return <ActivityIndicator color="#00E5FF" size="small" style={{ marginVertical: 6 }} />;
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

const s = StyleSheet.create({
  card:  { backgroundColor: '#0A0A1E', borderRadius: 10, overflow: 'hidden', marginTop: 6, maxWidth: 240, borderWidth: 1, borderColor: '#222' },
  img:   { width: '100%', height: 120 },
  body:  { padding: 10 },
  title: { color: '#E0E0F0', fontSize: 13, fontWeight: '700', marginBottom: 4 },
  desc:  { color: '#888', fontSize: 11, lineHeight: 16, marginBottom: 4 },
  url:   { color: '#00E5FF', fontSize: 10 },
});