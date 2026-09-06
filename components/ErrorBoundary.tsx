import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';

interface Props {
  children: React.ReactNode;
  screen?: string;
  fallbackTitle?: string;
  fallbackMessage?: string;
}
interface State { hasError: boolean; }

// THEMING: deliberately NOT theme-aware. This renders after the tree has
// thrown — possibly ThemeProvider itself — so reading the palette from context
// here risks the crash screen crashing. Its colours stay fixed and dark.
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) { super(props); this.state = { hasError: false }; }

  static getDerivedStateFromError(): State { return { hasError: true }; }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', this.props.screen, error.message, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={s.wrap}>
          <Text style={s.title}>{this.props.fallbackTitle ?? 'Something went wrong'}</Text>
          <Text style={s.msg}>{this.props.fallbackMessage ?? 'Please restart the app.'}</Text>
          <TouchableOpacity style={s.btn} onPress={() => this.setState({ hasError: false })}>
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