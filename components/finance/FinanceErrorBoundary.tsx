// components/finance/FinanceErrorBoundary.tsx — the app ErrorBoundary for the
// Vault Finance stack, plus a way OUT.
//
// The fallback replaces the whole finance stack, header and back button
// included, so "Try again" was the only control on screen: a screen that threw
// every time left the user stuck in Vault Finance. This adds "Leave Vault
// Finance", which goes to the Mini Apps tab the hub is opened from. The
// fallback itself (and its error reporting) is components/ErrorBoundary,
// unchanged; its colours are fixed dark, so this button's ink is the fixed
// white of components/finance/heroInk.

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { ErrorBoundary } from '../ErrorBoundary';
import { HERO_INK } from './heroInk';

export class FinanceErrorBoundary extends ErrorBoundary {
  render() {
    const out = super.render();
    if (!this.state.hasError) return out;
    return (
      <View style={st.wrap}>
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
      </View>
    );
  }
}

const st = StyleSheet.create({
  wrap: { flex: 1 },
  // Overlaid on the fallback's own fixed-dark ground, below its Try again.
  exit: {
    position: 'absolute', left: 0, right: 0, bottom: 48, alignSelf: 'center',
    alignItems: 'center', justifyContent: 'center', minHeight: 44, paddingHorizontal: 24,
  },
  exitTxt: { color: HERO_INK.strong, fontSize: 15, fontWeight: '700', textDecorationLine: 'underline' },
});

export default FinanceErrorBoundary;
