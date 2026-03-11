import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

interface State { hasError: boolean; error: string; screen: string }

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; screen?: string },
  State
> {
  state: State = { hasError: false, error: '', screen: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error: error.message };
  }

  componentDidCatch(error: Error) {
    errorHandler.log(this.props.screen || 'unknown', error);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <View style={EBss.root}>
        <LinearGradient colors={['#010812','#020B18']} style={StyleSheet.absoluteFillObject}/>
        <Text style={EBss.icon}>⚠️</Text>
        <Text style={EBss.title}>Something went wrong</Text>
        <Text style={EBss.msg}>{this.state.error}</Text>
        <TouchableOpacity
          onPress={() => this.setState({ hasError: false, error: '' })}
          style={EBss.btn}>
          <Text style={EBss.btnTxt}>Try Again</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

const EBss = StyleSheet.create({
  root:   { flex:1, justifyContent:'center', alignItems:'center', gap:16, padding:32 },
  icon:   { fontSize:48 },
  title:  { color:'#fff', fontSize:18, fontWeight:'900', textAlign:'center' },
  msg:    { color:'rgba(255,255,255,0.5)', fontSize:12, textAlign:'center', fontFamily:'monospace' },
  btn:    { backgroundColor:'rgba(74,159,255,0.2)', borderRadius:14, paddingHorizontal:28, paddingVertical:13, borderWidth:1, borderColor:'rgba(74,159,255,0.4)' },
  btnTxt: { color:'#4A9FFF', fontSize:14, fontWeight:'900' },
});

