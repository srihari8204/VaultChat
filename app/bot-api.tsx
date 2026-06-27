// app/bot-api.tsx
// Bot & Automation API platform — built-in bots + custom bot creation

import { BRAND_ACCENT } from '../constants/theme';
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

// ── Built-in bots ────────────────────────────────────────────────
const BUILT_IN_BOTS = [
  {
    id: 'reminder',
    icon: '⏰',
    name: 'Reminder Bot',
    description: 'Set timed reminders in any chat. Just say "remind me in 10 min to call back".',
    gradient: ['#4A9FFF', '#1D4ED8'] as [string, string],
  },
  {
    id: 'weather',
    icon: '🌤️',
    name: 'Weather Bot',
    description: 'Get real-time weather forecasts. Type "/weather London" for instant updates.',
    gradient: ['#06B6D4', '#0891B2'] as [string, string],
  },
  {
    id: 'news',
    icon: '📰',
    name: 'News Bot',
    description: 'Curated headlines delivered to your chat. Filter by topic or region.',
    gradient: [BRAND_ACCENT, '#DC2626'] as [string, string],
  },
  {
    id: 'poll',
    icon: '📊',
    name: 'Poll Bot',
    description: 'Create instant polls in group chats. Supports multiple choice and anonymous voting.',
    gradient: ['#7C3AED', '#EC4899'] as [string, string],
  },
  {
    id: 'translate',
    icon: '🌐',
    name: 'Translate Bot',
    description: 'Auto-translate messages in 50+ languages. Set per-chat language preferences.',
    gradient: [BRAND_ACCENT, '#059669'] as [string, string],
  },
];

const STORAGE_KEY = 'vc_custom_bots';

interface CustomBot {
  id: string;
  name: string;
  webhookUrl: string;
  description: string;
  createdAt: number;
}

export default function BotApiScreen() {
  const router = useRouter();
  const [customBots, setCustomBots] = useState<CustomBot[]>([]);
  const [botName, setBotName] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [botDescription, setBotDescription] = useState('');
  const [activeBots, setActiveBots] = useState<string[]>([]);
  const [showDocs, setShowDocs] = useState(false);

  useEffect(() => {
    loadCustomBots();
  }, []);

  const loadCustomBots = async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) setCustomBots(JSON.parse(raw));
    } catch {}
  };

  const saveCustomBots = async (bots: CustomBot[]) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(bots));
      setCustomBots(bots);
    } catch {}
  };

  const handleCreateBot = () => {
    if (!botName.trim()) {
      Alert.alert('Missing name', 'Please enter a bot name.');
      return;
    }
    if (!webhookUrl.trim()) {
      Alert.alert('Missing URL', 'Please enter a webhook URL.');
      return;
    }
    const newBot: CustomBot = {
      id: Date.now().toString(),
      name: botName.trim(),
      webhookUrl: webhookUrl.trim(),
      description: botDescription.trim() || 'Custom bot',
      createdAt: Date.now(),
    };
    const updated = [...customBots, newBot];
    saveCustomBots(updated);
    setBotName('');
    setWebhookUrl('');
    setBotDescription('');
    Alert.alert('Bot Created', `"${newBot.name}" has been registered.`);
  };

  const handleDeleteBot = (id: string) => {
    Alert.alert('Delete Bot', 'Remove this custom bot?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          const updated = customBots.filter(b => b.id !== id);
          saveCustomBots(updated);
        },
      },
    ]);
  };

  const toggleAddToChat = (botId: string) => {
    setActiveBots(prev =>
      prev.includes(botId) ? prev.filter(b => b !== botId) : [...prev, botId]
    );
  };

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* ── Header ────────────────────────────────── */}
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={20} color="#fff" />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>🤖 Bot Platform</Text>
            <Text style={styles.headerSub}>Automate your chats with powerful bots</Text>
          </View>
        </View>

        {/* ── Built-in Bots ─────────────────────────── */}
        <Text style={styles.sectionTitle}>Built-in Bots</Text>
        {BUILT_IN_BOTS.map(bot => (
          <LinearGradient
            key={bot.id}
            colors={['#F9FAFB', '#0F1D32']}
            style={styles.botCard}
          >
            <LinearGradient colors={bot.gradient} style={styles.botIcon}>
              <Text style={styles.botEmoji}>{bot.icon}</Text>
            </LinearGradient>
            <View style={styles.botInfo}>
              <Text style={styles.botName}>{bot.name}</Text>
              <Text style={styles.botDesc}>{bot.description}</Text>
            </View>
            <TouchableOpacity
              style={[
                styles.addBtn,
                activeBots.includes(bot.id) && styles.addBtnActive,
              ]}
              onPress={() => toggleAddToChat(bot.id)}
            >
              <Text
                style={[
                  styles.addBtnText,
                  activeBots.includes(bot.id) && styles.addBtnTextActive,
                ]}
              >
                {activeBots.includes(bot.id) ? 'Added ✓' : 'Add to Chat'}
              </Text>
            </TouchableOpacity>
          </LinearGradient>
        ))}

        {/* ── Create Custom Bot ─────────────────────── */}
        <Text style={[styles.sectionTitle, { marginTop: 28 }]}>Create Custom Bot</Text>
        <View style={styles.formCard}>
          <Text style={styles.inputLabel}>Bot Name</Text>
          <TextInput
            style={styles.input}
            placeholder="My Awesome Bot"
            placeholderTextColor="#4A5568"
            value={botName}
            onChangeText={setBotName}
          />
          <Text style={styles.inputLabel}>Webhook URL</Text>
          <TextInput
            style={styles.input}
            placeholder="https://your-server.com/webhook"
            placeholderTextColor="#4A5568"
            value={webhookUrl}
            onChangeText={setWebhookUrl}
            autoCapitalize="none"
            keyboardType="url"
          />
          <Text style={styles.inputLabel}>Description</Text>
          <TextInput
            style={[styles.input, { height: 72 }]}
            placeholder="What does this bot do?"
            placeholderTextColor="#4A5568"
            value={botDescription}
            onChangeText={setBotDescription}
            multiline
          />
          <TouchableOpacity style={styles.createBtn} onPress={handleCreateBot}>
            <LinearGradient
              colors={['#4A9FFF', '#7C3AED']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.createBtnGrad}
            >
              <Text style={styles.createBtnText}>+ Create Bot</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>

        {/* ── User-Created Bots ─────────────────────── */}
        {customBots.length > 0 && (
          <>
            <Text style={[styles.sectionTitle, { marginTop: 28 }]}>Your Bots</Text>
            {customBots.map(bot => (
              <View key={bot.id} style={styles.customBotCard}>
                <View style={styles.customBotIcon}>
                  <Text style={{ fontSize: 22 }}>🔧</Text>
                </View>
                <View style={styles.botInfo}>
                  <Text style={styles.botName}>{bot.name}</Text>
                  <Text style={styles.botDesc} numberOfLines={1}>{bot.description}</Text>
                  <Text style={styles.webhookText} numberOfLines={1}>{bot.webhookUrl}</Text>
                </View>
                <TouchableOpacity
                  style={styles.deleteBtn}
                  onPress={() => handleDeleteBot(bot.id)}
                >
                  <Ionicons name="trash-outline" size={18} color="#DC2626" />
                </TouchableOpacity>
              </View>
            ))}
          </>
        )}

        {/* ── API Documentation ─────────────────────── */}
        <Text style={[styles.sectionTitle, { marginTop: 28 }]}>API Documentation</Text>
        <TouchableOpacity
          style={styles.docsToggle}
          onPress={() => setShowDocs(!showDocs)}
        >
          <Ionicons name={showDocs ? 'chevron-down' : 'chevron-forward'} size={14} color="#4A9FFF" style={{ marginRight: 6 }} />
          <Text style={styles.docsToggleText}>
            Webhook Format & Integration Guide
          </Text>
        </TouchableOpacity>
        {showDocs && (
          <View style={styles.docsCard}>
            <Text style={styles.docsTitle}>Incoming Webhook Format</Text>
            <Text style={styles.docsText}>
              VaultChat sends a POST request to your webhook URL when triggered:
            </Text>
            <View style={styles.codeBlock}>
              <Text style={styles.codeText}>{`POST /webhook HTTP/1.1
Content-Type: application/json

{
  "event": "message",
  "chat_id": "abc123",
  "sender": {
    "uid": "user_xyz",
    "name": "Alice"
  },
  "message": {
    "text": "/mybot hello",
    "timestamp": 1700000000
  }
}`}</Text>
            </View>
            <Text style={[styles.docsTitle, { marginTop: 16 }]}>Response Format</Text>
            <Text style={styles.docsText}>
              Your bot should respond with:
            </Text>
            <View style={styles.codeBlock}>
              <Text style={styles.codeText}>{`{
  "reply": "Hello! I'm your bot.",
  "actions": [
    {
      "type": "button",
      "label": "Learn More",
      "url": "https://..."
    }
  ]
}`}</Text>
            </View>
            <Text style={[styles.docsTitle, { marginTop: 16 }]}>Rate Limits</Text>
            <Text style={styles.docsText}>
              • 100 requests/minute per bot{'\n'}
              • 10,000 requests/day per bot{'\n'}
              • Max payload size: 1 MB{'\n'}
              • Webhook timeout: 10 seconds
            </Text>
          </View>
        )}

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
  botCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#1A2744',
  },
  botIcon: {
    width: 48,
    height: 48,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  botEmoji: {
    fontSize: 24,
  },
  botInfo: {
    flex: 1,
    marginLeft: 12,
    marginRight: 8,
  },
  botName: {
    color: '#000000',
    fontSize: 15,
    fontWeight: '600',
  },
  botDesc: {
    color: '#8899AA',
    fontSize: 12,
    marginTop: 3,
    lineHeight: 17,
  },
  addBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#4A9FFF',
  },
  addBtnActive: {
    backgroundColor: '#4A9FFF',
    borderColor: '#4A9FFF',
  },
  addBtnText: {
    color: '#4A9FFF',
    fontSize: 12,
    fontWeight: '600',
  },
  addBtnTextActive: {
    color: '#000000',
  },
  formCard: {
    backgroundColor: '#F9FAFB',
    borderRadius: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: '#1A2744',
  },
  inputLabel: {
    color: '#8899AA',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 6,
    marginTop: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  input: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#1A2744',
    color: '#000000',
    fontSize: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  createBtn: {
    marginTop: 18,
    borderRadius: 12,
    overflow: 'hidden',
  },
  createBtnGrad: {
    paddingVertical: 14,
    alignItems: 'center',
    borderRadius: 12,
  },
  createBtnText: {
    color: '#000000',
    fontSize: 15,
    fontWeight: '700',
  },
  customBotCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#1A2744',
  },
  customBotIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: '#1A2744',
    justifyContent: 'center',
    alignItems: 'center',
  },
  webhookText: {
    color: '#4A9FFF',
    fontSize: 11,
    marginTop: 2,
  },
  deleteBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(220,38,38,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  deleteBtnText: {
    fontSize: 16,
  },
  docsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: '#1A2744',
  },
  docsToggleText: {
    color: '#4A9FFF',
    fontSize: 14,
    fontWeight: '600',
  },
  docsCard: {
    backgroundColor: '#F9FAFB',
    borderRadius: 14,
    padding: 18,
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#1A2744',
  },
  docsTitle: {
    color: '#000000',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 6,
  },
  docsText: {
    color: '#8899AA',
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 10,
  },
  codeBlock: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: '#1A2744',
  },
  codeText: {
    color: '#4ADE80',
    fontSize: 12,
    fontFamily: 'monospace',
    lineHeight: 18,
  },
});
