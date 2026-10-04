// components/finance/chitti/MonthChips.tsx — month selector shared by the
// Dues and Auctions tabs: a radio group of M1…Mn.

import React from 'react';
import { ScrollView, Text, TouchableOpacity } from 'react-native';
import { useFinanceTheme } from '../useFinanceTheme';
import { makeChittiStyles } from './chittiStyles';

export function MonthChips({ count, value, onChange }: { count: number; value: number; onChange: (m: number) => void }) {
  const FIN = useFinanceTheme();
  const s = React.useMemo(() => makeChittiStyles(FIN), [FIN]);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.monthRow}
      accessibilityRole="radiogroup" accessibilityLabel="Month">
      {Array.from({ length: count }, (_, i) => i + 1).map(mn => (
        <TouchableOpacity key={mn} style={[s.monthChip, value === mn && s.monthChipOn]} onPress={() => onChange(mn)}
          accessibilityRole="radio" accessibilityState={{ selected: value === mn }} accessibilityLabel={`Month ${mn}`}>
          <Text style={[s.monthTxt, value === mn && { color: FIN.onBrand }]}>M{mn}</Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

export default MonthChips;
