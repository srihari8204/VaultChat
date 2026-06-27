// app/ai-chat-bot.tsx — Aria AI Chat Bot
// CRED-inspired premium dark UI, on-device AI with pattern matching
// Persistent messages via AsyncStorage

import React, { useState, useRef, useEffect, useCallback , useMemo} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Animated,
  Easing,
  Dimensions,
  StatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { Stack, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { aiChat } from '../lib/ai';

const { width: SCREEN_W } = Dimensions.get('window');
const STORAGE_KEY = 'vc_aria_messages';

// ── CRED Palette ────────────────────────────────────────────────────

// ── Types ───────────────────────────────────────────────────────────
interface Message {
  id: string;
  text: string;
  sender: 'user' | 'aria';
  timestamp: number;
}

// ── Quick Reply Suggestions ─────────────────────────────────────────
const QUICK_REPLIES = [
  'Tell me a joke',
  'What can you do?',
  'Help with VaultChat',
];


// ── Typing Indicator Component ──────────────────────────────────────
function TypingIndicator() {
  const S = useS();
  const { colors } = useTheme();
  const dot1 = useRef(new Animated.Value(0)).current;
  const dot2 = useRef(new Animated.Value(0)).current;
  const dot3 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animate = (dot: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(dot, {
            toValue: -6,
            duration: 300,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(dot, {
            toValue: 0,
            duration: 300,
            easing: Easing.in(Easing.quad),
            useNativeDriver: true,
          }),
        ])
      );

    const a1 = animate(dot1, 0);
    const a2 = animate(dot2, 150);
    const a3 = animate(dot3, 300);

    a1.start();
    a2.start();
    a3.start();

    return () => {
      a1.stop();
      a2.stop();
      a3.stop();
    };
  }, [dot1, dot2, dot3]);

  return (
    <View style={S.typingRow}>
      <View style={S.ariaAvatarSmall}>
        <Text style={S.ariaAvatarTxt}>A</Text>
      </View>
      <View style={S.typingBubble}>
        {[dot1, dot2, dot3].map((dot, i) => (
          <Animated.View
            key={i}
            style={[S.typingDot, { transform: [{ translateY: dot }] }]}
          />
        ))}
      </View>
    </View>
  );
}

// ── Main Component ──────────────────────────────────────────────────
function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function AriaChatBot() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const flatListRef = useRef<FlatList>(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  // Load messages
  useEffect(() => {
    loadMessages();
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 600,
      useNativeDriver: true,
    }).start();
  }, [fadeAnim]);

  const loadMessages = async () => {
    try {
      const stored = await AsyncStorage.getItem(STORAGE_KEY);
      if (stored) {
        setMessages(JSON.parse(stored));
      } else {
        // Welcome message
        const welcome: Message = {
          id: 'welcome_' + Date.now(),
          text: "Hey! I'm Aria, your personal AI assistant. I live right on your device for maximum privacy. How can I help you today? 😊",
          sender: 'aria',
          timestamp: Date.now(),
        };
        setMessages([welcome]);
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([welcome]));
      }
    } catch {
      // Silent fail
    }
  };

  const saveMessages = async (msgs: Message[]) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(msgs));
    } catch {
      // Silent fail
    }
  };

  const sendMessage = useCallback(
    (text?: string) => {
      const msgText = (text || input).trim();
      if (!msgText) return;

      const userMsg: Message = {
        id: 'user_' + Date.now(),
        text: msgText,
        sender: 'user',
        timestamp: Date.now(),
      };

      const newMessages = [...messages, userMsg];
      setMessages(newMessages);
      setInput('');
      setIsTyping(true);
      saveMessages(newMessages);
      setTimeout(() => { flatListRef.current?.scrollToEnd({ animated: true }); }, 100);

      // Real assistant reply via the on-prem LLM (Ollama, through the backend).
      const history = messages.slice(-10).map((m) => ({
        role: (m.sender === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.text,
      }));
      aiChat(msgText, history)
        .then((reply) => {
          const ariaMsg: Message = {
            id: 'aria_' + Date.now(),
            text: reply || "I'm not sure how to answer that.",
            sender: 'aria',
            timestamp: Date.now(),
          };
          const updated = [...newMessages, ariaMsg];
          setMessages(updated);
          saveMessages(updated);
        })
        .catch((e: any) => {
          const text = e?.status === 503
            ? 'The assistant is offline right now — please try again shortly.'
            : 'Sorry, I couldn’t reach the assistant just now.';
          const errMsg: Message = { id: 'aria_' + Date.now(), text, sender: 'aria', timestamp: Date.now() };
          const updated = [...newMessages, errMsg];
          setMessages(updated);
          saveMessages(updated);
        })
        .finally(() => {
          setIsTyping(false);
          setTimeout(() => { flatListRef.current?.scrollToEnd({ animated: true }); }, 100);
        });
    },
    [input, messages]
  );

  const formatTime = (ts: number) => {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // ── Render Message ──────────────────────────────────────────────
  const renderMessage = ({ item }: { item: Message }) => {
    const isUser = item.sender === 'user';

    return (
      <View style={[S.msgRow, isUser ? S.msgRowRight : S.msgRowLeft]}>
        {!isUser && (
          <View style={S.ariaAvatarSmall}>
            <Text style={S.ariaAvatarTxt}>A</Text>
          </View>
        )}
        <View
          style={[
            S.bubble,
            isUser ? S.bubbleUser : S.bubbleAria,
          ]}
        >
          <Text style={[S.bubbleText, isUser ? S.bubbleTextUser : S.bubbleTextAria]}>
            {item.text}
          </Text>
          <Text style={S.bubbleTime}>{formatTime(item.timestamp)}</Text>
        </View>
      </View>
    );
  };

  // ── Clear Chat ──────────────────────────────────────────────────
  const clearChat = async () => {
    const welcome: Message = {
      id: 'welcome_' + Date.now(),
      text: "Chat cleared! Fresh start. How can I help you? 😊",
      sender: 'aria',
      timestamp: Date.now(),
    };
    setMessages([welcome]);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([welcome]));
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="light-content" backgroundColor={'#000000'} />

      <Animated.View style={[S.container, { opacity: fadeAnim }]}>
        {/* ── Header ─────────────────────────────────────────────── */}
        <View style={S.header}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={S.backButton}
            activeOpacity={0.7}
          >
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>

          <View style={S.headerCenter}>
            <View style={S.headerAvatar}>
              <Text style={S.headerAvatarTxt}>A</Text>
            </View>
            <View style={S.headerInfo}>
              <View style={S.headerNameRow}>
                <Text style={S.headerName}>Aria</Text>
                <View style={S.onlineDot} />
              </View>
              <Text style={S.headerSubtitle}>AI Assistant</Text>
            </View>
          </View>

          <TouchableOpacity
            onPress={clearChat}
            style={S.clearBtn}
            activeOpacity={0.7}
          >
            <Text style={S.clearTxt}>Clear</Text>
          </TouchableOpacity>
        </View>

        <View style={S.headerDivider} />

        {/* ── Messages ───────────────────────────────────────────── */}
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderMessage}
          contentContainerStyle={S.messagesList}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={() =>
            flatListRef.current?.scrollToEnd({ animated: true })
          }
          ListFooterComponent={isTyping ? <TypingIndicator /> : null}
        />

        {/* ── Quick Replies ──────────────────────────────────────── */}
        <View style={S.quickRepliesWrap}>
          <FlatList
            horizontal
            data={QUICK_REPLIES}
            keyExtractor={(item) => item}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={S.quickRepliesList}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={S.quickChip}
                onPress={() => sendMessage(item)}
                activeOpacity={0.7}
              >
                <Text style={S.quickChipText}>{item}</Text>
              </TouchableOpacity>
            )}
          />
        </View>

        {/* ── Input Bar ──────────────────────────────────────────── */}
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
        >
          <View style={S.inputBar}>
            <View style={S.inputWrap}>
              <TextInput
                style={S.input}
                placeholder="Message Aria..."
                placeholderTextColor={'#666666'}
                value={input}
                onChangeText={setInput}
                multiline
                maxLength={1000}
                returnKeyType="send"
                onSubmitEditing={() => sendMessage()}
                blurOnSubmit={false}
              />
            </View>
            <TouchableOpacity
              style={[
                S.sendBtn,
                input.trim() ? S.sendBtnActive : S.sendBtnInactive,
              ]}
              onPress={() => sendMessage()}
              disabled={!input.trim()}
              activeOpacity={0.7}
            >
              <Ionicons
                name="arrow-forward"
                size={18}
                color={input.trim() ? '#000000' : 'rgba(255,255,255,0.2)'}
              />
            </TouchableOpacity>
          </View>

          <View style={S.bottomSafe} />
        </KeyboardAvoidingView>
      </Animated.View>
    </>
  );
}

// ── Styles ──────────────────────────────────────────────────────────
const makeStyles = (c: Palette) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: c.bg,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: Platform.OS === 'ios' ? 56 : 44,
    paddingBottom: 14,
    paddingHorizontal: 16,
    backgroundColor: '#000000',
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  backArrow: {
    color: c.text,
    fontSize: 22,
    fontWeight: '300',
  },
  headerCenter: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 8,
  },
  headerAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#1A1A2E',
    borderWidth: 1,
    borderColor: 'rgba(192,192,192,0.2)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerAvatarTxt: {
    color: '#C0C0C0',
    fontSize: 17,
    fontWeight: '600',
  },
  headerInfo: {
    marginLeft: 10,
  },
  headerNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  headerName: {
    color: c.text,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  onlineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: c.primary,
  },
  headerSubtitle: {
    color: '#666666',
    fontSize: 12,
    fontWeight: '400',
    marginTop: 1,
  },
  clearBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  clearTxt: {
    color: '#A0A0A0',
    fontSize: 12,
    fontWeight: '500',
  },
  headerDivider: {
    height: 1,
    backgroundColor: c.border,
  },

  // Messages
  messagesList: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  msgRow: {
    flexDirection: 'row',
    marginBottom: 16,
    maxWidth: '85%',
  },
  msgRowRight: {
    alignSelf: 'flex-end',
  },
  msgRowLeft: {
    alignSelf: 'flex-start',
  },

  // Aria avatar (small)
  ariaAvatarSmall: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#1A1A2E',
    borderWidth: 1,
    borderColor: 'rgba(192,192,192,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
    marginTop: 4,
  },
  ariaAvatarTxt: {
    color: '#C0C0C0',
    fontSize: 13,
    fontWeight: '600',
  },

  // Bubbles
  bubble: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 18,
    maxWidth: SCREEN_W * 0.72,
  },
  bubbleUser: {
    backgroundColor: '#1C1C1E',
    borderBottomRightRadius: 4,
  },
  bubbleAria: {
    backgroundColor: '#141414',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    borderBottomLeftRadius: 4,
  },
  bubbleText: {
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '400',
  },
  bubbleTextUser: {
    color: c.text,
  },
  bubbleTextAria: {
    color: 'rgba(255,255,255,0.88)',
  },
  bubbleTime: {
    color: 'rgba(255,255,255,0.25)',
    fontSize: 10,
    fontWeight: '400',
    marginTop: 6,
    alignSelf: 'flex-end',
  },

  // Typing indicator
  typingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    alignSelf: 'flex-start',
  },
  typingBubble: {
    flexDirection: 'row',
    gap: 5,
    backgroundColor: '#141414',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 18,
    borderBottomLeftRadius: 4,
  },
  typingDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: 'rgba(255,255,255,0.3)',
  },

  // Quick replies
  quickRepliesWrap: {
    borderTopWidth: 1,
    borderTopColor: c.border,
    paddingVertical: 10,
  },
  quickRepliesList: {
    paddingHorizontal: 16,
    gap: 8,
  },
  quickChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  quickChipText: {
    color: '#A0A0A0',
    fontSize: 13,
    fontWeight: '400',
  },

  // Input bar
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  inputWrap: {
    flex: 1,
    backgroundColor: '#0E0E0E',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 18,
    paddingVertical: Platform.OS === 'ios' ? 10 : 4,
    maxHeight: 120,
  },
  input: {
    color: c.text,
    fontSize: 15,
    fontWeight: '400',
    lineHeight: 20,
    maxHeight: 100,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 2,
  },
  sendBtnActive: {
    backgroundColor: c.text,
  },
  sendBtnInactive: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  sendIcon: {
    fontSize: 16,
    fontWeight: '700',
  },
  sendIconActive: {
    color: '#000000',
  },
  sendIconInactive: {
    color: 'rgba(255,255,255,0.2)',
  },

  bottomSafe: {
    height: Platform.OS === 'ios' ? 20 : 8,
  },
});
