import { FIN_PALETTES, type FinancePalette } from '../../constants/financeTheme';
import { useTheme } from '../../lib/theme';

/** Finance follows the app preference, including live system day/night changes. */
export function useFinanceTheme(): FinancePalette {
  return FIN_PALETTES[useTheme().scheme];
}
