// app/mini-apps.tsx
// Mini Apps Platform — built-in mini apps with working Calculator and Todo List

import { BRAND_ACCENT } from '../../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

// ── Mini Apps matching PDF (page 12) ─────────────────────────────
// Row 1: Watch, Walkie, Screen
// Row 2: Notes, Scanner, Location
// Row 3: Current Loc, Cloud, Pegasus
const MINI_APPS_MAIN = [
  { id: 'vaultlens',   icon: '\u2728', name: 'VaultLens', route: '/vaultlens', gradient: ['#9D6FD0', '#EC4899'] as [string, string] },
  { id: 'navigate',    icon: '\uD83E\uDDED', name: 'Navigate', route: '/navigate', gradient: ['#4A9FFF', '#1D4ED8'] as [string, string] },
  // Family Space absorbs the old Family Circle + SOS tiles \u2014 one app, one hub.
  { id: 'familyspace', icon: '\uD83D\uDC6A', name: 'Family Space', route: '/family', gradient: ['#7C3AED', '#2563EB'] as [string, string] },
  { id: 'interest',    icon: '\uD83D\uDCC8', name: 'Interest Calculator', route: '/interest-calculator', gradient: ['#075E54', '#25D366'] as [string, string] },
  { id: 'notes',       icon: '\uD83D\uDCDD', name: 'Notes',       route: '/encrypted-notes', gradient: ['#F59E0B', '#D97706'] as [string, string] },
  { id: 'scanner',     icon: '\uD83D\uDCC4', name: 'Scanner',     route: '/docscanner',     gradient: ['#4A9FFF', '#1D4ED8'] as [string, string] },
  { id: 'cloud',       icon: '\u2601\uFE0F', name: 'Cloud',       route: null,              gradient: ['#6B7280', '#4B5563'] as [string, string] },
  { id: 'pegasus',     icon: '\uD83E\uDD85', name: 'Pegasus',     route: '/aiguardian',     gradient: ['#B91C1C', '#DC2626'] as [string, string] },
  { id: 'vaultid',     icon: '\uD83C\uDD94', name: 'VaultID',     route: '/decentralized-id', gradient: ['#7C3AED', '#4A9FFF'] as [string, string] },
];

// ── Built-in utility mini apps ──────────────────────────────────
const MINI_APPS_UTILS = [
  { id: 'todo',       icon: '\u2705',        name: 'Todo List',        gradient: [BRAND_ACCENT, '#059669'] as [string, string] },
  { id: 'expense',    icon: '\uD83D\uDCB0',  name: 'Expense Tracker',  gradient: ['#7C3AED', '#EC4899'] as [string, string] },
  { id: 'qr',         icon: '\uD83D\uDCF1',  name: 'QR Generator',     gradient: ['#06B6D4', '#0891B2'] as [string, string] },
];

const TODO_STORAGE_KEY = 'vc_miniapp_todos';

interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}

export default function MiniAppsScreen() {
  const router = useRouter();
  const [activeApp, setActiveApp] = useState<string | null>(null);

  // ── Calculator state ──────────────────────────────────────────
  const [calcDisplay, setCalcDisplay] = useState('0');
  const [calcPrev, setCalcPrev] = useState<number | null>(null);
  const [calcOp, setCalcOp] = useState<string | null>(null);
  const [calcReset, setCalcReset] = useState(false);

  // ── Todo state ────────────────────────────────────────────────
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [todoInput, setTodoInput] = useState('');

  useEffect(() => {
    loadTodos();
  }, []);

  const loadTodos = async () => {
    try {
      const raw = await AsyncStorage.getItem(TODO_STORAGE_KEY);
      if (raw) setTodos(JSON.parse(raw));
    } catch {}
  };

  const saveTodos = async (items: TodoItem[]) => {
    try {
      await AsyncStorage.setItem(TODO_STORAGE_KEY, JSON.stringify(items));
      setTodos(items);
    } catch {}
  };

  // ── Calculator logic ──────────────────────────────────────────
  const calcPress = (val: string) => {
    if (val === 'C') {
      setCalcDisplay('0');
      setCalcPrev(null);
      setCalcOp(null);
      setCalcReset(false);
      return;
    }
    if (val === '±') {
      setCalcDisplay(d => (parseFloat(d) * -1).toString());
      return;
    }
    if (val === '%') {
      setCalcDisplay(d => (parseFloat(d) / 100).toString());
      return;
    }
    if (['+', '−', '×', '÷'].includes(val)) {
      setCalcPrev(parseFloat(calcDisplay));
      setCalcOp(val);
      setCalcReset(true);
      return;
    }
    if (val === '=') {
      if (calcPrev === null || !calcOp) return;
      const current = parseFloat(calcDisplay);
      let result = 0;
      switch (calcOp) {
        case '+': result = calcPrev + current; break;
        case '−': result = calcPrev - current; break;
        case '×': result = calcPrev * current; break;
        case '÷': result = current === 0 ? 0 : calcPrev / current; break;
      }
      setCalcDisplay(result.toString());
      setCalcPrev(null);
      setCalcOp(null);
      setCalcReset(true);
      return;
    }
    // Number or decimal
    if (calcReset) {
      setCalcDisplay(val === '.' ? '0.' : val);
      setCalcReset(false);
    } else {
      setCalcDisplay(d => (d === '0' && val !== '.') ? val : d + val);
    }
  };

  // ── Todo logic ────────────────────────────────────────────────
  const addTodo = () => {
    if (!todoInput.trim()) return;
    const item: TodoItem = { id: Date.now().toString(), text: todoInput.trim(), done: false };
    const updated = [...todos, item];
    saveTodos(updated);
    setTodoInput('');
  };

  const toggleTodo = (id: string) => {
    const updated = todos.map(t => (t.id === id ? { ...t, done: !t.done } : t));
    saveTodos(updated);
  };

  const deleteTodo = (id: string) => {
    const updated = todos.filter(t => t.id !== id);
    saveTodos(updated);
  };

  // ── Render Calculator ─────────────────────────────────────────
  const renderCalculator = () => {
    const buttons = [
      ['C', '±', '%', '÷'],
      ['7', '8', '9', '×'],
      ['4', '5', '6', '−'],
      ['1', '2', '3', '+'],
      ['0', '.', '='],
    ];
    return (
      <View style={styles.appContainer}>
        <TouchableOpacity onPress={() => setActiveApp(null)} style={styles.closeAppBtn}>
          <Ionicons name="arrow-back" size={16} color="#4A9FFF" />
          <Text style={styles.closeAppText}>Back to Apps</Text>
        </TouchableOpacity>
        <View style={styles.calcDisplay}>
          <Text style={styles.calcDisplayText} numberOfLines={1} adjustsFontSizeToFit>
            {calcDisplay}
          </Text>
          {calcOp && (
            <Text style={styles.calcOpIndicator}>{calcOp}</Text>
          )}
        </View>
        {buttons.map((row, ri) => (
          <View key={ri} style={styles.calcRow}>
            {row.map(btn => {
              const isOp = ['+', '−', '×', '÷', '='].includes(btn);
              const isFunc = ['C', '±', '%'].includes(btn);
              const isZero = btn === '0';
              return (
                <TouchableOpacity
                  key={btn}
                  style={[
                    styles.calcBtn,
                    isOp && styles.calcBtnOp,
                    isFunc && styles.calcBtnFunc,
                    isZero && styles.calcBtnZero,
                  ]}
                  onPress={() => calcPress(btn)}
                >
                  <Text
                    style={[
                      styles.calcBtnText,
                      isOp && styles.calcBtnTextOp,
                      isFunc && styles.calcBtnTextFunc,
                    ]}
                  >
                    {btn}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
      </View>
    );
  };

  // ── Render Todo List ──────────────────────────────────────────
  const renderTodoList = () => {
    const pending = todos.filter(t => !t.done).length;
    return (
      <View style={styles.appContainer}>
        <TouchableOpacity onPress={() => setActiveApp(null)} style={styles.closeAppBtn}>
          <Ionicons name="arrow-back" size={16} color="#4A9FFF" />
          <Text style={styles.closeAppText}>Back to Apps</Text>
        </TouchableOpacity>
        <Text style={styles.todoTitle}>✅ Todo List</Text>
        <Text style={styles.todoSubtitle}>
          {todos.length === 0
            ? 'No tasks yet — add one below'
            : `${pending} pending · ${todos.length - pending} done`}
        </Text>
        <View style={styles.todoInputRow}>
          <TextInput
            style={styles.todoInput}
            placeholder="Add a task..."
            placeholderTextColor="#4A5568"
            value={todoInput}
            onChangeText={setTodoInput}
            onSubmitEditing={addTodo}
            returnKeyType="done"
          />
          <TouchableOpacity style={styles.todoAddBtn} onPress={addTodo}>
            <Ionicons name="add" size={24} color="#000000" />
          </TouchableOpacity>
        </View>
        <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={false}>
          {todos.map(item => (
            <View key={item.id} style={styles.todoItem}>
              <TouchableOpacity
                style={[styles.todoCheck, item.done && styles.todoCheckDone]}
                onPress={() => toggleTodo(item.id)}
              >
                {item.done && <Ionicons name="checkmark" size={14} color="#000000" />}
              </TouchableOpacity>
              <Text style={[styles.todoText, item.done && styles.todoTextDone]}>
                {item.text}
              </Text>
              <TouchableOpacity onPress={() => deleteTodo(item.id)} style={styles.todoDelBtn}>
                <Ionicons name="close" size={14} color="#DC2626" />
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      </View>
    );
  };

  // ── Handle app open ───────────────────────────────────────────
  const handleOpenApp = (appId: string) => {
    if (appId === 'calculator' || appId === 'todo') {
      setActiveApp(appId);
      return;
    }
    // Main mini apps — navigate to their routes
    const mainApp = MINI_APPS_MAIN.find(a => a.id === appId);
    if (mainApp?.route) {
      router.push(mainApp.route as any);
      return;
    }
    if (mainApp && !mainApp.route) {
      Alert.alert('Coming Soon', `${mainApp.name} is under development.`);
      return;
    }
    Alert.alert('Coming Soon', 'This mini app is under development.');
  };

  // ── If a mini app is active, show it fullscreen ───────────────
  if (activeApp === 'calculator') {
    return (
      <View style={styles.container}>
        {/* header hidden by tab layout */}
        <ScrollView contentContainerStyle={styles.scroll}>{renderCalculator()}</ScrollView>
      </View>
    );
  }
  if (activeApp === 'todo') {
    return (
      <View style={styles.container}>
        {/* header hidden by tab layout */}
        <ScrollView contentContainerStyle={styles.scroll}>{renderTodoList()}</ScrollView>
      </View>
    );
  }

  // ── Main grid view ────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* ── Header ────────────────────────────────── */}
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={20} color="#E8E8E8" />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>🔲 Mini Apps</Text>
            <Text style={styles.headerSub}>Powerful tools right inside your chats</Text>
          </View>
        </View>

        {/* ── Mini Apps 3x3 Grid (matching PDF page 12) ─── */}
        <Text style={styles.sectionTitle}>{'\uD83E\uDDE9'} Mini Apps</Text>
        <View style={styles.grid}>
          {MINI_APPS_MAIN.map(app => (
            <TouchableOpacity key={app.id} style={styles.appCard} onPress={() => handleOpenApp(app.id)} activeOpacity={0.7}>
              <LinearGradient colors={app.gradient} style={styles.appIconWrap}>
                <Text style={styles.appEmoji}>{app.icon}</Text>
              </LinearGradient>
              <Text style={styles.appName}>{app.name}</Text>
              {!app.route && <Text style={styles.comingSoon}>Soon</Text>}
            </TouchableOpacity>
          ))}
        </View>

        {/* Games ship as a separate WebView deployment — no in-app games. */}

        {/* ── Utility Apps ───────────────────────────── */}
        <Text style={[styles.sectionTitle, { marginTop: 24 }]}>Tools</Text>
        <View style={styles.grid}>
          {MINI_APPS_UTILS.map(app => (
            <TouchableOpacity key={app.id} style={styles.appCard} onPress={() => handleOpenApp(app.id)} activeOpacity={0.7}>
              <LinearGradient colors={app.gradient} style={styles.appIconWrap}>
                <Text style={styles.appEmoji}>{app.icon}</Text>
              </LinearGradient>
              <Text style={styles.appName}>{app.name}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* ── Developer Section ─────────────────────── */}
        <Text style={[styles.sectionTitle, { marginTop: 28 }]}>Developer</Text>
        <LinearGradient
          colors={['#0F1D32', '#F9FAFB']}
          style={styles.devCard}
        >
          <View style={styles.devIconWrap}>
            <Text style={{ fontSize: 28 }}>🛠</Text>
          </View>
          <Text style={styles.devTitle}>Build Your Own</Text>
          <Text style={styles.devDesc}>
            Create custom mini apps using the VaultChat SDK. Build, test, and publish to the community.
          </Text>
          <TouchableOpacity
            style={styles.devBtn}
            onPress={() =>
              Alert.alert('Developer Docs', 'Documentation portal coming soon. Stay tuned!')
            }
          >
            <LinearGradient
              colors={['#7C3AED', '#4A9FFF']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.devBtnGrad}
            >
              <Text style={styles.devBtnText}>View Documentation →</Text>
            </LinearGradient>
          </TouchableOpacity>
        </LinearGradient>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0D0F14',
  },
  scroll: {
    padding: 20,
    paddingTop: 56,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 24,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#1A1D27',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  backArrow: {
    color: '#E8E8E8',
    fontSize: 20,
  },
  headerTitle: {
    color: '#E8E8E8',
    fontSize: 26,
    fontWeight: '700',
  },
  headerSub: {
    color: '#6B7280',
    fontSize: 13,
    marginTop: 2,
  },
  sectionTitle: {
    color: '#E8E8E8',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 14,
  },

  // ── 3-column Grid (matching PDF page 12) ───────────
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  appCard: {
    width: '30%',
    backgroundColor: '#1A1D27',
    borderRadius: 14,
    padding: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2A2D3A',
  },
  appIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  appEmoji: {
    fontSize: 24,
  },
  appName: {
    color: '#E8E8E8',
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
  },
  comingSoon: {
    color: '#6B7280',
    fontSize: 9,
    marginTop: 2,
    fontStyle: 'italic',
  },

  // ── Developer card ────────────────────────────────
  devCard: {
    borderRadius: 16,
    padding: 22,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1A2744',
  },
  devIconWrap: {
    width: 60,
    height: 60,
    borderRadius: 18,
    backgroundColor: '#1A2744',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 14,
  },
  devTitle: {
    color: '#000000',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 6,
  },
  devDesc: {
    color: '#8899AA',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginBottom: 16,
  },
  devBtn: {
    borderRadius: 12,
    overflow: 'hidden',
    width: '100%',
  },
  devBtnGrad: {
    paddingVertical: 13,
    alignItems: 'center',
    borderRadius: 12,
  },
  devBtnText: {
    color: '#000000',
    fontSize: 14,
    fontWeight: '700',
  },

  // ── Mini app container ────────────────────────────
  appContainer: {
    paddingBottom: 20,
  },
  closeAppBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 20,
  },
  closeAppText: {
    color: '#4A9FFF',
    fontSize: 15,
    fontWeight: '600',
  },

  // ── Calculator ────────────────────────────────────
  calcDisplay: {
    backgroundColor: '#F9FAFB',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    alignItems: 'flex-end',
    minHeight: 90,
    justifyContent: 'flex-end',
    borderWidth: 1,
    borderColor: '#1A2744',
  },
  calcDisplayText: {
    color: '#000000',
    fontSize: 42,
    fontWeight: '300',
  },
  calcOpIndicator: {
    color: '#4A9FFF',
    fontSize: 16,
    position: 'absolute',
    top: 14,
    right: 20,
  },
  calcRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  calcBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#1A2744',
    justifyContent: 'center',
    alignItems: 'center',
  },
  calcBtnOp: {
    backgroundColor: '#4A9FFF',
  },
  calcBtnFunc: {
    backgroundColor: '#2D3748',
  },
  calcBtnZero: {
    width: 152,
    borderRadius: 36,
  },
  calcBtnText: {
    color: '#000000',
    fontSize: 26,
    fontWeight: '500',
  },
  calcBtnTextOp: {
    color: '#000000',
    fontWeight: '600',
  },
  calcBtnTextFunc: {
    color: '#000000',
  },

  // ── Todo List ─────────────────────────────────────
  todoTitle: {
    color: '#000000',
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 4,
  },
  todoSubtitle: {
    color: '#8899AA',
    fontSize: 13,
    marginBottom: 18,
  },
  todoInputRow: {
    flexDirection: 'row',
    marginBottom: 18,
  },
  todoInput: {
    flex: 1,
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1A2744',
    color: '#000000',
    fontSize: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginRight: 10,
  },
  todoAddBtn: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: '#4A9FFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  todoAddBtnText: {
    color: '#000000',
    fontSize: 24,
    fontWeight: '600',
  },
  todoItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#1A2744',
  },
  todoCheck: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: '#4A9FFF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  todoCheckDone: {
    backgroundColor: '#4A9FFF',
    borderColor: '#4A9FFF',
  },
  todoCheckMark: {
    color: '#000000',
    fontSize: 14,
    fontWeight: '700',
  },
  todoText: {
    flex: 1,
    color: '#000000',
    fontSize: 14,
  },
  todoTextDone: {
    color: '#4A5568',
    textDecorationLine: 'line-through',
  },
  todoDelBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(220,38,38,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  todoDelText: {
    color: '#DC2626',
    fontSize: 14,
    fontWeight: '600',
  },
});
