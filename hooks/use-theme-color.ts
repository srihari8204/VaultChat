import { useTheme } from '@/lib/theme';
import type { Colors } from '@/constants/theme';

export function useThemeColor(
  props: { light?: string; dark?: string },
  colorName: keyof typeof Colors.light & keyof typeof Colors.dark
) {
  const { scheme, colors } = useTheme();
  const colorFromProps = props[scheme];

  if (colorFromProps) return colorFromProps;

  switch (colorName) {
    case 'background':
      return colors.bg;
    case 'text':
      return colors.text;
    case 'icon':
    case 'tabIconDefault':
      return colors.textDim;
    case 'tabIconSelected':
    case 'tint':
      return colors.accentOn;
    default:
      return colors.text;
  }
}
