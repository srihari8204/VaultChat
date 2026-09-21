// app/(tabs)/mini.tsx
// Mini Apps Platform — a launcher for the full mini apps, plus the built-in
// Calculator and Todo List that run inline here.
//
// Tiles that only raise "Coming Soon" are NOT listed: a dead tile on a primary
// tab reads as a broken app, not as a promise. Add one back the same day its
// screen lands.

import { BRAND_ACCENT, BRAND_GRADIENT_CTA } from '../../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { encField, decField } from '../../lib/cacheCrypto';
import { flagEnabled } from '../../lib/remoteFlags';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useRouter } from 'expo-router';
import { HEADER_TOP, TAB_BAR_SPACE } from '../../constants/layout';
import React, { useEffect, useState, useMemo } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { AppText, AuroraBackground } from '../../components/ui';
import type { Palette } from '../../constants/theme';
import { useColors } from '../../lib/theme';
import { GLOW } from '../../constants/glass';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

// ── Mini Apps matching PDF (page 12) ─────────────────────────────
// Row 1: Watch, Walkie, Screen
// Row 2: Notes, Scanner, Location
// Row 3: Current Loc, Cloud, Security Hub
const MINI_APPS_MAIN = [
  // Broadcast. The ONLY mode that is not end-to-end encrypted \u2014 app/live.tsx
  // states that before anything is published, rather than leaving someone to
  // assume their stream has the same protection as their calls.
  { id: 'live',        icon: 'radio-outline', name: 'Go Live', route: '/live', gradient: ['#EF4444', '#B91C1C'] as [string, string] },
  { id: 'navigate',    icon: 'navigate-outline', name: 'Navigate', route: '/navigate', gradient: ['#1777FE', '#1D4ED8'] as [string, string] },
  // Spaces absorbed the old Family Circle + SOS tiles \u2014 one app, one hub.
  // Renamed from "Family Space": family is one TYPE of space, alongside school
  // transport, offices and the rest. The route stays /family so existing deep
  // links and the tile's stored id keep working \u2014 renaming a route to match a
  // label is churn that breaks bookmarks.
  { id: 'familyspace', icon: 'people-outline', name: 'Spaces', route: '/family', gradient: ['#7C3AED', '#2563EB'] as [string, string] },
  { id: 'finance',     icon: 'cash-outline', name: 'Vault Finance', route: '/finance', gradient: ['#6D3FA8', '#1552E0'] as [string, string] },
  { id: 'shopbook',    icon: 'storefront-outline', name: 'Shop Book', route: '/shop-book', gradient: ['#0B7A3B', '#16A34A'] as [string, string] },
  { id: 'notes',       icon: 'document-text-outline', name: 'Notes',       route: '/encrypted-notes', gradient: ['#F59E0B', '#D97706'] as [string, string] },
  { id: 'scanner',     icon: 'scan-outline', name: 'Scanner',     route: '/docscanner',     gradient: ['#1777FE', '#1D4ED8'] as [string, string] },
  { id: 'shelf',       icon: 'library-outline', name: 'Shelf',        route: '/shelf',      gradient: ['#B45309', '#D97706'] as [string, string] },
  // Hosted at games.corefinite.com, rendered in a WebView. Auth is not wired
  // yet by design \u2014 the site loads anonymously until it is.
  { id: 'games',       icon: 'game-controller-outline', name: 'Games',       route: '/games',      gradient: ['#DB2777', '#7C3AED'] as [string, string] },
  { id: 'security',    icon: 'shield-checkmark-outline', name: 'Security Hub', route: '/aiguardian', gradient: ['#0E7490', '#164E63'] as [string, string] },
  { id: 'vaultid',     icon: 'id-card-outline', name: 'VaultID',     route: '/decentralized-id', gradient: ['#7C3AED', '#1777FE'] as [string, string] },
] satisfies readonly { id: string; icon: IoniconName; name: string; route: string; gradient: [string, string] }[];

// ── Built-in utility mini apps ──────────────────────────────────
const MINI_APPS_UTILS = [
  { id: 'calculator', icon: 'calculator-outline', name: 'Calculator', gradient: [BRAND_ACCENT, '#7C3AED'] as [string, string] },
  { id: 'todo',       icon: 'checkmark-done-outline', name: 'Todo List', gradient: [BRAND_ACCENT, '#059669'] as [string, string] },
] satisfies readonly { id: string; icon: IoniconName; name: string; gradient: [string, string] }[];

const TODO_STORAGE_KEY = 'vc_miniapp_todos';

interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}

export default function MiniAppsScreen() {
  const c = useColors();
  const { width } = useWindowDimensions();
  const styles = useMemo(() => makeStyles(c, width), [c, width]);
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

  // Todo text is user content, so it is sealed at rest with the same cache DEK
  // as messages and notes (encField/decField) rather than sitting in the clear.
  // decField returns the value unchanged for rows written before this, so
  // existing lists keep loading.
  const loadTodos = async () => {
    try {
      const raw = decField(await AsyncStorage.getItem(TODO_STORAGE_KEY));
      if (raw) setTodos(JSON.parse(raw));
    } catch { /* sealed while locked, or corrupt — start empty rather than crash */ }
  };

  const saveTodos = async (items: TodoItem[]) => {
    try {
      await AsyncStorage.setItem(TODO_STORAGE_KEY, encField(JSON.stringify(items))!);
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
          <Ionicons name="arrow-back" size={16} color={c.accentOn} />
          <AppText variant="bodyStrong" color={c.accentOn} style={styles.closeAppText}>Back to Apps</AppText>
        </TouchableOpacity>
        <View style={styles.calcDisplay}>
          <AppText style={styles.calcDisplayText} numberOfLines={1} adjustsFontSizeToFit>
            {calcDisplay}
          </AppText>
          {calcOp && (
            <AppText variant="bodyStrong" color={c.accentOn} style={styles.calcOpIndicator}>{calcOp}</AppText>
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
                  <AppText
                    style={[
                      styles.calcBtnText,
                      isOp && styles.calcBtnTextOp,
                      isFunc && styles.calcBtnTextFunc,
                    ]}
                  >
                    {btn}
                  </AppText>
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
          <Ionicons name="arrow-back" size={16} color={c.accentOn} />
          <AppText variant="bodyStrong" color={c.accentOn} style={styles.closeAppText}>Back to Apps</AppText>
        </TouchableOpacity>
        <AppText variant="title" style={styles.todoTitle}>Todo List</AppText>
        <AppText variant="callout" style={styles.todoSubtitle}>
          {todos.length === 0
            ? 'No tasks yet — add one below'
            : `${pending} pending · ${todos.length - pending} done`}
        </AppText>
        <View style={styles.todoInputRow}>
          <TextInput
            style={styles.todoInput}
            placeholder="Add a task..."
            placeholderTextColor={c.textDim}
            value={todoInput}
            onChangeText={setTodoInput}
            onSubmitEditing={addTodo}
            returnKeyType="done"
          />
          <TouchableOpacity style={styles.todoAddBtn} onPress={addTodo} accessibilityLabel="Add to-do" accessibilityRole="button">
            <Ionicons name="add" size={24} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
        <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={false}>
          {todos.map(item => (
            <View key={item.id} style={styles.todoItem}>
              <TouchableOpacity hitSlop={9}
                style={[styles.todoCheck, item.done && styles.todoCheckDone]}
                onPress={() => toggleTodo(item.id)} accessibilityLabel="Mark to-do done" accessibilityRole="checkbox" accessibilityState={{ checked: item.done }}
              >
                {item.done && <Ionicons name="checkmark" size={14} color="#FFFFFF" />}
              </TouchableOpacity>
              <AppText style={[styles.todoText, item.done && styles.todoTextDone]}>
                {item.text}
              </AppText>
              <TouchableOpacity hitSlop={7} onPress={() => Alert.alert('Delete to-do?', `Delete "${item.text}"?`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => deleteTodo(item.id) }])} style={styles.todoDelBtn} accessibilityLabel="Delete to-do" accessibilityRole="button">
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
    //
    // A tile hidden by a kill switch must not be reachable by a stale deep link
    // or a remembered "recent app" entry either — hiding the button while the
    // route still opens is a half-disabled feature, which is the failure mode a
    // kill switch exists to avoid.
    if (!flagEnabled(`mini.${appId}`)) return;
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
      <AuroraBackground variant="mini" />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* ── Header ────────────────────────────────── */}
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} accessibilityLabel="Back">
            <Ionicons name="arrow-back" size={20} color={c.text} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <View style={styles.titleRow}>
              <Ionicons name="grid-outline" size={24} color={c.accentOn} />
              <AppText variant="title" style={styles.headerTitle}>Mini Apps</AppText>
            </View>
            <AppText variant="callout" style={styles.headerSub}>Powerful tools right inside your chats</AppText>
          </View>
        </View>

        {/* ── Mini Apps 3x3 Grid (matching PDF page 12) ─── */}
        <AppText variant="h3" style={styles.sectionTitle}>Mini Apps</AppText>
        <View style={styles.grid}>
          {/* AUDIT F11. Each tile is behind a kill switch keyed on its id, so a
              mini-app that starts misbehaving — a broken WebView, a dependency
              outage, a partner endpoint down — can be taken off every device by
              setting VAULTCHAT_REMOTE_FLAGS={"mini.<id>":false} and restarting
              the API, instead of shipping a build that only reaches the people
              who update. The server can only DISABLE; see lib/remoteFlagPolicy.
              Until the flags load, and whenever they cannot, every tile shows —
              the app behaves as built. */}
          {MINI_APPS_MAIN.filter(app => flagEnabled(`mini.${app.id}`)).map(app => (
            <TouchableOpacity
              key={app.id}
              style={styles.appCard}
              onPress={() => handleOpenApp(app.id)}
              activeOpacity={0.78}
              accessibilityRole="button"
              accessibilityLabel={app.name}
            >
              <LinearGradient colors={app.gradient} style={styles.appIconWrap}>
                <Ionicons name={app.icon} size={24} color="#FFFFFF" />
              </LinearGradient>
              <AppText variant="tiny" numberOfLines={2} style={styles.appName}>{app.name}</AppText>
              {!app.route && <AppText variant="tiny" style={styles.comingSoon}>Soon</AppText>}
            </TouchableOpacity>
          ))}
        </View>

        {/* Games ship as a separate WebView deployment — no in-app games. */}

        {/* ── Utility Apps ───────────────────────────── */}
        <AppText variant="h3" style={[styles.sectionTitle, { marginTop: 24 }]}>Tools</AppText>
        <View style={styles.grid}>
          {MINI_APPS_UTILS.map(app => (
            <TouchableOpacity
              key={app.id}
              style={styles.appCard}
              onPress={() => handleOpenApp(app.id)}
              activeOpacity={0.78}
              accessibilityRole="button"
              accessibilityLabel={app.name}
            >
              <LinearGradient colors={app.gradient} style={styles.appIconWrap}>
                <Ionicons name={app.icon} size={24} color="#FFFFFF" />
              </LinearGradient>
              <AppText variant="tiny" numberOfLines={2} style={styles.appName}>{app.name}</AppText>
            </TouchableOpacity>
          ))}
        </View>

        {/* ── Developer Section ─────────────────────── */}
        <AppText variant="h3" style={[styles.sectionTitle, { marginTop: 28 }]}>Developer</AppText>
        <LinearGradient
          colors={[c.glass, c.glassSoft]}
          style={styles.devCard}
        >
          <View style={styles.devIconWrap}>
            <Ionicons name="construct-outline" size={28} color={c.accentOn} />
          </View>
          <AppText variant="h3" style={styles.devTitle}>Build Your Own</AppText>
          <AppText variant="callout" style={styles.devDesc}>
            Create custom mini apps using the crazzychat SDK. Build, test, and publish to the community.
          </AppText>
          <TouchableOpacity
            style={styles.devBtn}
            onPress={() =>
              Alert.alert('Developer Docs', 'Documentation portal coming soon. Stay tuned!')
            }
            accessibilityRole="button"
            accessibilityLabel="View developer documentation"
          >
            <LinearGradient
              colors={BRAND_GRADIENT_CTA}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.devBtnGrad}
            >
              <AppText variant="bodyStrong" style={styles.devBtnText}>View Documentation</AppText>
            </LinearGradient>
          </TouchableOpacity>
        </LinearGradient>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────
const makeStyles = (c: Palette, width: number) => {
  const contentW = Math.max(280, width - 40);
  const gridGap = 10;
  const gridCols = width >= 840 ? 5 : width >= 600 ? 4 : 3;
  const appCardW = Math.floor((contentW - gridGap * (gridCols - 1)) / gridCols);
  const calcBtn = Math.min(72, Math.floor((contentW - gridGap * 3) / 4));
  const calcZero = calcBtn * 2 + gridGap;

  return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: c.bg,
  },
  scroll: {
    padding: 20,
    paddingTop: HEADER_TOP,
    paddingBottom: TAB_BAR_SPACE + 16,
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
    backgroundColor: c.glassSoft,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.glassStroke,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitle: {
    color: c.text,
    fontSize: 26,
    fontWeight: '800',
  },
  headerSub: {
    color: c.textDim,
    fontSize: 13,
    marginTop: 2,
  },
  sectionTitle: {
    color: c.text,
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 14,
  },

  // ── 3-column Grid (matching PDF page 12) ───────────
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: gridGap,
  },
  appCard: {
    width: appCardW,
    minHeight: 104,
    backgroundColor: c.glass,
    borderRadius: 20,
    paddingHorizontal: 8,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.glassStroke,
    ...GLOW.accent,
    shadowOpacity: 0.14,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 3,
  },
  appIconWrap: {
    width: 50,
    height: 50,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 9,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  appName: {
    color: c.text,
    textAlign: 'center',
    minHeight: 28,
  },
  comingSoon: {
    color: c.textDim,
    marginTop: 2,
    fontStyle: 'italic',
  },

  // ── Developer card ────────────────────────────────
  devCard: {
    borderRadius: 24,
    padding: 22,
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.glassStroke,
  },
  devIconWrap: {
    width: 60,
    height: 60,
    borderRadius: 18,
    backgroundColor: c.glassSoft,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.glassStroke,
  },
  devTitle: {
    color: c.text,
    marginBottom: 6,
  },
  devDesc: {
    color: c.textDim,
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
    color: '#FFFFFF',
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
    marginTop: -1,
  },

  // ── Calculator ────────────────────────────────────
  calcDisplay: {
    backgroundColor: c.glassSoft,
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    alignItems: 'flex-end',
    minHeight: 90,
    justifyContent: 'flex-end',
    borderWidth: 1,
    borderColor: c.glassStroke,
  },
  calcDisplayText: {
    color: c.text,
    fontSize: 42,
    fontWeight: '300',
  },
  calcOpIndicator: {
    color: c.accentOn,
    fontSize: 16,
    position: 'absolute',
    top: 14,
    right: 20,
  },
  calcRow: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    gap: gridGap,
    marginBottom: 10,
  },
  calcBtn: {
    width: calcBtn,
    height: calcBtn,
    borderRadius: calcBtn / 2,
    backgroundColor: c.surfaceSolid,
    justifyContent: 'center',
    alignItems: 'center',
  },
  calcBtnOp: {
    backgroundColor: c.accentDeep,
  },
  calcBtnFunc: {
    backgroundColor: c.surfaceSolid,
  },
  calcBtnZero: {
    width: calcZero,
    borderRadius: calcBtn / 2,
  },
  calcBtnText: {
    color: c.text,
    fontSize: 26,
    fontWeight: '500',
  },
  calcBtnTextOp: {
    color: c.text,
    fontWeight: '600',
  },
  calcBtnTextFunc: {
    color: c.text,
  },

  // ── Todo List ─────────────────────────────────────
  todoTitle: {
    color: c.text,
    marginBottom: 4,
  },
  todoSubtitle: {
    color: c.textDim,
    marginBottom: 18,
  },
  todoInputRow: {
    flexDirection: 'row',
    marginBottom: 18,
  },
  todoInput: {
    flex: 1,
    backgroundColor: c.glassSoft,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.glassStroke,
    color: c.text,
    fontSize: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginRight: 10,
  },
  todoAddBtn: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: c.accentDeep,
    justifyContent: 'center',
    alignItems: 'center',
  },
  todoItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.glassSoft,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: c.glassStroke,
  },
  todoCheck: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: c.accentOn,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  todoCheckDone: {
    backgroundColor: c.accentDeep,
    borderColor: c.accentDeep,
  },
  todoText: {
    flex: 1,
    color: c.text,
    fontSize: 14,
  },
  todoTextDone: {
    color: c.textDim,
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
  });
};
