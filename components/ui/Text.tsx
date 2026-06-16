// components/ui/Text.tsx — brand typography wrapper (U2).
//
// <AppText variant="title"> applies the U1 TYPOGRAPHY scale (size/lineHeight) and
// the brand font family (Sora headings / Nunito Sans body) once the fonts have
// loaded. Until then — or if loading fails — it falls back to the system font
// with the equivalent fontWeight, so text always renders (never a blank screen).
//
// Adoption is incremental: screens migrate `import { Text } from 'react-native'`
// → `import { AppText as Text } from '../components/ui/Text'` over the polish pass.

import React, { createContext, useContext } from 'react';
import { Text as RNText, type TextProps, type TextStyle } from 'react-native';
import { Aurora, TYPOGRAPHY, type TypeVariant } from '../../constants/theme';

/** True once the brand fonts are registered (provided by the root layout). */
export const FontReadyContext = createContext<boolean>(false);
export const useFontsReady = () => useContext(FontReadyContext);

export interface AppTextProps extends TextProps {
  variant?: TypeVariant;
  /** Convenience color override (defaults to Aurora.text). */
  color?: string;
}

export function AppText({ variant = 'body', color, style, ...rest }: AppTextProps) {
  const ready = useFontsReady();
  const t = TYPOGRAPHY[variant];
  const base: TextStyle = {
    fontSize: t.fontSize,
    lineHeight: t.lineHeight,
    color: color ?? Aurora.text,
    // Brand font encodes its own weight, so only set fontWeight on the fallback.
    ...(ready ? { fontFamily: t.family } : { fontWeight: t.fontWeight }),
  };
  return <RNText style={[base, style]} {...rest} />;
}

export default AppText;
