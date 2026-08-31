// components/PdfView.tsx — render a PDF as PAGES, not as recovered text.
//
// WHY THIS EXISTS
// ---------------
// lib/docText.ts reads PDFs by pulling text-showing operators straight out of
// the content streams. That is genuinely useful for a text document, and it is
// why the reader needs no native module — but it recovers WORDS and nothing
// else. Hand it an engineering drawing and it returns the dimension labels with
// every line, arc and hatch discarded: the reader shows a page of stray numbers
// and the drawing itself is simply absent.
//
// Rendering real pages needs a real renderer. This is Mozilla's pdf.js, vendored
// into assets/pdfjs (see the README there), running inside a WebView. The
// WebView earns its place twice over: pinch-zoom is the browser's own, and —
// unlike scaling a bitmap — the page is re-rasterised at three times its CSS
// size, so zooming into a drawing stays sharp.
//
// Everything is local. The viewer, pdf.js, its worker and the PDF are all read
// over file://; nothing is fetched, so this works offline and the document never
// leaves the device.
//
// The viewer is loaded from android_asset rather than from a Metro asset, for a
// reason that only shows up on device — see plugins/withPdfJs.js.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';

/** viewer.html, pdf.min.js and pdf.worker.min.js, all in one origin. */
const VIEWER = 'file:///android_asset/pdfjs/viewer.html';

/** How long to wait for pdf.js's first page before falling back to the reader. */
const RENDER_TIMEOUT_MS = 30_000;

export function PdfView({ uri, onFail }: { uri: string; onFail?: (why: string) => void }) {
  const [shown, setShown] = useState(false);
  const failedRef = useRef(false);

  const fail = useCallback((why: string) => {
    if (failedRef.current) return;   // the WebView can report more than once
    failedRef.current = true;
    onFail?.(why);
  }, [onFail]);

  // iOS would need the same three files copied into the app bundle; only the
  // Android side of plugins/withPdfJs.js exists today. Say so plainly instead of
  // showing an empty grey page — the caller drops back to the text reader.
  // In an effect, not in render: onFail sets state on the PARENT, and doing that
  // mid-render is the "cannot update a component while rendering another" warning.
  const unsupported = Platform.OS !== 'android';
  useEffect(() => {
    if (unsupported) fail('page rendering is Android-only so far');
  }, [unsupported, fail]);

  // pdf.js posts 'ready' or 'error'. A worker that dies silently posts NEITHER,
  // and the cover below then reads "Rendering pages..." forever with no way out
  // but the back button — indistinguishable, to the person holding the phone,
  // from the app hanging. The ceiling is deliberately generous: a large scan on
  // a slow device is slow, not broken, and a premature fallback would replace
  // real pages with recovered text.
  useEffect(() => {
    if (unsupported || shown) return;
    const t = setTimeout(() => fail('The PDF took too long to render.'), RENDER_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [unsupported, shown, fail]);

  if (unsupported) return null;

  // The document is handed in as an absolute file:// URL rather than copied next
  // to the viewer: allowUniversalAccessFromFileURLs lets the page read it where
  // it already is, and a copy of every opened PDF is pure waste.
  const docUrl = uri.startsWith('file://') || uri.startsWith('content://') ? uri : `file://${uri}`;

  return (
    <View style={s.fill}>
      <WebView
        source={{ uri: VIEWER }}
        originWhitelist={['*']}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        javaScriptEnabled
        domStorageEnabled={false}
        // Pinch-to-zoom, without Android's floating +/- buttons over the page.
        setBuiltInZoomControls
        setDisplayZoomControls={false}
        injectedJavaScriptBeforeContentLoaded={`window.__DOC__=${JSON.stringify(docUrl)};true;`}
        onMessage={e => {
          try {
            const m = JSON.parse(e.nativeEvent.data);
            if (m.t === 'ready') setShown(true);
            else if (m.t === 'error') fail(m.m || 'The PDF could not be rendered.');
          } catch {}
        }}
        onError={() => fail('The PDF viewer failed to load.')}
        style={s.web}
      />
      {!shown && (
        <View style={s.cover} pointerEvents="none">
          <ActivityIndicator color="#FFFFFF" />
          <Text style={s.coverTxt}>Rendering pages…</Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#3A3A3E' },
  web: { flex: 1, backgroundColor: '#3A3A3E' },
  cover: {
    ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#3A3A3E', gap: 12,
  },
  coverTxt: { color: 'rgba(255,255,255,0.65)', fontSize: 13 },
});

export default PdfView;
