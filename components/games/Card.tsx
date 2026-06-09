/**
 * Card — playing-card renderer shared by the card games. Card int 0-51:
 * rank = c % 13 (0=A..12=K), suit = floor(c/13) (0♠ 1♥ 2♦ 3♣).
 */
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Aurora } from '../../constants/theme';

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];

export function Card({
  c, small, faceDown, selected, raised, onPress,
}: {
  c: number; small?: boolean; faceDown?: boolean; selected?: boolean; raised?: boolean; onPress?: () => void;
}) {
  if (faceDown) return <View style={[s.card, small && s.small, s.back]} />;
  // Jokers (Doudizhu): 52 = small (black), 53 = big (red).
  if (c === 52 || c === 53) {
    const big = c === 53;
    return (
      <TouchableOpacity disabled={!onPress} activeOpacity={0.8} onPress={onPress}
        style={[s.card, small && s.small, selected && s.sel, raised && s.raised]}>
        <Text style={[s.rank, small && s.rankSm, big && s.red]}>★</Text>
        <Text style={[s.suit, small && s.suitSm, big && s.red]}>JKR</Text>
      </TouchableOpacity>
    );
  }
  const suit = Math.floor(c / 13);
  const red = suit === 1 || suit === 2;
  return (
    <TouchableOpacity disabled={!onPress} activeOpacity={0.8} onPress={onPress}
      style={[s.card, small && s.small, selected && s.sel, raised && s.raised]}>
      <Text style={[s.rank, small && s.rankSm, red && s.red]}>{RANKS[c % 13]}</Text>
      <Text style={[s.suit, small && s.suitSm, red && s.red]}>{SUITS[suit]}</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  card: { width: 44, height: 62, borderRadius: 8, backgroundColor: '#FAFAF7', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#D4D0C4' },
  small: { width: 34, height: 48 },
  back: { backgroundColor: '#2B3A67', borderColor: '#1E2A4A' },
  sel: { borderColor: Aurora.primary, borderWidth: 2 },
  raised: { transform: [{ translateY: -10 }], borderColor: Aurora.primary, borderWidth: 2 },
  rank: { color: '#1A1A1A', fontSize: 18, fontWeight: '800' },
  rankSm: { fontSize: 14 },
  suit: { color: '#1A1A1A', fontSize: 16 },
  suitSm: { fontSize: 12 },
  red: { color: '#C0392B' },
});

export default Card;
