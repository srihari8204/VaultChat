// app/translate.tsx — Message Translation
// Translates text to any of the listed languages using VaultChat's own on-prem
// LLM (Ollama via /ai/assist). No third-party translation API; the request goes
// only to the VaultChat backend.

import React, { useState , useMemo} from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput,
  FlatList, StatusBar, ScrollView, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { useLocalSearchParams, Stack } from 'expo-router';
import { copyAndAutoClear } from '../lib/clipboardSafe';
import { aiAssist } from '../lib/ai';


const LANGUAGES = [
  { code: 'en', name: 'English', flag: '\uD83C\uDDFA\uD83C\uDDF8' },
  { code: 'hi', name: 'Hindi', flag: '\uD83C\uDDEE\uD83C\uDDF3' },
  { code: 'te', name: 'Telugu', flag: '\uD83C\uDDEE\uD83C\uDDF3' },
  { code: 'ta', name: 'Tamil', flag: '\uD83C\uDDEE\uD83C\uDDF3' },
  { code: 'es', name: 'Spanish', flag: '\uD83C\uDDEA\uD83C\uDDF8' },
  { code: 'fr', name: 'French', flag: '\uD83C\uDDEB\uD83C\uDDF7' },
  { code: 'de', name: 'German', flag: '\uD83C\uDDE9\uD83C\uDDEA' },
  { code: 'ja', name: 'Japanese', flag: '\uD83C\uDDEF\uD83C\uDDF5' },
  { code: 'zh', name: 'Chinese', flag: '\uD83C\uDDE8\uD83C\uDDF3' },
  { code: 'ko', name: 'Korean', flag: '\uD83C\uDDF0\uD83C\uDDF7' },
  { code: 'ar', name: 'Arabic', flag: '\uD83C\uDDF8\uD83C\uDDE6' },
  { code: 'pt', name: 'Portuguese', flag: '\uD83C\uDDE7\uD83C\uDDF7' },
  { code: 'ru', name: 'Russian', flag: '\uD83C\uDDF7\uD83C\uDDFA' },
  { code: 'it', name: 'Italian', flag: '\uD83C\uDDEE\uD83C\uDDF9' },
  { code: 'tr', name: 'Turkish', flag: '\uD83C\uDDF9\uD83C\uDDF7' },
  { code: 'nl', name: 'Dutch', flag: '\uD83C\uDDF3\uD83C\uDDF1' },
  { code: 'sv', name: 'Swedish', flag: '\uD83C\uDDF8\uD83C\uDDEA' },
  { code: 'pl', name: 'Polish', flag: '\uD83C\uDDF5\uD83C\uDDF1' },
  { code: 'th', name: 'Thai', flag: '\uD83C\uDDF9\uD83C\uDDED' },
  { code: 'vi', name: 'Vietnamese', flag: '\uD83C\uDDFB\uD83C\uDDF3' },
];

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function TranslateScreen() {
  const { colors } = useTheme();
  const s = useS();
  const { text: initialText } = useLocalSearchParams();
  const [inputText, setInputText] = useState((initialText || '') + '');
  const [targetLang, setTargetLang] = useState('hi');
  const [translated, setTranslated] = useState('');
  const [history, setHistory] = useState([]);
  const [showLangs, setShowLangs] = useState(false);
  const [translating, setTranslating] = useState(false);

  const translate = async () => {
    if (!inputText.trim() || translating) return;
    const lang = LANGUAGES.find(l => l.code === targetLang);
    setTranslating(true);
    try {
      const result = await aiAssist('translate', inputText.trim(), { lang: lang?.name });
      setTranslated(result);
      setHistory(prev => [{ id: Date.now(), from: inputText, to: result, lang: targetLang }, ...prev].slice(0, 20));
    } catch (e: any) {
      const offline = e?.status === 503 || /unavailable/i.test(e?.message || '');
      Alert.alert('Translation unavailable', offline ? 'The translation service is offline right now. Please try again later.' : (e?.message ?? 'Try again'));
    } finally {
      setTranslating(false);
    }
  };

  const copyTranslation = async () => {
    if (translated) {
      await copyAndAutoClear(translated);
      Alert.alert('Copied!', 'Translation copied to clipboard');
    }
  };

  const swapLangs = () => {
    if (translated) {
      setInputText(translated);
      setTranslated('');
    }
  };

  const selectedLang = LANGUAGES.find(l => l.code === targetLang);

  return (
    <>
      <Stack.Screen options={{ title: 'Translate', headerStyle: { backgroundColor: '#FFFFFF' }, headerTintColor: '#1F2937' }} />
      <ScrollView style={s.container}>
        <StatusBar barStyle="light-content" />

        {/* Input */}
        <View style={s.card}>
          <View style={s.cardHeader}>
            <Text style={s.langLabel}>{"\uD83C\uDDFA\uD83C\uDDF8"} English</Text>
          </View>
          <TextInput style={s.textInput} value={inputText} onChangeText={setInputText}
            placeholder="Enter text to translate..." placeholderTextColor="#6B7280" multiline maxLength={1000} />
        </View>

        {/* Swap + Target */}
        <View style={s.swapRow}>
          <TouchableOpacity onPress={swapLangs} style={s.swapBtn}>
            <Ionicons name="swap-vertical" size={20} color={colors.text} />
          </TouchableOpacity>
        </View>

        <View style={s.card}>
          <TouchableOpacity style={s.cardHeader} onPress={() => setShowLangs(!showLangs)}>
            <Text style={s.langLabel}>{selectedLang?.flag} {selectedLang?.name}</Text>
            <Ionicons name="chevron-down" size={16} color="#6B7280" />
          </TouchableOpacity>

          {showLangs && (
            <FlatList
              data={LANGUAGES.filter(l => l.code !== 'en')}
              numColumns={2}
              scrollEnabled={false}
              keyExtractor={l => l.code}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[s.langOption, targetLang === item.code && s.langOptionActive]}
                  onPress={() => { setTargetLang(item.code); setShowLangs(false); }}>
                  <Text style={s.langFlag}>{item.flag}</Text>
                  <Text style={[s.langName, targetLang === item.code && { color: colors.accent }]}>{item.name}</Text>
                </TouchableOpacity>
              )}
              contentContainerStyle={{ padding: 8 }}
            />
          )}

          {translated ? (
            <TouchableOpacity onPress={copyTranslation} style={s.resultBox}>
              <Text style={s.resultTxt}>{translated}</Text>
              <Text style={s.copyHint}>Tap to copy</Text>
            </TouchableOpacity>
          ) : (
            <View style={s.resultBox}>
              <Text style={{ color: '#9CA3AF' }}>Translation will appear here</Text>
            </View>
          )}
        </View>

        <TouchableOpacity style={[s.translateBtn, (!inputText.trim() || translating) && { opacity: 0.4 }]} onPress={translate} disabled={!inputText.trim() || translating}>
          <Text style={s.translateBtnTxt}>{translating ? 'Translating\u2026' : "\uD83C\uDF10  Translate"}</Text>
        </TouchableOpacity>

        {history.length > 0 && (
          <>
            <Text style={s.sectionTitle}>RECENT</Text>
            {history.map(h => (
              <View key={h.id} style={s.historyRow}>
                <Text style={s.historyFrom} numberOfLines={1}>{h.from}</Text>
                <Text style={s.historyTo} numberOfLines={1}>{h.to}</Text>
              </View>
            ))}
          </>
        )}
        <View style={{ height: 40 }} />
      </ScrollView>
    </>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg, padding: 16 },
  card: { backgroundColor: c.card, borderRadius: 16, borderWidth: 1, borderColor: '#E5E7EB', overflow: 'hidden', marginBottom: 4 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 12, borderBottomWidth: 1, borderBottomColor: '#E5E7EB' },
  langLabel: { color: '#1F2937', fontSize: 14, fontWeight: '700' },
  textInput: { padding: 14, color: '#fff', fontSize: 15, minHeight: 80, textAlignVertical: 'top' },
  swapRow: { alignItems: 'center', paddingVertical: 4 },
  swapBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: c.card, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#E5E7EB' },
  langOption: { flex: 1, flexDirection: 'row', alignItems: 'center', padding: 10, borderRadius: 8, gap: 8, margin: 2 },
  langOptionActive: { backgroundColor: '#4A9FFF22' },
  langFlag: { fontSize: 18 },
  langName: { color: '#ccc', fontSize: 12, fontWeight: '600' },
  resultBox: { padding: 14, minHeight: 80 },
  resultTxt: { color: '#1F2937', fontSize: 15, lineHeight: 22 },
  copyHint: { color: '#9CA3AF', fontSize: 10, marginTop: 8, textAlign: 'right' },
  translateBtn: { backgroundColor: c.accent, borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 12 },
  translateBtnTxt: { color: '#000', fontSize: 16, fontWeight: '900' },
  sectionTitle: { color: '#6B7280', fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: 20, marginBottom: 8 },
  historyRow: { backgroundColor: c.card, borderRadius: 10, padding: 10, marginBottom: 4, borderWidth: 1, borderColor: '#E5E7EB' },
  historyFrom: { color: '#6B7280', fontSize: 12 },
  historyTo: { color: '#1F2937', fontSize: 12, marginTop: 2 },
});
