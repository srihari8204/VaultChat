// app/ai-chat-bot.tsx — Aria AI Chat Bot
// CRED-inspired premium dark UI, on-device AI with pattern matching
// Persistent messages via AsyncStorage

import React, { useState, useRef, useEffect, useCallback } from 'react';
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
import { Stack, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { aiChat } from '../lib/ai';

const { width: SCREEN_W } = Dimensions.get('window');
const STORAGE_KEY = 'vc_aria_messages';

// ── CRED Palette ────────────────────────────────────────────────────
const CLR = {
  black: '#000000',
  bg: '#000000',
  white: '#FFFFFF',
  silver: '#A0A0A0',
  silverLight: '#C0C0C0',
  silverDim: '#666666',
  cardDark: '#111111',
  cardLight: '#1A1A1A',
  userBubble: '#1C1C1E',
  ariaBubble: '#141414',
  ariaBubbleBorder: 'rgba(255,255,255,0.06)',
  inputBg: '#0E0E0E',
  inputBorder: 'rgba(255,255,255,0.08)',
  green: '#34C759',
  accent: '#C0C0C0',
  sendActive: '#FFFFFF',
  sendInactive: 'rgba(255,255,255,0.15)',
  divider: 'rgba(255,255,255,0.04)',
  chipBg: 'rgba(255,255,255,0.04)',
  chipBorder: 'rgba(255,255,255,0.08)',
};

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

// ── Joke Bank ───────────────────────────────────────────────────────
const JOKES = [
  "Why do programmers prefer dark mode? Because light attracts bugs.",
  "I told my wife she was drawing her eyebrows too high. She looked surprised.",
  "Why don't scientists trust atoms? Because they make up everything.",
  "What do you call a fake noodle? An impasta.",
  "Why did the scarecrow win an award? He was outstanding in his field.",
  "I'm reading a book about anti-gravity. It's impossible to put down.",
  "What do you call a bear with no teeth? A gummy bear.",
  "Why did the bicycle fall over? Because it was two tired.",
  "I used to hate facial hair, but then it grew on me.",
  "What's a computer's least favorite food? Spam.",
  "Why do cows have hooves instead of feet? Because they lactose.",
  "I told my computer I needed a break, and now it won't stop sending me Kit Kat ads.",
  "Parallel lines have so much in common. It's a shame they'll never meet.",
  "Why was the math book sad? It had too many problems.",
  "What did the ocean say to the beach? Nothing, it just waved.",
];

// ── VaultChat Feature Knowledge Base ────────────────────────────────
const VAULTCHAT_INFO = {
  general:
    "VaultChat is a privacy-first encrypted messaging app. It features end-to-end encryption, biometric authentication, disappearing messages, secure file sharing, and much more. Your data stays yours.",
  encryption:
    "VaultChat uses military-grade end-to-end encryption for all messages, calls, and file transfers. Not even our servers can read your messages. We use the Signal Protocol combined with additional security layers.",
  features:
    "Here's what VaultChat offers:\n\n" +
    "  Encrypted messaging & calls\n" +
    "  Biometric lock & face verification\n" +
    "  Disappearing messages\n" +
    "  Secure file vault\n" +
    "  Group chats with admin controls\n" +
    "  Voice effects & transcription\n" +
    "  AI assistant (that's me!)\n" +
    "  Dark web monitoring\n" +
    "  Chat themes & wallpapers\n" +
    "  Broadcast messages\n" +
    "  And many more security features",
  privacy:
    "Your privacy is our top priority. VaultChat doesn't store messages on servers after delivery, uses zero-knowledge encryption, and never sells your data. The app also prevents screenshots and screen recording.",
  security:
    "VaultChat includes multi-layer security: biometric authentication, 8-digit secret codes, security questions, jailbreak detection, anti-tampering checks, and encrypted local storage. Your vault is truly secure.",
};

// ── Compliment Responses ────────────────────────────────────────────
const COMPLIMENT_RESPONSES = [
  "That's so kind of you! You just made my day brighter.",
  "Thank you! You're pretty wonderful yourself.",
  "Aw, you're making me blush! Well, if I could blush.",
  "That means a lot! I'm here whenever you need me.",
  "You're too sweet! Happy to help anytime.",
];

// ── Greeting Responses ──────────────────────────────────────────────
const GREETINGS = [
  "Hey! How can I help you today? 😊",
  "Hi there! Great to see you. What's on your mind?",
  "Hello! I'm Aria, your AI assistant. How can I help?",
  "Hey! Ready to help with whatever you need 😊",
  "Hi! Hope you're having a great day. What can I do for you?",
];

// ── Default Fallbacks ───────────────────────────────────────────────
const FALLBACK_RESPONSES = [
  "That's interesting! Tell me more about that.",
  "I hear you! Is there anything specific I can help you with?",
  "Hmm, that's a great thought. Want me to help with anything in VaultChat?",
  "I appreciate you sharing that! Feel free to ask me anything about VaultChat or just chat.",
  "Got it! I'm always here if you need help with anything.",
  "That's cool! By the way, you can ask me about VaultChat features, tell jokes, or just chat.",
  "Interesting! I may be an on-device AI, but I'm a good listener. What else is on your mind?",
  "Thanks for sharing! Let me know if there's anything I can help with.",
];

// ── Farewell Responses ──────────────────────────────────────────────
const FAREWELLS = [
  "See you later! I'll be right here when you need me.",
  "Bye for now! Take care and stay secure with VaultChat.",
  "Catch you later! Don't forget, I'm always just a tap away.",
  "Goodbye! Have an amazing rest of your day.",
];

// ── Math Evaluation ─────────────────────────────────────────────────
function evaluateMath(expr: string): string | null {
  // Extract math expression
  const cleaned = expr.replace(/[^0-9+\-*/().%^ ]/g, '').trim();
  if (!cleaned || cleaned.length < 3) return null;

  try {
    // Safe eval with only math operations
    const sanitized = cleaned
      .replace(/\^/g, '**')
      .replace(/[^0-9+\-*/().% ]/g, '');

    if (!sanitized || /[a-zA-Z]/.test(sanitized)) return null;

    const result = Function('"use strict"; return (' + sanitized + ')')();
    if (typeof result === 'number' && isFinite(result)) {
      return `${cleaned} = ${Number.isInteger(result) ? result : result.toFixed(4)}`;
    }
  } catch {
    return null;
  }
  return null;
}

// ── Generate AI Response ────────────────────────────────────────────
function generateAriaResponse(text: string): string {
  const lower = text.toLowerCase().trim();

  // Greetings
  if (
    /^(hi|hello|hey|yo|sup|howdy|hola|greetings|what'?s? up|good morning|good afternoon|good evening)/i.test(lower)
  ) {
    return GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
  }

  // Farewell
  if (/^(bye|goodbye|see you|later|gotta go|take care|goodnight|good night|cya)/i.test(lower)) {
    return FAREWELLS[Math.floor(Math.random() * FAREWELLS.length)];
  }

  // How are you
  if (/how are you|how('?re| are) (you|u)|how do you do|how('?s| is) it going/i.test(lower)) {
    const responses = [
      "I'm doing great, thanks for asking! How about you? 😊",
      "I'm running perfectly! All systems go. How can I help?",
      "Feeling fantastic! Ready to help with anything you need.",
      "I'm good! Living my best AI life inside your phone. What's up?",
    ];
    return responses[Math.floor(Math.random() * responses.length)];
  }

  // What are you / who are you
  if (/who are you|what are you|tell me about yourself|introduce yourself/i.test(lower)) {
    return (
      "I'm Aria, your on-device AI assistant built into VaultChat. " +
      "I run entirely on your phone for maximum privacy — no data ever leaves your device when you chat with me.\n\n" +
      "I can help you with VaultChat features, tell jokes, do basic math, and just have a friendly conversation!"
    );
  }

  // What can you do
  if (/what can you do|your (features|capabilities|abilities)|help me|what do you do/i.test(lower)) {
    return (
      "Here's what I can help with:\n\n" +
      "  Answer questions about VaultChat\n" +
      "  Explain security & privacy features\n" +
      "  Tell jokes to lighten the mood\n" +
      "  Do basic math calculations\n" +
      "  Have friendly conversations\n" +
      "  Offer translation guidance\n" +
      "  Set reminders (coming soon)\n\n" +
      "Just ask me anything!"
    );
  }

  // Jokes
  if (/joke|funny|make me laugh|humor|tell me something funny/i.test(lower)) {
    return JOKES[Math.floor(Math.random() * JOKES.length)];
  }

  // VaultChat questions
  if (/vaultchat|vault chat|this app|the app/i.test(lower)) {
    if (/encrypt|e2e|end.to.end|security|secure/i.test(lower)) {
      return VAULTCHAT_INFO.encryption;
    }
    if (/privacy|private|data|track/i.test(lower)) {
      return VAULTCHAT_INFO.privacy;
    }
    if (/feature|can it|does it|what does|offer|capability/i.test(lower)) {
      return VAULTCHAT_INFO.features;
    }
    if (/safe|protect|lock|biometric|face|fingerprint/i.test(lower)) {
      return VAULTCHAT_INFO.security;
    }
    return VAULTCHAT_INFO.general;
  }

  // Weather
  if (/weather|temperature|forecast|rain|sunny|hot|cold outside/i.test(lower)) {
    return "I'd check for you but I'm an on-device AI — no internet access for privacy! Try asking your weather app.";
  }

  // Reminders
  if (/remind|reminder|set a reminder|don't forget|remember to/i.test(lower)) {
    return "Sure! I'll set that up for you. Reminder feature is being built into VaultChat — stay tuned! For now, try your phone's built-in reminders app.";
  }

  // Compliments
  if (
    /thank|thanks|you('?re| are) (great|awesome|amazing|the best|wonderful|cool|helpful)|good (job|work|bot)|love you|appreciate/i.test(lower)
  ) {
    return COMPLIMENT_RESPONSES[Math.floor(Math.random() * COMPLIMENT_RESPONSES.length)];
  }

  // Math
  if (/[\d]+\s*[+\-*/^%]\s*[\d]+|calculate|compute|what('?s| is) \d/i.test(lower)) {
    const mathResult = evaluateMath(text);
    if (mathResult) {
      return `Here you go:\n\n${mathResult}`;
    }
  }

  // Translation
  if (/translat|translate this|how do you say|in (spanish|french|hindi|german|japanese|chinese|arabic)/i.test(lower)) {
    return "I can guide you to VaultChat's built-in translation feature! In any chat, long-press a message and select 'Translate' — it supports 40+ languages. For a full translation tool, check out the Translate screen from the chat menu.";
  }

  // Time / Date
  if (/what time|current time|what('?s| is) the (time|date)|today('?s| is) date/i.test(lower)) {
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = now.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    return `It's ${timeStr} on ${dateStr}.`;
  }

  // Name question
  if (/your name|what('?s| is) your name|name\??$/i.test(lower)) {
    return "I'm Aria! Your personal AI assistant inside VaultChat. Nice to meet you 😊";
  }

  // Meaning of life / philosophical
  if (/meaning of life|purpose of life|why are we here|what is life/i.test(lower)) {
    return "42. At least that's what Douglas Adams said! But I think the meaning of life is to find what makes you happy and hold onto it. And of course, keeping your chats secure with VaultChat.";
  }

  // Bored
  if (/bored|i('?m| am) bored|nothing to do|entertain me/i.test(lower)) {
    const suggestions = [
      "How about I tell you a joke? Just say 'tell me a joke'!",
      "Want to explore VaultChat's features? There's a lot of cool stuff hidden in here.",
      "Try sending a voice message to a friend — VaultChat has cool voice effects!",
      "Have you tried the whiteboard feature? Great for quick doodles.",
      "Challenge yourself: How fast can you type your secret code? Go!",
    ];
    return suggestions[Math.floor(Math.random() * suggestions.length)];
  }

  // Help with VaultChat (from quick reply)
  if (/help.*(vault|chat|app)/i.test(lower)) {
    return (
      "I'd love to help! Here are some things I can assist with:\n\n" +
      "  How encryption works in VaultChat\n" +
      "  Setting up biometric security\n" +
      "  Using disappearing messages\n" +
      "  Managing group chats\n" +
      "  Exploring the secure vault\n" +
      "  Understanding privacy features\n\n" +
      "What would you like to know more about?"
    );
  }

  // Feelings / emotional
  if (/i('?m| am) (sad|depressed|upset|angry|anxious|stressed|worried|lonely)/i.test(lower)) {
    return "I'm sorry to hear that. Remember, it's okay to feel that way. If you need someone to talk to, I'm here. Sometimes just expressing how you feel helps. You're not alone.";
  }

  if (/i('?m| am) (happy|excited|great|amazing|wonderful|fantastic)/i.test(lower)) {
    return "That's wonderful to hear! Your positive energy is contagious. Keep that good vibe going!";
  }

  // Music
  if (/music|song|playlist|recommend.*song|what.*listen/i.test(lower)) {
    return "I can't play music since I'm a text-based AI, but I love talking about it! What kind of music do you enjoy? Maybe I can suggest something to search for.";
  }

  // Food
  if (/hungry|food|eat|restaurant|recipe|cook/i.test(lower)) {
    return "I can't cook for you, but I'm great company while you eat! What's your favorite cuisine? I'm a fan of well-structured data... I mean, well-structured meals.";
  }

  // Default fallback
  return FALLBACK_RESPONSES[Math.floor(Math.random() * FALLBACK_RESPONSES.length)];
}

// ── Typing Indicator Component ──────────────────────────────────────
function TypingIndicator() {
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
export default function AriaChatBot() {
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
      <StatusBar barStyle="light-content" backgroundColor={CLR.black} />

      <Animated.View style={[S.container, { opacity: fadeAnim }]}>
        {/* ── Header ─────────────────────────────────────────────── */}
        <View style={S.header}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={S.backButton}
            activeOpacity={0.7}
          >
            <Text style={S.backArrow}>{'<'}</Text>
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
                placeholderTextColor={CLR.silverDim}
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
              <Text
                style={[
                  S.sendIcon,
                  input.trim() ? S.sendIconActive : S.sendIconInactive,
                ]}
              >
                {'->'}
              </Text>
            </TouchableOpacity>
          </View>

          <View style={S.bottomSafe} />
        </KeyboardAvoidingView>
      </Animated.View>
    </>
  );
}

// ── Styles ──────────────────────────────────────────────────────────
const S = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: CLR.bg,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: Platform.OS === 'ios' ? 56 : 44,
    paddingBottom: 14,
    paddingHorizontal: 16,
    backgroundColor: CLR.black,
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  backArrow: {
    color: CLR.white,
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
    color: CLR.silverLight,
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
    color: CLR.white,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  onlineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: CLR.green,
  },
  headerSubtitle: {
    color: CLR.silverDim,
    fontSize: 12,
    fontWeight: '400',
    marginTop: 1,
  },
  clearBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: CLR.chipBorder,
  },
  clearTxt: {
    color: CLR.silver,
    fontSize: 12,
    fontWeight: '500',
  },
  headerDivider: {
    height: 1,
    backgroundColor: CLR.divider,
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
    color: CLR.silverLight,
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
    backgroundColor: CLR.userBubble,
    borderBottomRightRadius: 4,
  },
  bubbleAria: {
    backgroundColor: CLR.ariaBubble,
    borderWidth: 1,
    borderColor: CLR.ariaBubbleBorder,
    borderBottomLeftRadius: 4,
  },
  bubbleText: {
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '400',
  },
  bubbleTextUser: {
    color: CLR.white,
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
    backgroundColor: CLR.ariaBubble,
    borderWidth: 1,
    borderColor: CLR.ariaBubbleBorder,
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
    borderTopColor: CLR.divider,
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
    backgroundColor: CLR.chipBg,
    borderWidth: 1,
    borderColor: CLR.chipBorder,
  },
  quickChipText: {
    color: CLR.silver,
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
    borderTopColor: CLR.divider,
  },
  inputWrap: {
    flex: 1,
    backgroundColor: CLR.inputBg,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: CLR.inputBorder,
    paddingHorizontal: 18,
    paddingVertical: Platform.OS === 'ios' ? 10 : 4,
    maxHeight: 120,
  },
  input: {
    color: CLR.white,
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
    backgroundColor: CLR.white,
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
    color: CLR.black,
  },
  sendIconInactive: {
    color: 'rgba(255,255,255,0.2)',
  },

  bottomSafe: {
    height: Platform.OS === 'ios' ? 20 : 8,
  },
});
