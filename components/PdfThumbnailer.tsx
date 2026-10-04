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
//
// NATIVE FIRST. pdf.js in a file:// WebView cannot start its Worker, so it parses
// on the main thread — the ANR components/PdfView.tsx describes. Where the
// native PdfRenderer module is in the build (lib/pdfNative), page 1 is rendered
// there, off the UI thread, and the WebView is never mounted. The WebView stays
// only as the fallback for a build without that module.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { pdfInfo, pdfNativeAvailable, renderPdfPage } from '../lib/pdfNative';
import { VIEWER_TEMP_PREFIX } from '../lib/mediaCacheGC';

const THUMB_PAGE = 'file:///android_asset/pdfjs/thumb.html';
/** Same width and JPEG quality as thumb.html's canvas, so both paths match. */
const THUMB_PX = 480;
const THUMB_QUALITY = 0.6;
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

// -- Mount on demand, not at boot ---------------------------------------
//
// The host used to render its WebView unconditionally from app/_layout.tsx, so
// EVERY cold start paid to instantiate Chromium and load pdf.js — for every
// user, whether or not they ever opened a PDF. A WebView is among the most
// expensive views on Android, and this one sat on the startup path of a
// messenger where most sessions never touch a document.
//
// It is created the first time a thumbnail is actually asked for. The queue
// above already existed for exactly this shape — requests made before the page
// reports ready are held and flushed — so a request that triggers the mount is
// served by the same path as one arriving later, and no caller changes.
//
// Still mounted ONCE and kept for the app's lifetime after that: pdf.js
// starting up per document is the thing this host exists to avoid.
let wake: (() => void) | null = null;
let wanted = false;

function ensureHost(): void {
  if (wanted) return;
  wanted = true;
  wake?.();
}

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
/** Page 1 through the native renderer. The rendered page is plaintext of the
 *  attachment, so it is written to its own vt_ folder and deleted once read. */
async function nativeThumb(uri: string): Promise<PdfThumb | null> {
  const dir = `${FileSystem.cacheDirectory || ''}${VIEWER_TEMP_PREFIX}pdfthumb_${Date.now()}`;
  try {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    const info = await pdfInfo(uri);
    if (!info.pageCount) return null;
    const page = await renderPdfPage(uri, 0, THUMB_PX, dir, 'p');
    const jpeg = await ImageManipulator.manipulateAsync(page.uri, [],
      { compress: THUMB_QUALITY, format: ImageManipulator.SaveFormat.JPEG, base64: true });
    FileSystem.deleteAsync(jpeg.uri, { idempotent: true }).catch(() => {});
    return jpeg.base64 ? { b64: jpeg.base64, pages: info.pageCount } : null;
  } catch {
    return null;   // password-protected, damaged, out of memory: the icon row
  } finally {
    FileSystem.deleteAsync(dir, { idempotent: true }).catch(() => {});
  }
}

export function requestPdfThumb(uri: string): Promise<PdfThumb | null> {
  if (Platform.OS !== 'android') return Promise.resolve(null);
  if (pdfNativeAvailable) return nativeThumb(uri);
  const id = ++seq;
  const msg = JSON.stringify({ id, uri });
  return new Promise<PdfThumb | null>(resolve => {
    pending.set(id, { resolve, timer: setTimeout(() => settle(id, null), TIMEOUT_MS) });
    ensureHost();            // the first request builds the renderer; later ones reuse it
    if (send && ready) send(msg);
    else queued.push(msg);   // flushed when the page reports ready
  });
}

/**
 * Mount ONCE, near the root. Renders nothing visible.
 */
export function PdfThumbnailerHost() {
  const ref = useRef<WebView>(null);
  // Renders nothing until requestPdfThumb asks for it. See ensureHost above.
  const [live, setLive] = useState(wanted);

  useEffect(() => {
    if (wanted) { setLive(true); return; }
    wake = () => setLive(true);
    return () => { wake = null; };
  }, []);

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

  if (Platform.OS !== 'android' || !live) return null;

  return (
    <View style={s.hidden} pointerEvents="none">
      <WebView
        ref={ref}
        source={{ uri: THUMB_PAGE }}
        originWhitelist={['*']}
        allowFileAccess
        allowFileAccessFromFileURLs
        // allowUniversalAccessFromFileURLs stays off: a page loaded from a file
        // must not read other files.
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
