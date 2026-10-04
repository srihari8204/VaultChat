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
//
// ZOOM re-lays the pages out wider and re-renders them at the new width
// (lib/media/pdfZoom), inside a horizontal scroller, so zoomed text stays sharp
// and every part of a page stays reachable. A pinch shows a live scale for
// feedback and commits one zoom when the fingers lift; double-tap toggles 2x;
// the zoom pill resets and is adjustable for screen readers.
//
// iOS has no PdfRenderer module. WKWebView renders a local PDF itself (PDFKit,
// native pinch and scroll), so iOS shows the file there — no JavaScript, no
// navigation away from the file — instead of always dropping to the text reader.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions,
  type ScrollView,
} from 'react-native';
import { Gesture, GestureDetector, FlatList as GHFlatList, ScrollView as GHScrollView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { WebView } from 'react-native-webview';
import { Image as ExpoImage } from 'expo-image';
import * as FileSystem from 'expo-file-system/legacy';
import type { Palette } from '../constants/theme';
import { MEDIA_INK, PDF_MAT, PDF_PAPER, PDF_PILL_ALPHA } from '../constants/mediaChrome';
import { useColors } from '../lib/theme';
import { pdfInfo, pdfNativeAvailable, renderPdfPage, type PdfInfo } from '../lib/pdfNative';
import { PDF_MAX_ZOOM, PDF_MIN_ZOOM, keepCentre, pdfZoom, pdfZoomLabel, stepZoom } from '../lib/media/pdfZoom';
import { sameFileUrl } from '../lib/media/fileUrl';

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

type Styles = ReturnType<typeof makeS>;

function Page({
  uri, index, width, aspect, docKey, cacheDir, s,
}: {
  uri: string; index: number; width: number; aspect: number;
  docKey: string; cacheDir: string; s: Styles;
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
        .catch((e: unknown) => {
          if (dead) return;
          const code = (e as { code?: string } | null)?.code;
          if (code === 'TOO_LARGE' && px > FLOOR) { attempt(Math.max(FLOOR, Math.round(px / 2))); return; }
          setErr(code === 'TOO_LARGE'
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
        // Memory cache only: the page JPEG is already on disk under dc_, where
        // the document purge removes it; a disk-cache copy would escape that.
        <ExpoImage
          source={{ uri: img }} style={{ width, height }}
          accessible accessibilityRole="image" accessibilityLabel={`Page ${index + 1}`}
          contentFit="contain" cachePolicy="memory" recyclingKey={`${docKey}_${index}`}
        />
      ) : (
        <View style={s.pagePending}>
          {err ? <Text style={s.pageErr}>{err}</Text>
               : <ActivityIndicator color="rgba(0,0,0,0.35)" accessibilityLabel={`Loading page ${index + 1}`} />}
        </View>
      )}
    </View>
  );
}

/** iOS: WKWebView draws a local PDF natively (PDFKit) with its own pinch zoom. */
function IosPdf({ uri, onFail, s }: { uri: string; onFail: (why: string) => void; s: Styles }) {
  const fileUrl = /^file:/i.test(uri) ? uri : `file://${uri}`;
  const dir = fileUrl.slice(0, fileUrl.lastIndexOf('/') + 1);
  return (
    <View style={s.fill}>
      <WebView
        source={{ uri: fileUrl }}
        originWhitelist={['file://*']}
        allowingReadAccessToURL={dir}
        allowFileAccess
        javaScriptEnabled={false}
        // The document itself, and nothing else: a link inside the PDF must
        // not turn this into a browser. Compared by decoded path — WKWebView
        // reports a space or non-ASCII name percent-encoded.
        onShouldStartLoadWithRequest={r => sameFileUrl(r.url, fileUrl)}
        onError={() => onFail('This PDF could not be opened.')}
        onHttpError={() => onFail('This PDF could not be opened.')}
        style={s.fill}
        accessibilityLabel="PDF document"
      />
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
  const ios = Platform.OS === 'ios';

  // ── Zoom ────────────────────────────────────────────────────
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const base = useSharedValue(1);   // the committed zoom, readable by the gesture worklet
  const live = useSharedValue(1);   // pinch feedback, relative to the committed zoom
  const listRef = useRef<GHFlatList<number>>(null);
  const hRef = useRef<ScrollView>(null);
  const scroll = useRef({ x: 0, y: 0, w: 0, h: 0 });
  const pendingRatio = useRef<number | null>(null);
  const setZoomTo = useCallback((next: number) => {
    if (next === zoomRef.current) { live.value = 1; return; }
    pendingRatio.current = next / zoomRef.current;
    zoomRef.current = next;
    base.value = next;
    setZoom(next);
  }, [base, live]);
  const commitPinch = useCallback((scale: number) => setZoomTo(pdfZoom(zoomRef.current, scale)), [setZoomTo]);
  const toggleZoom = useCallback(() => setZoomTo(zoomRef.current > 1 ? 1 : 2), [setZoomTo]);
  // After the wider layout lands: drop the live scale and keep the same spot
  // in the middle of the screen.
  useEffect(() => {
    live.value = 1;
    const r = pendingRatio.current;
    if (r == null) return;
    pendingRatio.current = null;
    const { x, y, w, h } = scroll.current;
    requestAnimationFrame(() => {
      listRef.current?.scrollToOffset({ offset: keepCentre(y, h, r), animated: false });
      hRef.current?.scrollTo({ x: keepCentre(x, w, r), animated: false });
    });
  }, [zoom, live]);
  const gesture = useMemo(() => Gesture.Simultaneous(
    Gesture.Pinch()
      .onUpdate(e => {
        const z = Math.min(PDF_MAX_ZOOM, Math.max(PDF_MIN_ZOOM, base.value * e.scale));
        live.value = z / base.value;
      })
      .onEnd(e => { runOnJS(commitPinch)(e.scale); }),
    Gesture.Tap().numberOfTaps(2).onEnd((_e, ok) => { if (ok) runOnJS(toggleZoom)(); }),
  ), [base, live, commitPinch, toggleZoom]);
  const liveStyle = useAnimatedStyle(() => ({ transform: [{ scale: live.value }] }));

  const fail = useCallback((why: string) => {
    if (failedRef.current) return;
    failedRef.current = true;
    onFail?.(why);
  }, [onFail]);

  // Hoisted above the early return below: hooks must run in the same order on
  // every render. FlatList additionally refuses a changing onViewableItemsChanged
  // identity at runtime, so both are refs rather than inline callbacks.
  const onViewable = useRef(({ viewableItems }: { viewableItems: { index: number | null }[] }) => {
    const first = viewableItems?.[0]?.index;
    if (typeof first === 'number') setPage(first + 1);
  }).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 }).current;

  const docKey = useMemo(() => pageKeyFor(uri), [uri]);
  // Rendered pages are plaintext of an attachment, so they live under the same
  // dc_ prefix the rest of the document cache uses and are swept by the same
  // purge (lib/mediaCacheGC.purgeDocumentCache) on revoke, view-once and logout.
  const cacheDir = useMemo(
    () => `${FileSystem.cacheDirectory}dc_pdfpages`, [],
  );

  // An Android build without the native module says so plainly rather than
  // showing a grey page (iOS uses WKWebView, above). In an effect, not in
  // render — onFail sets state on the PARENT.
  useEffect(() => {
    if (!pdfNativeAvailable && !ios) fail('This build has no PDF renderer.');
  }, [fail, ios]);

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
      } catch (e: unknown) {
        if (dead) return;
        // Each of these is a different thing to tell the user. The old viewer
        // collapsed them all into "no text layer (it may be a scan)", which was
        // the wrong diagnosis for an encrypted file.
        const err = e as { code?: string; message?: string } | null;
        fail(
          err?.code === 'PASSWORD_REQUIRED' ? 'This PDF is password protected.'
          : err?.code === 'CORRUPT' ? 'This PDF is damaged or incomplete.'
          : err?.message || 'This PDF could not be opened.',
        );
      }
    })();
    return () => { dead = true; };
  }, [uri, cacheDir, fail, onReady]);

  if (ios && !pdfNativeAvailable) return <IosPdf uri={uri} onFail={fail} s={s} />;

  if (!pdfNativeAvailable || !info) {
    return (
      <View style={s.fill}>
        {!failedRef.current && (
          <View style={s.cover}>
            <ActivityIndicator color={c.textDim} />
            <Text style={s.coverTxt}>Opening document…</Text>
          </View>
        )}
      </View>
    );
  }

  const pageW = Math.round(Math.max(120, winW - 20) * zoom);
  const aspect = info.height / info.width;
  const itemH = Math.round(pageW * aspect) + 10;
  // The list is as wide as the zoomed page, inside a horizontal scroller, so a
  // zoomed page can be panned edge to edge; at 100% nothing scrolls sideways.
  const listW = Math.max(winW, pageW + 20);

  return (
    <View style={s.fill}>
      <GestureDetector gesture={gesture}>
        <Animated.View style={[s.fill, liveStyle]}>
          <GHScrollView
            ref={hRef}
            horizontal
            bounces={false}
            showsHorizontalScrollIndicator={zoom > 1}
            scrollEnabled={zoom > 1}
            onLayout={e => { scroll.current.w = e.nativeEvent.layout.width; }}
            onScroll={e => { scroll.current.x = e.nativeEvent.contentOffset.x; }}
            scrollEventThrottle={64}
          >
            <GHFlatList
              ref={listRef}
              style={{ width: listW }}
              data={Array.from({ length: info.pageCount }, (_, i) => i)}
              keyExtractor={i => String(i)}
              extraData={pageW}
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
              onLayout={e => { scroll.current.h = e.nativeEvent.layout.height; }}
              onScroll={e => { scroll.current.y = e.nativeEvent.contentOffset.y; }}
              scrollEventThrottle={64}
              contentContainerStyle={s.list}
            />
          </GHScrollView>
        </Animated.View>
      </GestureDetector>
      {info.pageCount > 1 && (
        <View style={s.pill} pointerEvents="none">
          <Text style={s.pillTxt}>{page} / {info.pageCount}</Text>
        </View>
      )}
      {/* Tap resets to 100%; screen readers adjust it in steps. */}
      <Pressable
        onPress={() => setZoomTo(1)}
        style={s.zoomPill}
        hitSlop={8}
        accessibilityRole="adjustable"
        accessibilityLabel="Zoom"
        accessibilityValue={{ text: pdfZoomLabel(zoom) }}
        accessibilityHint="Double-tap to reset to 100%"
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }, { name: 'activate' }]}
        onAccessibilityAction={e => {
          const a = e.nativeEvent.actionName;
          setZoomTo(a === 'activate' ? 1 : stepZoom(zoomRef.current, a === 'increment' ? 1 : -1));
        }}
      >
        <Text style={s.pillTxt}>{pdfZoomLabel(zoom)}</Text>
      </Pressable>
    </View>
  );
}

const makeS = (c: Palette) => StyleSheet.create({
  fill: { flex: 1, backgroundColor: PDF_MAT },   // theme-exempt: the mat behind the pages. Every PDF reader uses a fixed neutral here — theming it would tint the paper's surround against the paper.
  list: { paddingVertical: 10, paddingHorizontal: 10 },
  page: { alignSelf: 'center', marginBottom: 10, backgroundColor: PDF_PAPER },   // theme-exempt: a PDF page IS white paper, and the rendered bitmap assumes it. A dark page would show as white content on a dark card.
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
    backgroundColor: `rgba(0,0,0,${PDF_PILL_ALPHA})`,
  },
  pillTxt: { color: MEDIA_INK, fontSize: 12, fontWeight: '700' },   // theme-exempt: on the fixed dark pill
  zoomPill: {
    position: 'absolute', bottom: 16, right: 14, minHeight: 32, justifyContent: 'center',
    paddingHorizontal: 12, borderRadius: 999, backgroundColor: `rgba(0,0,0,${PDF_PILL_ALPHA})`,
  },
});

export default PdfView;
