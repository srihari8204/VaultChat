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
import { StyleSheet, Text as RNText, useWindowDimensions, type TextProps, type TextStyle } from 'react-native';
import { scaleType } from '../../lib/typeScale';
import { FONT, TYPOGRAPHY, type TypeVariant } from '../../constants/theme';
import { useColors } from '../../lib/theme';

/** True once the brand fonts are registered (provided by the root layout). */
export const FontReadyContext = createContext<boolean>(false);
export const useFontsReady = () => useContext(FontReadyContext);
const TextVariantContext = createContext<TypeVariant | null>(null);

export interface AppTextProps extends TextProps {
  variant?: TypeVariant;
  /** Convenience color override (defaults to Aurora.text). */
  color?: string;
}

export function AppText({ variant, color, style, ...rest }: AppTextProps) {
  const parentVariant = useContext(TextVariantContext);
  const effectiveVariant = variant ?? parentVariant ?? 'body';
  const inline = parentVariant != null && variant == null;
  const ready = useFontsReady();
  const colors = useColors();
  const { width } = useWindowDimensions();
  const t = TYPOGRAPHY[effectiveVariant];
  // Screen-responsive sizing. Returns the TYPOGRAPHY numbers unchanged across
  // the whole ordinary phone range (see lib/typeScale.ts), so this is inert on
  // every device in use today; it exists for tablets and very narrow screens.
  // useWindowDimensions rather than a module-level Dimensions.get so a fold,
  // rotation or split-screen resize is picked up instead of being frozen at
  // whatever the app launched into.
  const sized = scaleType(t, width);
  const base: TextStyle = inline ? (color ? { color } : {}) : {
    fontSize: sized.fontSize,
    lineHeight: sized.lineHeight,
    color: color ?? colors.text,
    // Brand font encodes its own weight, so only set fontWeight on the fallback.
    ...(ready ? { fontFamily: t.family } : { fontWeight: t.fontWeight }),
  };
  // A CALLER-SUPPLIED fontWeight CANNOT JUST RIDE ALONG.
  //
  // These families are per-weight STATIC files - Sora_700Bold,
  // NunitoSans_600SemiBold, and so on - each registered under its own name. Ask
  // Android for one of them AND a fontWeight and it looks for a weighted variant
  // of that family that was never registered, then falls back to Roboto: the
  // brand font is lost exactly where emphasis was requested. The base style
  // above already avoids this by setting weight only on the system fallback,
  // but a style prop merges on top of it and puts the weight back.
  //
  // Resolving the weight to the family that IS that weight keeps the caller's
  // intent on both platforms, instead of dropping the weight (losing emphasis)
  // or the family (losing the brand). Below 600 the regular face is correct, so
  // the weight is simply removed (2026-09-17).
  const merged = StyleSheet.flatten(style) as TextStyle | undefined;
  // A larger caller font must not inherit the body's smaller line box.
  if (merged?.fontSize != null && merged.lineHeight == null) {
    base.lineHeight = Math.ceil(merged.fontSize * t.lineHeight / t.fontSize);
  }
  let resolved: TextStyle | undefined = merged;
  if (ready && merged && merged.fontWeight != null && merged.fontFamily == null) {
    const { fontWeight, ...rest2 } = merged;
    const w = fontWeight === 'bold' ? 700 : fontWeight === 'normal' ? 400 : Number(fontWeight);
    const heading = t.family === FONT.heading || t.family === FONT.headingBold;
    const family = heading
      ? (w >= 800 ? FONT.headingBold : FONT.heading)
      : (w >= 700 ? FONT.bodyBold : w >= 600 ? FONT.bodySemibold : FONT.body);
    resolved = Number.isFinite(w) ? { ...rest2, fontFamily: family } : rest2;
  }
  // Context has no native view: nested runs retain React Native's text inheritance.
  return (
    <TextVariantContext.Provider value={effectiveVariant}>
      <RNText style={[base, resolved]} {...rest} />
    </TextVariantContext.Provider>
  );
}

export default AppText;
