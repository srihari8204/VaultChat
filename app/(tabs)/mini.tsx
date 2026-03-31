// app/mini-apps.tsx
// Mini Apps Platform — built-in mini apps with working Calculator and Todo List

import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
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

// ── Featured mini apps ───────────────────────────────────────────
const MINI_APPS = [
  { id: 'calculator', icon: '🧮', name: 'Calculator',      gradient: ['#4A9FFF', '#1D4ED8'] as [string, string] },
  { id: 'todo',       icon: '✅', name: 'Todo List',        gradient: ['#10B981', '#059669'] as [string, string] },
  { id: 'pomodoro',   icon: '🍅', name: 'Pomodoro Timer',   gradient: ['#F97316', '#DC2626'] as [string, string] },
  { id: 'expense',    icon: '💰', name: 'Expense Tracker',  gradient: ['#7C3AED', '#EC4899'] as [string, string] },
  { id: 'notes',      icon: '📝', name: 'Notes',            gradient: ['#F59E0B', '#D97706'] as [string, string] },
  { id: 'qr',         icon: '📱', name: 'QR Generator',     gradient: ['#06B6D4', '#0891B2'] as [string, string] },
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
          <Text style={styles.closeAppText}>← Back to Apps</Text>
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
          <Text style={styles.closeAppText}>← Back to Apps</Text>
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
            <Text style={styles.todoAddBtnText}>+</Text>
          </TouchableOpacity>
        </View>
        <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={false}>
          {todos.map(item => (
            <View key={item.id} style={styles.todoItem}>
              <TouchableOpacity
                style={[styles.todoCheck, item.done && styles.todoCheckDone]}
                onPress={() => toggleTodo(item.id)}
              >
                {item.done && <Text style={styles.todoCheckMark}>✓</Text>}
              </TouchableOpacity>
              <Text style={[styles.todoText, item.done && styles.todoTextDone]}>
                {item.text}
              </Text>
              <TouchableOpacity onPress={() => deleteTodo(item.id)} style={styles.todoDelBtn}>
                <Text style={styles.todoDelText}>✕</Text>
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
    } else {
      Alert.alert('Coming Soon', 'This mini app is under development.');
    }
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
            <Text style={styles.backArrow}>←</Text>
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>🔲 Mini Apps</Text>
            <Text style={styles.headerSub}>Powerful tools right inside your chats</Text>
          </View>
        </View>

        {/* ── Featured Apps Grid ────────────────────── */}
        <Text style={styles.sectionTitle}>Featured Apps</Text>
        <View style={styles.grid}>
          {MINI_APPS.map(app => (
            <View key={app.id} style={styles.appCard}>
              <LinearGradient colors={app.gradient} style={styles.appIconWrap}>
                <Text style={styles.appEmoji}>{app.icon}</Text>
              </LinearGradient>
              <Text style={styles.appName}>{app.name}</Text>
              <TouchableOpacity
                style={styles.openBtn}
                onPress={() => handleOpenApp(app.id)}
              >
                <Text style={styles.openBtnText}>Open</Text>
              </TouchableOpacity>
            </View>
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
    backgroundColor: '#FFFFFF',
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
    backgroundColor: '#F9FAFB',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  backArrow: {
    color: '#fff',
    fontSize: 20,
  },
  headerTitle: {
    color: '#000000',
    fontSize: 26,
    fontWeight: '700',
  },
  headerSub: {
    color: '#8899AA',
    fontSize: 13,
    marginTop: 2,
  },
  sectionTitle: {
    color: '#000000',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 14,
  },

  // ── Grid ──────────────────────────────────────────
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  appCard: {
    width: '48%',
    backgroundColor: '#F9FAFB',
    borderRadius: 16,
    padding: 18,
    alignItems: 'center',
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#1A2744',
  },
  appIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  appEmoji: {
    fontSize: 28,
  },
  appName: {
    color: '#000000',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 10,
  },
  openBtn: {
    paddingHorizontal: 22,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#4A9FFF',
  },
  openBtnText: {
    color: '#4A9FFF',
    fontSize: 13,
    fontWeight: '600',
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
