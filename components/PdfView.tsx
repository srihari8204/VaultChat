// components/PdfView.tsx — render a PDF as PAGES, natively.
//
// WHAT THIS REPLACED, AND WHY
// ---------------------------
// This used to be Mozilla's pdf.js inside a WebView loaded from
// file:///android_asset/pdfjs/viewer.html. pdf.js does its parsing and
// rasterising in a Web Worker — and Chrome will NOT start a Worker from a
// file:// origin. pdf.js does not fail loudly when that happens: it falls back
// to its "fake worker", which runs the identical work ON THE MAIN THREAD.
//
// So every PDF was parsed and rasterised on the UI thread. A small one merely
// felt slow; a large one froze the app until Android killed it. That was the
// reported bug — "not opening", "no thumbnail", "takes too much time", "app
// closes when I try to stop it" — all one ANR, confirmed on device as
// data_app_anr with libwebviewchromium.so on the blocked main thread. It
// predated the pdf.js 3->4 upgrade, which neither caused nor fixed it.
//
// lib/pdfNative talks to android.graphics.pdf.PdfRenderer (the platform's own
// pdfium). React Native runs those calls on its native executor, so the work is
// off the UI thread BY CONSTRUCTION rather than by hoping a Worker starts.
//
// Pages are rendered one at a time, on demand, to JPEGs on disk, and shown with
// expo-image. Only what is near the viewport is ever rendered, so a 400-page
// document costs the same as a 4-page one — the old viewer's whole-document
// bitmap pressure is gone with it.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, FlatList, Platform, StyleSheet, Text, View, useWindowDimensions,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import * as FileSystem from 'expo-file-system/legacy';
import type { Palette } from '../constants/theme';
import { useColors } from '../lib/theme';
import { pdfInfo, pdfNativeAvailable, renderPdfPage, type PdfInfo } from '../lib/pdfNative';

/** Render scale over the layout width — keeps text crisp without a zoom re-render. */
const OVERSAMPLE = 2;

/** Hard ceiling per page, in pixels. Above this the JPEG costs more than it shows. */
const MAX_PAGE_PX = 2400;

function pageKeyFor(uri: string): string {
  // A stable, filesystem-safe key per document. The path already identifies the
  // attachment (mediaStore names it by attachment id), so hashing is unnecessary
  // — but it must not contain separators.
  return uri.replace(/^file:\/\//, '').replace(/[^A-Za-z0-9]/g, '_').slice(-60);
}

function Page({
  uri, index, width, aspect, docKey, cacheDir, s,
}: {
  uri: string; index: number; width: number; aspect: number;
  docKey: string; cacheDir: string; s: any;
}) {
  const [img, setImg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const height = Math.round(width * aspect);

  useEffect(() => {
    let dead = false;
    // STEP DOWN ON OutOfMemory INSTEAD OF GIVING UP.
    //
    // A page is ARGB_8888 (PdfRenderer accepts nothing else), so at 2400px wide
    // one page is roughly 2400 x 3400 x 4 = ~32 MB. A big document — a scanned
    // textbook, a CAD drawing — can exceed the per-app heap at full width while
    // rendering perfectly well at half of it.
    //
    // The native module already reports that case distinctly as TOO_LARGE
    // precisely so the caller can retry smaller, and this is the caller that
    // never did: it showed "could not be rendered" and stopped, which is what a
    // large PDF looked like from the outside — a file that simply would not open.
    //
    // Halving is the right step because cost is quadratic in width: one halving
    // cuts the bitmap to a quarter. FLOOR stops it degrading into an unreadable
    // smudge — below that, refusing honestly is better than pretending.
    const FLOOR = 320;
    const attempt = (px: number) => {
      renderPdfPage(uri, index, px, cacheDir, docKey)
        .then(r => { if (!dead) { setImg(r.uri); setErr(null); } })
        .catch((e: any) => {
          if (dead) return;
          if (e?.code === 'TOO_LARGE' && px > FLOOR) { attempt(Math.max(FLOOR, Math.round(px / 2))); return; }
          setErr(e?.code === 'TOO_LARGE'
            ? 'Page too large to display on this device'
            : `Page ${index + 1} could not be rendered`);
        });
    };
    attempt(Math.min(Math.round(width * OVERSAMPLE), MAX_PAGE_PX));
    return () => { dead = true; };
  }, [uri, index, width, docKey, cacheDir]);

  return (
    <View style={[s.page, { width, height }]}>
      {img ? (
        // recyclingKey: FlatList reuses rows, and without it a recycled row
        // briefly shows the PREVIOUS page's bitmap while the new one decodes.
        <ExpoImage
          source={{ uri: img }} style={{ width, height }}
          accessible accessibilityRole="image" accessibilityLabel={`Page ${index + 1}`}
          contentFit="contain" cachePolicy="disk" recyclingKey={`${docKey}_${index}`}
        />
      ) : (
        <View style={s.pagePending}>
          {err ? <Text style={s.pageErr}>{err}</Text>
               : <ActivityIndicator color="rgba(0,0,0,0.35)" />}
        </View>
      )}
    </View>
  );
}

export function PdfView({ uri, onFail, onReady }: {
  uri: string;
  onFail?: (why: string) => void;
  onReady?: (info: { version: string; pages: number }) => void;
}) {
  const c = useColors();
  const s = useMemo(() => makeS(c), [c]);
  const { width: winW } = useWindowDimensions();
  const [info, setInfo] = useState<PdfInfo | null>(null);
  const [page, setPage] = useState(1);
  const failedRef = useRef(false);

  const fail = useCallback((why: string) => {
    if (failedRef.current) return;
    failedRef.current = true;
    onFail?.(why);
  }, [onFail]);

  // Hoisted above the early return below: hooks must run in the same order on
  // every render. FlatList additionally refuses a changing onViewableItemsChanged
  // identity at runtime, so both are refs rather than inline callbacks.
  const onViewable = useRef(({ viewableItems }: any) => {
    const first = viewableItems?.[0]?.index;
    if (typeof first === 'number') setPage(first + 1);
  }).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 }).current;

  const docKey = useMemo(() => pageKeyFor(uri), [uri]);
  // Rendered pages are plaintext of an attachment, so they live under the same
  // dc_ prefix the rest of the document cache uses and are swept by the same
  // purge (lib/mediaCacheGC.purgeDocumentCache) on revoke, view-once and logout.
  const cacheDir = useMemo(
    () => `${(FileSystem as any).cacheDirectory}dc_pdfpages`, [],
  );

  // iOS has no native module yet; say so plainly rather than showing a grey
  // page. In an effect, not in render — onFail sets state on the PARENT.
  useEffect(() => {
    if (!pdfNativeAvailable) {
      fail(Platform.OS === 'android'
        ? 'This build has no PDF renderer.'
        : 'Page rendering is Android-only so far.');
    }
  }, [fail]);

  useEffect(() => {
    if (!pdfNativeAvailable) return;
    let dead = false;
    (async () => {
      try {
        await FileSystem.makeDirectoryAsync(cacheDir, { intermediates: true }).catch(() => {});
        const i = await pdfInfo(uri);
        if (dead) return;
        if (!i.pageCount) { fail('This PDF has no pages.'); return; }
        setInfo(i);
        onReady?.({ version: 'native/PdfRenderer', pages: i.pageCount });
      } catch (e: any) {
        if (dead) return;
        // Each of these is a different thing to tell the user. The old viewer
        // collapsed them all into "no text layer (it may be a scan)", which was
        // the wrong diagnosis for an encrypted file.
        fail(
          e?.code === 'PASSWORD_REQUIRED' ? 'This PDF is password protected.'
          : e?.code === 'CORRUPT' ? 'This PDF is damaged or incomplete.'
          : e?.message || 'This PDF could not be opened.',
        );
      }
    })();
    return () => { dead = true; };
  }, [uri, cacheDir, fail, onReady]);

  if (!pdfNativeAvailable || !info) {
    return (
      <View style={s.fill}>
        {!failedRef.current && (
          <View style={s.cover}>
            <ActivityIndicator color="#FFFFFF" />
            <Text style={s.coverTxt}>Opening document…</Text>
          </View>
        )}
      </View>
    );
  }

  const pageW = Math.max(120, winW - 20);
  const aspect = info.height / info.width;
  const itemH = Math.round(pageW * aspect) + 10;

  return (
    <View style={s.fill}>
      <FlatList
        data={Array.from({ length: info.pageCount }, (_, i) => i)}
        keyExtractor={i => String(i)}
        renderItem={({ item }) => (
          <Page uri={uri} index={item} width={pageW} aspect={aspect}
                docKey={docKey} cacheDir={cacheDir} s={s} />
        )}
        // Bounded rendering: only pages near the viewport exist as bitmaps, which
        // is what keeps a 400-page document the same cost as a 4-page one.
        initialNumToRender={2}
        maxToRenderPerBatch={2}
        windowSize={3}
        removeClippedSubviews
        getItemLayout={(_, i) => ({ length: itemH, offset: itemH * i, index: i })}
        onViewableItemsChanged={onViewable}
        viewabilityConfig={viewabilityConfig}
        contentContainerStyle={s.list}
      />
      {info.pageCount > 1 && (
        <View style={s.pill} pointerEvents="none">
          <Text style={s.pillTxt}>{page} / {info.pageCount}</Text>
        </View>
      )}
    </View>
  );
}

const makeS = (c: Palette) => StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#3A3A3E' },   // theme-exempt: the mat behind the pages. Every PDF reader uses a fixed neutral here — theming it would tint the paper's surround against the paper.
  list: { paddingVertical: 10 },
  page: { alignSelf: 'center', marginBottom: 10, backgroundColor: '#FFFFFF' },   // theme-exempt: a PDF page IS white paper, and the rendered bitmap assumes it. A dark page would show as white content on a dark card.
  pagePending: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  pageErr: { color: 'rgba(0,0,0,0.45)', fontSize: 12 },
  cover: {
    ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.surfaceSolid, gap: 12,
  },
  coverTxt: { color: c.textDim, fontSize: 13 },   // the cover is c.surfaceSolid (light in light theme): white text vanished on it
  pill: {
    position: 'absolute', bottom: 16, alignSelf: 'center',
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  pillTxt: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
});

export default PdfView;
