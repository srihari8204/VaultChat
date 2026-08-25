// components/PdfThumbnailer.tsx — page 1 of a PDF, as a JPEG, for the chat bubble.
//
// WHY A COMPONENT FOR WHAT LOOKS LIKE A FUNCTION
// ----------------------------------------------
// lib/thumbnails.ts wants `makePdfThumb(uri) -> base64`, a plain async call from
// plain module code. But rasterising a PDF page needs a canvas, React Native has
// none, and the only canvas on the device is inside a WebView — which is a
// mounted component, not something a library function can conjure.
//
// So: one offscreen WebView is mounted for the app's lifetime (see the host in
// app/_layout.tsx) and requests are queued to it over postMessage. pdf.js starts
// up once, not once per document, which matters when a chat sends several PDFs.
//
// If the host is not mounted — iOS today, since plugins/withPdfJs.js only copies
// the files on Android — requests resolve to null rather than hanging, and the
// bubble falls back to the plain icon row it has always shown.

import React, { useCallback, useRef } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

const THUMB_PAGE = 'file:///android_asset/pdfjs/thumb.html';
/** A PDF that has not answered by now is not going to; never hang the send. */
const TIMEOUT_MS = 20_000;

export interface PdfThumb { b64: string; pages: number }

type Pending = { resolve: (v: PdfThumb | null) => void; timer: ReturnType<typeof setTimeout> };

let seq = 0;
const pending = new Map<number, Pending>();
/** Set while the host is mounted; null means "no renderer, answer null". */
let send: ((json: string) => void) | null = null;
const queued: string[] = [];
let ready = false;

function settle(id: number, value: PdfThumb | null) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  p.resolve(value);
}

/**
 * Page 1 of `uri` as a base64 JPEG, plus the document's page count.
 * Resolves null if there is no renderer, the PDF is unreadable, or it takes
 * too long — the caller treats every one of those the same way.
 */
export function requestPdfThumb(uri: string): Promise<PdfThumb | null> {
  if (Platform.OS !== 'android') return Promise.resolve(null);
  const id = ++seq;
  const msg = JSON.stringify({ id, uri });
  return new Promise<PdfThumb | null>(resolve => {
    pending.set(id, { resolve, timer: setTimeout(() => settle(id, null), TIMEOUT_MS) });
    if (send && ready) send(msg);
    else queued.push(msg);   // flushed when the page reports ready
  });
}

/**
 * Mount ONCE, near the root. Renders nothing visible.
 */
export function PdfThumbnailerHost() {
  const ref = useRef<WebView>(null);

  const onMessage = useCallback((e: any) => {
    let m: any;
    try { m = JSON.parse(e.nativeEvent.data); } catch { return; }
    if (m.ready) {
      ready = true;
      while (queued.length) ref.current?.postMessage(queued.shift()!);
      return;
    }
    if (typeof m.id !== 'number') return;
    settle(m.id, m.ok && m.b64 ? { b64: m.b64, pages: Number(m.pages) || 1 } : null);
  }, []);

  if (Platform.OS !== 'android') return null;

  return (
    <View style={s.hidden} pointerEvents="none">
      <WebView
        ref={ref}
        source={{ uri: THUMB_PAGE }}
        originWhitelist={['*']}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        javaScriptEnabled
        domStorageEnabled={false}
        onMessage={onMessage}
        onLoadEnd={() => { send = (json: string) => ref.current?.postMessage(json); }}
        onError={() => {
          // Fail every waiter rather than leaving sends hanging on a dead WebView.
          ready = false; send = null;
          for (const id of Array.from(pending.keys())) settle(id, null);
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  // Offscreen rather than display:none — a WebView with no layout does not run.
  hidden: { position: 'absolute', width: 1, height: 1, left: -100, top: -100, opacity: 0 },
});

export default PdfThumbnailerHost;
