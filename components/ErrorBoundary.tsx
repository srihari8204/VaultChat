import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import * as Sentry from '@sentry/react-native';

interface Props {
  children: React.ReactNode;
  screen?: string;
  fallbackTitle?: string;
  fallbackMessage?: string;
}
interface State { hasError: boolean; }

// Usable at the root of the app (app/_layout.tsx wraps RootLayout in it), where
// it is the last line before a white screen — so it depends on nothing but
// React Native: no theme, no i18n, no router.
//
// THEMING: deliberately NOT theme-aware. This renders after the tree has
// thrown — possibly ThemeProvider itself — so reading the palette from context
// here risks the crash screen crashing. Its colours stay fixed and dark.
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) { super(props); this.state = { hasError: false }; }

  static getDerivedStateFromError(): State { return { hasError: true }; }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', this.props.screen, error.message, info);
    // No-op when Sentry was never initialised (no EXPO_PUBLIC_SENTRY_DSN).
    try {
      Sentry.captureException(error, {
        tags: { boundary: this.props.screen ?? 'unknown' },
        extra: { componentStack: info.componentStack },
      });
    } catch { /* reporting must never re-throw from the crash screen */ }
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={s.wrap}>
          <Text style={s.title} accessibilityRole="header">{this.props.fallbackTitle ?? 'Something went wrong'}</Text>
          <Text style={s.msg}>{this.props.fallbackMessage ?? 'Please restart the app.'}</Text>
          <TouchableOpacity
            style={s.btn}
            onPress={() => this.setState({ hasError: false })}
            accessibilityRole="button"
            accessibilityLabel="Try again"
          >
            <Text style={s.btnTxt}>Try Again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;

const s = StyleSheet.create({
  wrap:   { flex: 1, backgroundColor: '#03030E', alignItems: 'center', justifyContent: 'center', padding: 32 },
  title:  { color: '#FF3C6E', fontSize: 20, fontWeight: 'bold', marginBottom: 12, textAlign: 'center' },
  msg:    { color: '#888', fontSize: 14, textAlign: 'center', lineHeight: 22, marginBottom: 24 },
  btn:    { backgroundColor: '#00E5FF', borderRadius: 10, paddingHorizontal: 24, paddingVertical: 12 },
  btnTxt: { color: '#000', fontSize: 15, fontWeight: 'bold' },
});