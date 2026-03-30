// app/creator-channels.tsx
// Creator Economy Channels — create, discover, subscribe, analytics

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Modal,
  Alert,
  StyleSheet,
  StatusBar,
  Dimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { width } = Dimensions.get('window');
const STORAGE_KEY = 'vc_creator_channels';

// ── Types ──────────────────────────────────────────────────────
type Category = 'Tech' | 'News' | 'Education' | 'Entertainment' | 'Lifestyle';

interface Channel {
  id: string;
  name: string;
  description: string;
  category: Category;
  price: number;
  subscribers: number;
  revenue: number;
  growth: number;
  owner: 'me' | 'other';
  subscribed: boolean;
  icon: string;
}

const CATEGORIES: { key: Category; icon: string }[] = [
  { key: 'Tech', icon: '\uD83D\uDCBB' },
  { key: 'News', icon: '\uD83D\uDCF0' },
  { key: 'Education', icon: '\uD83C\uDF93' },
  { key: 'Entertainment', icon: '\uD83C\uDFAC' },
  { key: 'Lifestyle', icon: '\uD83C\uDF3F' },
];

const PRICE_OPTIONS = [0, 49, 99, 199, 499];

const CATEGORY_ICONS: Record<Category, string> = {
  Tech: '\uD83D\uDCBB',
  News: '\uD83D\uDCF0',
  Education: '\uD83C\uDF93',
  Entertainment: '\uD83C\uDFAC',
  Lifestyle: '\uD83C\uDF3F',
};

const CHANNEL_GRADIENTS: [string, string][] = [
  ['#4A9FFF', '#7C3AED'],
  ['#059669', '#10B981'],
  ['#DC2626', '#F97316'],
  ['#7C3AED', '#EC4899'],
  ['#0891B2', '#06B6D4'],
  ['#D97706', '#F59E0B'],
];

// ── Sample discover channels ──────────────────────────────────
const SAMPLE_CHANNELS: Channel[] = [
  {
    id: 's1',
    name: 'CryptoVault Daily',
    description: 'Daily crypto market analysis and security tips',
    category: 'Tech',
    price: 99,
    subscribers: 2340,
    revenue: 0,
    growth: 12.5,
    owner: 'other',
    subscribed: false,
    icon: '\uD83D\uDD10',
  },
  {
    id: 's2',
    name: 'Privacy First',
    description: 'News on digital privacy, surveillance and rights',
    category: 'News',
    price: 0,
    subscribers: 8920,
    revenue: 0,
    growth: 23.1,
    owner: 'other',
    subscribed: false,
    icon: '\uD83D\uDEE1\uFE0F',
  },
  {
    id: 's3',
    name: 'Code Academy Pro',
    description: 'Learn React Native, TypeScript, and system design',
    category: 'Education',
    price: 199,
    subscribers: 1560,
    revenue: 0,
    growth: 8.7,
    owner: 'other',
    subscribed: false,
    icon: '\uD83D\uDE80',
  },
  {
    id: 's4',
    name: 'Indie Films Hub',
    description: 'Curated independent films and reviews',
    category: 'Entertainment',
    price: 49,
    subscribers: 4210,
    revenue: 0,
    growth: 15.3,
    owner: 'other',
    subscribed: false,
    icon: '\uD83C\uDFAC',
  },
  {
    id: 's5',
    name: 'Mindful Living',
    description: 'Meditation, wellness, and minimalist lifestyle',
    category: 'Lifestyle',
    price: 0,
    subscribers: 6780,
    revenue: 0,
    growth: 31.2,
    owner: 'other',
    subscribed: false,
    icon: '\uD83E\uDDD8',
  },
  {
    id: 's6',
    name: 'Secure Dev Weekly',
    description: 'Weekly security-focused development tutorials',
    category: 'Tech',
    price: 499,
    subscribers: 890,
    revenue: 0,
    growth: 5.4,
    owner: 'other',
    subscribed: false,
    icon: '\uD83D\uDEE0\uFE0F',
  },
];

export default function CreatorChannelsScreen() {
  const router = useRouter();

  // Create channel state
  const [channelName, setChannelName] = useState('');
  const [channelDesc, setChannelDesc] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<Category>('Tech');
  const [selectedPrice, setSelectedPrice] = useState(0);

  // Channels data
  const [myChannels, setMyChannels] = useState<Channel[]>([]);
  const [discoverChannels, setDiscoverChannels] = useState<Channel[]>(SAMPLE_CHANNELS);

  // Category picker modal
  const [showCategoryPicker, setShowCategoryPicker] = useState(false);

  // Load saved channels
  useEffect(() => {
    loadChannels();
  }, []);

  const loadChannels = async () => {
    try {
      const stored = await AsyncStorage.getItem(STORAGE_KEY);
      if (stored) {
        setMyChannels(JSON.parse(stored));
      }
    } catch (e) {
    }
  };

  const saveChannels = async (channels: Channel[]) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(channels));
    } catch (e) {
    }
  };

  const handleCreateChannel = useCallback(() => {
    if (!channelName.trim()) {
      Alert.alert('Missing Name', 'Please enter a channel name.');
      return;
    }
    if (!channelDesc.trim()) {
      Alert.alert('Missing Description', 'Please enter a channel description.');
      return;
    }

    const newChannel: Channel = {
      id: `my_${Date.now()}`,
      name: channelName.trim(),
      description: channelDesc.trim(),
      category: selectedCategory,
      price: selectedPrice,
      subscribers: 0,
      revenue: 0,
      growth: 0,
      owner: 'me',
      subscribed: false,
      icon: CATEGORY_ICONS[selectedCategory],
    };

    const updated = [...myChannels, newChannel];
    setMyChannels(updated);
    saveChannels(updated);
    setChannelName('');
    setChannelDesc('');
    setSelectedCategory('Tech');
    setSelectedPrice(0);

    Alert.alert('Channel Created', `"${newChannel.name}" is now live!`);
  }, [channelName, channelDesc, selectedCategory, selectedPrice, myChannels]);

  const handleSubscribe = useCallback((channelId: string) => {
    setDiscoverChannels((prev) =>
      prev.map((ch) =>
        ch.id === channelId
          ? {
              ...ch,
              subscribed: !ch.subscribed,
              subscribers: ch.subscribed ? ch.subscribers - 1 : ch.subscribers + 1,
            }
          : ch
      )
    );
  }, []);

  const getGradient = (index: number): [string, string] => {
    return CHANNEL_GRADIENTS[index % CHANNEL_GRADIENTS.length];
  };

  const formatPrice = (price: number) => {
    return price === 0 ? 'Free' : `\u20B9${price}/mo`;
  };

  const formatCount = (n: number) => {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return n.toString();
  };

  // Analytics totals
  const totalSubscribers = myChannels.reduce((sum, ch) => sum + ch.subscribers, 0);
  const totalRevenue = myChannels.reduce((sum, ch) => sum + ch.revenue, 0);
  const avgGrowth =
    myChannels.length > 0
      ? myChannels.reduce((sum, ch) => sum + ch.growth, 0) / myChannels.length
      : 0;

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="light-content" backgroundColor="#FFFFFF" />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Header ──────────────────────────────────── */}
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Text style={styles.backArrow}>{'\u2190'}</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{'\u2B50'} Creator Channels</Text>
        </View>

        {/* ── Analytics Mini-View ─────────────────────── */}
        {myChannels.length > 0 && (
          <View style={styles.analyticsRow}>
            <LinearGradient
              colors={['#0D2847', '#F9FAFB']}
              style={styles.analyticsCard}
            >
              <Text style={styles.analyticsValue}>{formatCount(totalSubscribers)}</Text>
              <Text style={styles.analyticsLabel}>Subscribers</Text>
            </LinearGradient>
            <LinearGradient
              colors={['#0D2847', '#F9FAFB']}
              style={styles.analyticsCard}
            >
              <Text style={styles.analyticsValue}>{'\u20B9'}{totalRevenue.toLocaleString()}</Text>
              <Text style={styles.analyticsLabel}>Revenue</Text>
            </LinearGradient>
            <LinearGradient
              colors={['#0D2847', '#F9FAFB']}
              style={styles.analyticsCard}
            >
              <Text style={[styles.analyticsValue, { color: '#10B981' }]}>
                {avgGrowth > 0 ? '+' : ''}{avgGrowth.toFixed(1)}%
              </Text>
              <Text style={styles.analyticsLabel}>Growth</Text>
            </LinearGradient>
          </View>
        )}

        {/* ── Create Channel Section ──────────────────── */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{'\u2795'} Create Channel</Text>
        </View>

        <View style={styles.createCard}>
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Channel Name</Text>
            <TextInput
              style={styles.input}
              placeholder="My Awesome Channel"
              placeholderTextColor="#3A4A6B"
              value={channelName}
              onChangeText={setChannelName}
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Description</Text>
            <TextInput
              style={[styles.input, styles.descInput]}
              placeholder="What's your channel about?"
              placeholderTextColor="#3A4A6B"
              value={channelDesc}
              onChangeText={setChannelDesc}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />
          </View>

          {/* Category Picker */}
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Category</Text>
            <TouchableOpacity
              style={styles.pickerBtn}
              onPress={() => setShowCategoryPicker(true)}
              activeOpacity={0.7}
            >
              <Text style={styles.pickerBtnText}>
                {CATEGORY_ICONS[selectedCategory]} {selectedCategory}
              </Text>
              <Text style={styles.pickerArrow}>{'\u25BC'}</Text>
            </TouchableOpacity>
          </View>

          {/* Price Options */}
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Subscription Price</Text>
            <View style={styles.priceRow}>
              {PRICE_OPTIONS.map((price) => (
                <TouchableOpacity
                  key={price}
                  style={[
                    styles.priceChip,
                    selectedPrice === price && styles.priceChipActive,
                  ]}
                  onPress={() => setSelectedPrice(price)}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      styles.priceChipText,
                      selectedPrice === price && styles.priceChipTextActive,
                    ]}
                  >
                    {formatPrice(price)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <TouchableOpacity onPress={handleCreateChannel} activeOpacity={0.8}>
            <LinearGradient
              colors={['#4A9FFF', '#7C3AED']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.createBtn}
            >
              <Text style={styles.createBtnText}>{'\uD83D\uDE80'} Create Channel</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>

        {/* ── My Channels Section ─────────────────────── */}
        {myChannels.length > 0 && (
          <>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>{'\uD83D\uDCE2'} My Channels</Text>
              <View style={styles.countBadge}>
                <Text style={styles.countBadgeText}>{myChannels.length}</Text>
              </View>
            </View>

            {myChannels.map((channel, index) => (
              <View key={channel.id} style={styles.channelCard}>
                <View style={styles.channelHeader}>
                  <LinearGradient
                    colors={getGradient(index)}
                    style={styles.channelIcon}
                  >
                    <Text style={styles.channelIconText}>{channel.icon}</Text>
                  </LinearGradient>
                  <View style={styles.channelMeta}>
                    <Text style={styles.channelName} numberOfLines={1}>
                      {channel.name}
                    </Text>
                    <Text style={styles.channelCategory}>
                      {CATEGORY_ICONS[channel.category]} {channel.category}
                    </Text>
                  </View>
                  <View style={styles.priceBadge}>
                    <Text style={styles.priceBadgeText}>{formatPrice(channel.price)}</Text>
                  </View>
                </View>
                <Text style={styles.channelDesc} numberOfLines={2}>
                  {channel.description}
                </Text>
                <View style={styles.channelStats}>
                  <View style={styles.statItem}>
                    <Text style={styles.statValue}>{formatCount(channel.subscribers)}</Text>
                    <Text style={styles.statLabel}>Subscribers</Text>
                  </View>
                  <View style={styles.statDivider} />
                  <View style={styles.statItem}>
                    <Text style={styles.statValue}>{'\u20B9'}{channel.revenue.toLocaleString()}</Text>
                    <Text style={styles.statLabel}>Revenue</Text>
                  </View>
                  <View style={styles.statDivider} />
                  <View style={styles.statItem}>
                    <Text style={[styles.statValue, { color: '#10B981' }]}>
                      {channel.growth > 0 ? '+' : ''}{channel.growth.toFixed(1)}%
                    </Text>
                    <Text style={styles.statLabel}>Growth</Text>
                  </View>
                </View>
              </View>
            ))}
          </>
        )}

        {/* ── Discover Section ────────────────────────── */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{'\uD83D\uDD0D'} Discover Channels</Text>
        </View>

        <View style={styles.discoverGrid}>
          {discoverChannels.map((channel, index) => (
            <View key={channel.id} style={styles.discoverCard}>
              <LinearGradient
                colors={getGradient(index)}
                style={styles.discoverIcon}
              >
                <Text style={styles.discoverIconText}>{channel.icon}</Text>
              </LinearGradient>
              <Text style={styles.discoverName} numberOfLines={1}>
                {channel.name}
              </Text>
              <Text style={styles.discoverCategory}>
                {CATEGORY_ICONS[channel.category]} {channel.category}
              </Text>
              <Text style={styles.discoverSubs}>
                {formatCount(channel.subscribers)} subscribers
              </Text>
              <View style={styles.discoverPriceBadge}>
                <Text style={styles.discoverPriceText}>{formatPrice(channel.price)}</Text>
              </View>
              <TouchableOpacity
                onPress={() => handleSubscribe(channel.id)}
                activeOpacity={0.8}
              >
                <LinearGradient
                  colors={
                    channel.subscribed
                      ? ['#1A2A4A', '#1A2A4A']
                      : ['#4A9FFF', '#7C3AED']
                  }
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={styles.subscribeBtn}
                >
                  <Text style={styles.subscribeBtnText}>
                    {channel.subscribed ? 'Unsubscribe' : 'Subscribe'}
                  </Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          ))}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* ── Category Picker Modal ─────────────────────── */}
      <Modal
        visible={showCategoryPicker}
        transparent
        animationType="fade"
        onRequestClose={() => setShowCategoryPicker(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowCategoryPicker(false)}
        >
          <View style={styles.pickerModal}>
            <Text style={styles.pickerModalTitle}>Select Category</Text>
            {CATEGORIES.map((cat) => (
              <TouchableOpacity
                key={cat.key}
                style={[
                  styles.pickerOption,
                  selectedCategory === cat.key && styles.pickerOptionActive,
                ]}
                onPress={() => {
                  setSelectedCategory(cat.key);
                  setShowCategoryPicker(false);
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.pickerOptionIcon}>{cat.icon}</Text>
                <Text
                  style={[
                    styles.pickerOptionText,
                    selectedCategory === cat.key && styles.pickerOptionTextActive,
                  ]}
                >
                  {cat.key}
                </Text>
                {selectedCategory === cat.key && (
                  <Text style={styles.pickerCheck}>{'\u2713'}</Text>
                )}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────
const cardWidth = (width - 48) / 2;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 50,
  },

  // Header
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#0D1B3E',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  backArrow: {
    color: '#4A9FFF',
    fontSize: 20,
    fontWeight: '700',
  },
  headerTitle: {
    color: '#000000',
    fontSize: 22,
    fontWeight: '800',
    flex: 1,
  },

  // Analytics
  analyticsRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 20,
  },
  analyticsCard: {
    flex: 1,
    borderRadius: 14,
    padding: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1A2A4A',
  },
  analyticsValue: {
    color: '#4A9FFF',
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 4,
  },
  analyticsLabel: {
    color: '#5A6E8F',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  // Sections
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
    marginTop: 8,
  },
  sectionTitle: {
    color: '#000000',
    fontSize: 17,
    fontWeight: '700',
    flex: 1,
  },
  countBadge: {
    backgroundColor: '#4A9FFF',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
    minWidth: 22,
    alignItems: 'center',
  },
  countBadgeText: {
    color: '#000000',
    fontSize: 12,
    fontWeight: '700',
  },

  // Create card
  createCard: {
    backgroundColor: '#F9FAFB',
    borderRadius: 16,
    padding: 18,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: '#1A2A4A',
  },
  inputGroup: {
    marginBottom: 14,
  },
  inputLabel: {
    color: '#6B7FA3',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  input: {
    backgroundColor: '#0D1B3E',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#000000',
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#1A2A4A',
  },
  descInput: {
    minHeight: 70,
    paddingTop: 12,
  },
  pickerBtn: {
    backgroundColor: '#0D1B3E',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1A2A4A',
  },
  pickerBtnText: {
    color: '#000000',
    fontSize: 15,
  },
  pickerArrow: {
    color: '#5A6E8F',
    fontSize: 12,
  },

  // Price chips
  priceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  priceChip: {
    backgroundColor: '#0D1B3E',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: '#1A2A4A',
  },
  priceChipActive: {
    backgroundColor: '#4A9FFF22',
    borderColor: '#4A9FFF',
  },
  priceChipText: {
    color: '#5A6E8F',
    fontSize: 14,
    fontWeight: '600',
  },
  priceChipTextActive: {
    color: '#4A9FFF',
  },
  createBtn: {
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 4,
  },
  createBtnText: {
    color: '#000000',
    fontSize: 16,
    fontWeight: '700',
  },

  // Channel cards (My Channels)
  channelCard: {
    backgroundColor: '#F9FAFB',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#1A2A4A',
  },
  channelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  channelIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  channelIconText: {
    fontSize: 20,
  },
  channelMeta: {
    flex: 1,
  },
  channelName: {
    color: '#000000',
    fontSize: 16,
    fontWeight: '700',
  },
  channelCategory: {
    color: '#5A6E8F',
    fontSize: 12,
    marginTop: 2,
  },
  priceBadge: {
    backgroundColor: '#7C3AED22',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#7C3AED44',
  },
  priceBadgeText: {
    color: '#7C3AED',
    fontSize: 12,
    fontWeight: '700',
  },
  channelDesc: {
    color: '#8899BB',
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 12,
  },
  channelStats: {
    flexDirection: 'row',
    backgroundColor: '#0D1B3E',
    borderRadius: 12,
    padding: 12,
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
  },
  statValue: {
    color: '#4A9FFF',
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 2,
  },
  statLabel: {
    color: '#5A6E8F',
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  statDivider: {
    width: 1,
    backgroundColor: '#1A2A4A',
    marginVertical: 2,
  },

  // Discover grid
  discoverGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  discoverCard: {
    width: cardWidth,
    backgroundColor: '#F9FAFB',
    borderRadius: 16,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#1A2A4A',
    alignItems: 'center',
  },
  discoverIcon: {
    width: 50,
    height: 50,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 10,
  },
  discoverIconText: {
    fontSize: 22,
  },
  discoverName: {
    color: '#000000',
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 4,
  },
  discoverCategory: {
    color: '#5A6E8F',
    fontSize: 11,
    marginBottom: 4,
  },
  discoverSubs: {
    color: '#6B7FA3',
    fontSize: 11,
    marginBottom: 8,
  },
  discoverPriceBadge: {
    backgroundColor: '#7C3AED22',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#7C3AED44',
  },
  discoverPriceText: {
    color: '#7C3AED',
    fontSize: 11,
    fontWeight: '700',
  },
  subscribeBtn: {
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 20,
    alignItems: 'center',
    width: '100%',
  },
  subscribeBtnText: {
    color: '#000000',
    fontSize: 13,
    fontWeight: '700',
  },

  // Category picker modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pickerModal: {
    backgroundColor: '#F9FAFB',
    borderRadius: 20,
    padding: 20,
    width: width - 60,
    borderWidth: 1,
    borderColor: '#1A2A4A',
  },
  pickerModalTitle: {
    color: '#000000',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 16,
    textAlign: 'center',
  },
  pickerOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    paddingHorizontal: 14,
    borderRadius: 12,
    marginBottom: 6,
  },
  pickerOptionActive: {
    backgroundColor: '#4A9FFF15',
  },
  pickerOptionIcon: {
    fontSize: 20,
    marginRight: 12,
  },
  pickerOptionText: {
    color: '#8899BB',
    fontSize: 16,
    fontWeight: '600',
    flex: 1,
  },
  pickerOptionTextActive: {
    color: '#4A9FFF',
  },
  pickerCheck: {
    color: '#4A9FFF',
    fontSize: 18,
    fontWeight: '700',
  },
});
