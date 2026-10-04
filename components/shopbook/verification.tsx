// components/shopbook/verification.tsx — Shop Book: shop verification documents and the activity log.
// Split out of app/shop-book.tsx on 2026-10-04 and edited since (fixes are
// logged per round). Palette and styles come from ./theme.

import { useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, FlatList, Alert, ActivityIndicator, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { dateLocale } from '../../utils/shopbook';
import * as SB from '../../services/shopBookService';
import { ErrorState } from '../finance/ui';
import { C, s } from './theme';
import { previewDoc, SubHeader, Empty } from './shared';
import { useShopLoad } from './useShopLoad';
import { userErrorText } from '../../lib/userErrorText';

// The shop's own audit trail (P1-F). Append-only server-side; read-only here.
export function AuditScreen({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<SB.AuditEntry[]>([]);
  const { loading, err, load } = useShopLoad(SB.auditLog, setRows);

  const describe = (e: SB.AuditEntry) => {
    const b = e.before ?? {}, a = e.after ?? {};
    switch (e.action) {
      case 'product.price_change': return `${a.name ?? 'Product'}: ${b.price} → ${a.price}`;
      case 'product.create':       return `Added ${a.name}`;
      case 'purchase.create':      return `${a.supplier ?? 'Purchase'} · ${a.items} item(s)`;
      case 'return.approve':       return `Return approved · refund ${a.refundTotal}`;
      case 'return.reject':        return 'Return declined';
      case 'document.upload':      return `Uploaded ${a.kind}`;
      case 'verification.submit':  return 'Submitted for verification';
      case 'location.request':     return 'Requested a location change';
      default:
        if (e.action.startsWith('stock.')) return `Stock ${b.onHand} → ${a.onHand}`;
        return e.action;
    }
  };

  const renderAudit = ({ item: e }: { item: SB.AuditEntry }) => (
          <View style={s.card}>
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{describe(e)}</Text>
              <Text style={s.cardSub}>
                {e.actor || 'Owner'} · {new Date(e.at).toLocaleString(dateLocale())}
              </Text>
              {!!e.reason && <Text style={s.cardSub}>📝 {e.reason}</Text>}
            </View>
          </View>
  );

  return (
    <>
      <SubHeader title="Activity log" onBack={onBack} />
      {/* An append-only log is the one list guaranteed to grow forever, so it
          is the scroller and the notice above it is the list header. */}
      <FlatList
        data={rows}
        keyExtractor={(e) => String(e.id)}
        renderItem={renderAudit}
        ListHeaderComponent={(
          <>
            <Text style={s.hint}>
              Every price change, stock correction, purchase and refund. This record cannot be edited or deleted — including by you.
            </Text>
            {!!err && !loading && <ErrorState title="Couldn’t load the activity log" sub={err} onRetry={load} />}
            {!loading && !err && rows.length === 0 && <Empty icon="document-text-outline" text="Nothing recorded yet." />}
          </>
        )}
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}
      />
    </>
  );
}

// Verification (P1-D): what's missing, what's uploaded, and where it stands.
export function VerificationScreen({ onBack }: { onBack: () => void }) {
  const [docs, setDocs] = useState<SB.ShopDocument[]>([]);
  const [accepted, setAccepted] = useState<string[]>([]);
  const [state, setState] = useState<SB.VerifyState>('unverified');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // Nothing about the shop's status shows until a load has succeeded: the
  // 'unverified' default would read "Not verified" for a verified shop.
  const [loaded, setLoaded] = useState(false);

  const { loading, err: loadErr, load } = useShopLoad(SB.shopDocuments, (r) => {
    setDocs(r.documents); setAccepted(r.accepted ?? []);
    setState(r.verifyState); setNote(r.verifyNote); setLoaded(true);
  }, { fallback: 'Could not load your documents' });

  // Upload one document for `kind`: pick → presigned PUT → record. A second
  // upload of the same kind replaces the first server-side.
  const [uploading, setUploading] = useState<string | null>(null);
  const upload = async (kind: string) => {
    if (uploading) return;
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: SB.DOC_MIMES, copyToCacheDirectory: true });
      const file = res.canceled ? null : res.assets?.[0];
      if (!file) return;
      if (file.mimeType && !SB.DOC_MIMES.includes(file.mimeType)) {
        Alert.alert('Unsupported file', 'Upload a photo (JPEG, PNG, WebP) or a PDF.'); return;
      }
      if ((file.size ?? 0) > SB.DOC_MAX_BYTES) {
        Alert.alert('File too large', 'Documents must be 10 MB or smaller.'); return;
      }
      setUploading(kind);
      await SB.uploadDocument(kind, file);
      await load();
    } catch (e) { Alert.alert('Could not upload', userErrorText(e, 'The upload did not complete. Try again.')); }
    finally { setUploading(null); }
  };

  const submit = async () => {
    setBusy(true);
    try {
      const r = await SB.submitVerification();
      setState(r.verifyState);
      Alert.alert('Submitted', 'Your shop is now queued for review.');
    } catch (e) {
      const missing = SB.missingForVerification(e);
      Alert.alert(missing ? 'Not ready yet' : 'Could not submit',
        missing ? `Still needed:\n• ${missing.join('\n• ')}` : (userErrorText(e, 'Try again')));
    } finally { setBusy(false); }
  };

  // Shown in the app's own viewer, not the external browser: the short-lived
  // signed link then never leaves the app, and the owner stays on this screen.
  const view = async (d: SB.ShopDocument) => {
    try {
      const { url } = await SB.documentUrl(d.id);
      previewDoc(url, d.filename || d.kind, d.mime || undefined);
    } catch (e) { Alert.alert('Could not open', userErrorText(e, 'Try again')); }
  };

  const STATE_COPY: Record<SB.VerifyState, { label: string; tone: string; hint: string }> = {
    unverified:     { label: 'Not verified', tone: C.sub, hint: 'Verified shops get a badge customers can see.' },
    pending_review: { label: 'Under review', tone: C.amber, hint: 'We are looking at your shop. Nothing more is needed from you.' },
    verified:       { label: 'Verified ✅', tone: C.green, hint: 'Your address is now fixed — moving it needs approval.' },
    rejected:       { label: 'Not approved', tone: C.danger, hint: 'Fix what is noted below and submit again.' },
    suspended:      { label: 'Suspended', tone: C.danger, hint: 'Your shop is not listed. Contact support.' },
  };
  const copy = STATE_COPY[state];

  return (
    <>
      <SubHeader title="Verification" onBack={onBack} />
      <ScrollView contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}>
        {!!loadErr && <ErrorState title="Could not load your documents" sub={loadErr} onRetry={load} />}
        {!loaded && loading && !loadErr && <ActivityIndicator color={C.green} accessibilityLabel="Loading verification status" />}
        {loaded && (<>
        <View style={s.panel}>
          <Text style={[s.panelTitle, { color: copy.tone }]}>{copy.label}</Text>
          <Text style={s.hint}>{copy.hint}</Text>
          {!!note && <Text style={[s.cardSub, { color: C.danger, marginTop: 6 }]}>📝 {note}</Text>}
        </View>

        {accepted.length > 0 && (
          <>
            <Text style={s.sectionLabel}>Documents for your country</Text>
            <Text style={s.hint}>All optional — upload whichever apply to your business.</Text>
          </>
        )}
        {accepted.map((kind) => {
          const have = docs.find((d) => d.kind === kind);
          return (
            <View key={kind} style={s.card}>
              <View style={{ flex: 1 }}>
                <Text style={s.cardTitle}>{kind}</Text>
                <Text style={[s.cardSub, {
                  color: have?.status === 'accepted' ? C.green
                       : have?.status === 'rejected' ? C.danger : C.sub,
                }]}>
                  {have ? (have.status === 'pending' ? 'Uploaded · awaiting review' : have.status) : 'Not uploaded'}
                </Text>
                {!!have?.reviewNote && <Text style={[s.cardSub, { color: C.danger }]}>{have.reviewNote}</Text>}
              </View>
              {have && (
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={`View the uploaded ${kind}`} onPress={() => view(have)}
                  hitSlop={10} style={{ padding: 6 }}>
                  <Ionicons name="eye-outline" size={20} color={C.green} />
                </TouchableOpacity>
              )}
              {uploading === kind ? <ActivityIndicator color={C.green} style={{ marginLeft: 10 }} /> : (
                <TouchableOpacity accessibilityRole="button" accessibilityLabel={`${have ? 'Replace' : 'Upload'} ${kind}`}
                  accessibilityState={{ disabled: !!uploading }} disabled={!!uploading} onPress={() => upload(kind)}
                  hitSlop={10} style={{ padding: 6, marginLeft: 4 }}>
                  <Ionicons name={have ? 'refresh-outline' : 'cloud-upload-outline'} size={20} color={C.green} />
                </TouchableOpacity>
              )}
            </View>
          );
        })}
        <Text style={s.hint}>
          Upload a photo or PDF (up to 10 MB) for each document that applies. Documents are visible only to you and the review team.
        </Text>

        {(state === 'unverified' || state === 'rejected') && (
          <TouchableOpacity style={[s.primaryBtn, busy && { opacity: 0.6 }]} disabled={busy} onPress={submit}
            accessibilityRole="button" accessibilityLabel="Submit for verification" accessibilityState={{ disabled: busy, busy }}>
            {busy ? <ActivityIndicator color={C.onFill} />
                  : <Text style={s.primaryBtnText}>Submit for verification</Text>}
          </TouchableOpacity>
        )}
        </>)}
      </ScrollView>
    </>
  );
}
