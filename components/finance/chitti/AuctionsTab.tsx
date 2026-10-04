// components/finance/chitti/AuctionsTab.tsx — record a month's auction
// (winner, bid, commission → per-member dividend) and list past auctions.
// The form's draft is held by the group screen, so it survives a tab switch.

import React from 'react';
import { View, Text, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFinanceTheme } from '../useFinanceTheme';
import { Field, Btn } from '../ui';
import { num } from '../../../utils/financeFormat';
import { formatINR } from '../../../utils/interest';
import { splitEvenly } from '../../../utils/money';
import {
  recordAuction, deleteAuction, type ChittiGroup, type ChittiMember, type ChittiAuction,
} from '../../../db/chitti';
import { makeChittiStyles } from './chittiStyles';
import { MonthChips } from './MonthChips';

export interface AuctionDraft { winnerId: string | null; bid: string; commission: string }
export const EMPTY_AUCTION_DRAFT: AuctionDraft = { winnerId: null, bid: '', commission: '' };

export function AuctionsTab({ group: g, members, auctions, month, onMonth, onChanged, draft, setDraft }: {
  group: ChittiGroup; members: ChittiMember[]; auctions: ChittiAuction[];
  month: number; onMonth: (m: number) => void;
  /** Resolves once the group's rows are re-read, so Record stays latched until then. */
  onChanged: () => Promise<void>;
  draft: AuctionDraft; setDraft: React.Dispatch<React.SetStateAction<AuctionDraft>>;
}) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeChittiStyles(FIN), [FIN]);
  const { winnerId, bid, commission } = draft;
  const setWinnerId = (id: string) => setDraft(d => ({ ...d, winnerId: id }));
  const setBid = (t: string) => setDraft(d => ({ ...d, bid: t }));
  const setCommission = (t: string) => setDraft(d => ({ ...d, commission: t }));

  const submitAuction = async () => {
    // `|| 0` SWALLOWED THE HARDENED PARSER (2026-09-17). num() answers NaN for
    // a half-typed "1,2" precisely so a guard can see it; `|| 0` converted that
    // back to a believable zero, so a commission the organiser typed was
    // RECORDED AS NONE and the whole bid was then split across every member —
    // over-distributing real money, silently. `!(c >= 0)` rejects the NaN and a
    // negative commission alike; blank stays 0, because num('') is 0.
    const b = num(bid), c = num(commission);
    if (!winnerId) return Alert.alert('Winner', 'Select the winning member.');
    if (!(b > 0)) return Alert.alert('Winning bid', 'Enter the winning bid amount.');
    if (!(c >= 0)) return Alert.alert('Commission', 'The commission must be a plain number — digits only, 1200 or 1,200 — or empty for none. It cannot be negative.');
    // The discount a winner forgoes cannot exceed the pot, and the foreman's
    // commission comes out of that discount — past either bound the dividend
    // the group is told to pay out is money that does not exist.
    if (b > g.chit_value) return Alert.alert('Winning bid', `The bid cannot be more than the chit value, ${formatINR(g.chit_value)}.`);
    if (c > b) return Alert.alert('Commission', 'The commission cannot be more than the winning bid.');
    const existing = auctions.find(a => a.month === month);
    if (existing) {
      const go = await new Promise<boolean>((resolve) => Alert.alert(
        `Replace month ${month}'s auction?`,
        `Month ${month} is already recorded: ${existing.winner_name}, bid ${formatINR(existing.winning_bid)}. Recording again replaces it. The change is kept in History.`,
        [{ text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
         { text: 'Replace', style: 'destructive', onPress: () => resolve(true) }],
        { cancelable: true, onDismiss: () => resolve(false) },
      ));
      if (!go) return;
    }
    const winner = members.find(m => m.id === winnerId);
    if (!winner) { setDraft(d => ({ ...d, winnerId: null })); return Alert.alert('Winner', 'That member was removed. Select the winning member again.'); }
    try {
      await recordAuction(g, month, winnerId, winner.name, b, c);
    } catch (e: any) { return Alert.alert('Could not record the auction', e?.message ?? 'Nothing was saved. Try again.'); }
    setDraft(EMPTY_AUCTION_DRAFT);
    await onChanged();
  };
  // Mirrors recordAuction exactly, so the preview can never promise a number
  // the recorded auction won't produce.
  const previewSplit = () => {
    const b = num(bid), c = num(commission);
    // Same `!(c >= 0)` as submitAuction, for the same reason the mirror exists:
    // with `|| 0` the preview promised a full undiscounted split for a
    // commission the recorded auction will now refuse outright (2026-09-17).
    if (!(b > 0) || !(c >= 0)) return { each: 0, remainder: 0, remainderPaise: 0 };
    return splitEvenly(Math.max(0, b - c), g.members || 1);
  };

  const removeAuction = (a: ChittiAuction) => Alert.alert(
    'Delete auction?',
    `Delete month ${a.month}'s auction? The bid and the winner are removed; the deletion is noted in History. This cannot be undone.`,
    [{ text: 'Cancel', style: 'cancel' },
     { text: 'Delete', style: 'destructive', onPress: () => {
       deleteAuction(a.id).then(onChanged).catch((e: any) => Alert.alert('Could not delete the auction', e?.message ?? 'Try again.'));
     } }],
  );

  const sp = previewSplit();
  return (
    <>
      {members.length === 0 ? <Text style={s.empty}>Add members first to record auctions.</Text> : (
        <View style={s.auctionForm}>
          <Text style={s.formLabel}>Record auction · Month {month}</Text>
          <MonthChips count={g.duration} value={month} onChange={onMonth} />
          <Text style={s.formLabel}>Winner</Text>
          <View style={s.winnerWrap} accessibilityRole="radiogroup" accessibilityLabel="Winner">
            {members.map(m => (
              <TouchableOpacity key={m.id} style={[s.winnerChip, winnerId === m.id && s.winnerChipOn]} onPress={() => setWinnerId(m.id)}
                accessibilityRole="radio" accessibilityState={{ checked: winnerId === m.id }}
                accessibilityLabel={`${m.name}, member ${m.number}`}>
                <Text numberOfLines={1} style={[s.winnerTxt, winnerId === m.id && { color: FIN.onBrand }]}>{m.name}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
            <View style={{ flex: 1 }}><Text style={s.formLabel}>Winning bid</Text><Field label="Winning bid" value={bid} onChangeText={setBid} placeholder="₹ 0" keyboardType="numeric" /></View>
            <View style={{ flex: 1 }}><Text style={s.formLabel}>Commission</Text><Field label="Commission" value={commission} onChangeText={setCommission} placeholder="₹ 0" keyboardType="numeric" /></View>
          </View>
          <Text style={s.dividendHint}>Dividend / member {formatINR(sp.each)} × {g.members}</Text>
          {sp.remainderPaise > 0 && (
            <Text style={s.dividendNote}>
              {formatINR(sp.remainder)} cannot divide evenly and stays in the pot.
            </Text>
          )}
          <View style={{ marginTop: 10 }}><Btn label="Record Auction" icon="hammer-outline" onPress={submitAuction} wide /></View>
        </View>
      )}

      {auctions.length > 0 && <Text style={[s.formLabel, { marginTop: 18 }]}>Auction history</Text>}
      {auctions.map(a => (
        <View key={a.id} style={s.auctionRow}>
          <View style={s.aMonth}><Text style={s.aMonthTxt}>M{a.month}</Text></View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.aWinner} numberOfLines={1}>{a.winner_name}</Text>
            <Text style={s.aSub}>Bid {formatINR(a.winning_bid)} · Commission {formatINR(a.commission)}</Text>
            <Text style={s.aDiv}>Dividend/member {formatINR(a.dividend)}</Text>
          </View>
          {/* Confirmed like the group delete (2026-09-17); the delete also
              writes a timeline entry, so a removed settled auction (month,
              bid, winner) leaves a trace. */}
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Delete month ${a.month}'s auction`}
            onPress={() => removeAuction(a)} hitSlop={14}><Ionicons name="close" size={16} color={FIN.faint} /></TouchableOpacity>
        </View>
      ))}
    </>
  );
}

export default AuctionsTab;
