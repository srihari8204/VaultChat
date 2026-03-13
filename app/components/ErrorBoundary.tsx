import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

export class ErrorBoundary extends React.Component<any, any> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }
  componentDidCatch(error: any, info: any) {
    console.error('ErrorBoundary caught:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <View style={{ flex: 1, backgroundColor: '#020B18', justifyContent: 'center', alignItems: 'center', padding: 32 }}>
          <Text style={{ fontSize: 48, marginBottom: 16 }}>&#128274;</Text>
          <Text style={{ color: '#fff', fontSize: 18, fontWeight: '900', marginBottom: 8, textAlign: 'center' }}>
            {this.props.fallbackTitle || 'Something went wrong'}
          </Text>
          <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13, textAlign: 'center', marginBottom: 28, lineHeight: 20 }}>
            {this.props.fallbackMessage || 'An unexpected error occurred.'}
          </Text>
          <TouchableOpacity
            onPress={() => this.setState({ hasError: false, error: null })}
            style={{ backgroundColor: '#1D4ED8', borderRadius: 14, paddingVertical: 14, paddingHorizontal: 28 }}
          >
            <Text style={{ color: '#fff', fontSize: 14, fontWeight: '800' }}>Try Again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

// ✅ Required: default export to suppress expo-router route warning
export default ErrorBoundary;
