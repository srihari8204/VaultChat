// components/finance/useDatePicker.tsx — the shared date picker
// (components/ui/useDatePicker) in the finance palette, for finance forms.
//
// Usage: const picker = useDatePicker();  picker.open(date, onPick[, 'datetime'])
//        and render {picker.element} once anywhere in the screen.

import { useTheme } from '../../lib/theme';
import { useDatePicker as useAppDatePicker } from '../ui/useDatePicker';
import { useFinanceTheme } from './useFinanceTheme';

export function useDatePicker() {
  const FIN = useFinanceTheme();
  const { scheme } = useTheme();
  return useAppDatePicker({
    sheet: FIN.cardSolid, edge: FIN.glassEdge, accent: FIN.brandDeep,
    scrim: scheme === 'dark' ? FIN.bgBottom : FIN.text,
    scrimOpacity: scheme === 'dark' ? 0.7 : 0.4,
  });
}

export default useDatePicker;
