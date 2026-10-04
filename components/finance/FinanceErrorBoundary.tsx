// components/finance/FinanceErrorBoundary.tsx — the app ErrorBoundary for the
// Vault Finance stack, plus a way OUT.
//
// The fallback replaces the whole finance stack, header and back button
// included, so "Try again" was the only control on screen: a screen that threw
// every time left the user stuck in Vault Finance. This adds "Leave Vault
// Finance", which goes to the Mini Apps tab the hub is opened from. The
// fallback itself (and its error reporting) is components/ErrorBoundary,
// unchanged; its colours are fixed dark, so this button's ink is the fixed
// white of HERO_INK (constants/financeTheme).

import React from 'react';
import { ScrollView, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { ErrorBoundary } from '../ErrorBoundary';
import { HERO_INK, FALLBACK_GROUND } from '../../constants/financeTheme';

export class FinanceErrorBoundary extends ErrorBoundary {
  render() {
    const out = super.render();
    if (!this.state.hasError) return out;
    // In the flow below the fallback, not overlaid on it: at large font sizes
    // the message and Try again grow, and the page scrolls instead of the
    // Leave button covering them.
    return (
      <ScrollView style={st.wrap} contentContainerStyle={st.content}>
        {out}
        <TouchableOpacity
          style={st.exit}
          onPress={() => router.replace('/(tabs)/mini')}
          accessibilityRole="button"
          accessibilityLabel="Leave Vault Finance"
          hitSlop={8}
        >
          <Text style={st.exitTxt}>Leave Vault Finance</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }
}

const st = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: FALLBACK_GROUND },
  content: { flexGrow: 1 },
  exit: {
    alignSelf: 'center', alignItems: 'center', justifyContent: 'center',
    minHeight: 44, paddingHorizontal: 24, marginBottom: 48,
  },
  exitTxt: { color: HERO_INK.strong, fontSize: 15, fontWeight: '700', textDecorationLine: 'underline' },
});

export default FinanceErrorBoundary;
