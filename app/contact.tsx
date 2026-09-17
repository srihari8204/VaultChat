import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState, useMemo } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View
} from 'react-native';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';
import { HEADER_TOP } from '../constants/layout';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function ContactScreen() {
  const { colors } = useTheme();
  const styles = useS();
  const router = useRouter();
  // chatId matters: app/chat-export.tsx keys its lock check off it, and without
  // one the export screen cannot tell a locked chat from an unlocked one.
  const { name, avatar, chatId, id } = useLocalSearchParams();
  const [isMuted, setIsMuted] = useState(false);
  const [isBlocked, setIsBlocked] = useState(false);

  const contactName = (name as string) || 'Contact';

  const actions: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }[] = [
    { icon: 'chatbubble', label: 'Message', onPress: () => router.push({ pathname: '/chat' as any, params: { name, avatar } }) },
    { icon: 'call', label: 'Audio', onPress: () => router.push({ pathname: '/voicecall' as any, params: { name, avatar } }) },
    { icon: 'videocam', label: 'Video', onPress: () => router.push({ pathname: '/videocall' as any, params: { name, avatar } }) },
  ];

  return (
    <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Contact info</Text>
        {/* The edit pencil that sat here had NO onPress: tapping it did nothing,
            on any platform. Labelling a no-op for a screen reader would announce
            an action that does not exist, which is worse than saying nothing, so
            the dead affordance is removed rather than described. Nothing here
            routed to an edit screen; if one is added, its button goes here. */}
      </View>

      {/* Profile */}
      <View style={styles.profileCard}>
        <View style={styles.bigAvatar}>
          <Text style={styles.bigAvatarEmoji}>{(avatar as string) || '👤'}</Text>
        </View>
        <Text style={styles.contactName}>{contactName}</Text>
        <Text style={styles.contactPhone}>+91 98765 43210</Text>

        {/* Action Buttons Row */}
        <View style={styles.actionRow}>
          {actions.map((btn) => (
            <TouchableOpacity key={btn.label} style={styles.actionBtn} onPress={btn.onPress} activeOpacity={0.8}>
              <Ionicons name={btn.icon} size={22} color={colors.primary} />
              <Text style={styles.actionLabel}>{btn.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* About / status */}
      <View style={styles.block}>
        <Text style={styles.aboutText}>Privacy is not a luxury — it&apos;s a right</Text>
      </View>

      {/* Media */}
      <View style={styles.block}>
        <TouchableOpacity style={styles.rowBetween}>
          <Text style={styles.rowLabel}>Media, links and docs</Text>
          <View style={styles.rowRight}>
            <Text style={styles.rowCount}>6</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
          </View>
        </TouchableOpacity>
        <View style={styles.mediaGrid}>
          {['🖼️', '📄', '🎵', '🎥', '🖼️', '📄'].map((icon, i) => (
            <View key={i} style={styles.mediaItem}>
              <Text style={styles.mediaIcon}>{icon}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* Privacy & settings */}
      <View style={styles.block}>
        <View style={styles.settingRow}>
          <Ionicons name="notifications-off-outline" size={22} color={colors.text} />
          <Text style={styles.settingLabel}>Mute notifications</Text>
          <Switch
            value={isMuted}
            onValueChange={setIsMuted}
            trackColor={{ true: colors.primary, false: colors.border }}
            thumbColor="#fff"
          />
        </View>

        <TouchableOpacity
          style={styles.settingRow}
          onPress={() => Alert.alert('Disappearing messages', 'New messages will disappear from this chat after the selected duration.')}
        >
          <Ionicons name="timer-outline" size={22} color={colors.text} />
          <Text style={styles.settingLabel}>Disappearing messages</Text>
          <Text style={styles.settingValue}>Off</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.settingRow}
          onPress={() => router.push({ pathname: '/chat-export' as any, params: { peerName: contactName, chatId: String(chatId ?? id ?? '') } })}
        >
          <Ionicons name="share-outline" size={22} color={colors.text} />
          <Text style={styles.settingLabel}>Export chat</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
        </TouchableOpacity>
      </View>

      {/* Block / report / delete */}
      <View style={[styles.block, { marginBottom: 40 }]}>
        <TouchableOpacity
          style={styles.dangerRow}
          onPress={() => {
            Alert.alert(
              isBlocked ? 'Unblock?' : 'Block Contact?',
              isBlocked ? `Unblock ${contactName}?` : `Block ${contactName}? They won't be able to message or call you.`,
              [
                { text: 'Cancel', style: 'cancel' },
                { text: isBlocked ? 'Unblock' : 'Block', style: isBlocked ? 'default' : 'destructive', onPress: () => setIsBlocked(!isBlocked) }
              ]
            );
          }}
        >
          <Ionicons name="ban-outline" size={22} color={colors.danger} />
          <Text style={styles.dangerLabel}>{isBlocked ? `Unblock ${contactName}` : `Block ${contactName}`}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.dangerRow}
          onPress={() => Alert.alert('Report contact?', `The last 5 messages from ${contactName} will be forwarded to crazzychat.`, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Report', style: 'destructive' }
          ])}
        >
          <Ionicons name="thumbs-down-outline" size={22} color={colors.danger} />
          <Text style={styles.dangerLabel}>Report {contactName}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.dangerRow}
          onPress={() => Alert.alert('Delete chat?', 'This will delete all messages. This cannot be undone.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: () => router.back() }
          ])}
        >
          <Ionicons name="trash-outline" size={22} color={colors.danger} />
          <Text style={styles.dangerLabel}>Delete chat</Text>
        </TouchableOpacity>
      </View>

    </ScrollView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: HEADER_TOP,
    paddingBottom: 12,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.glassStroke,
  },
  backBtn: { padding: 4 },
  headerTitle: { color: c.text, fontSize: 17, fontWeight: '700' },
  editBtn: { padding: 4 },
  profileCard: {
    alignItems: 'center',
    paddingVertical: 28,
    paddingHorizontal: 24,
    backgroundColor: c.glassSoft,
  },
  bigAvatar: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: c.glassSoft,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  bigAvatarEmoji: { fontSize: 56 },
  contactName: { color: c.text, fontSize: 24, fontWeight: '700', marginTop: 8 },
  contactPhone: { color: c.textDim, fontSize: 14, marginTop: 4 },
  actionRow: {
    flexDirection: 'row',
    marginTop: 24,
    gap: 16,
  },
  actionBtn: {
    alignItems: 'center',
    backgroundColor: c.glassSoft,
    borderRadius: 16,
    paddingVertical: 14,
    minWidth: 84,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.glassStroke,
    gap: 6,
  },
  actionLabel: { color: c.primary, fontSize: 13, fontWeight: '600' },
  block: {
    marginTop: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: c.glassSoft,
  },
  aboutText: { color: c.text, fontSize: 15, lineHeight: 21 },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  rowLabel: { color: c.text, fontSize: 15 },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  rowCount: { color: c.textDim, fontSize: 14 },
  mediaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  mediaItem: {
    width: 80, height: 80,
    backgroundColor: c.glassSoft,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.glassStroke,
  },
  mediaIcon: { fontSize: 32 },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    gap: 16,
  },
  settingLabel: { color: c.text, fontSize: 15, flex: 1 },
  settingValue: { color: c.textDim, fontSize: 14, marginRight: 4 },
  dangerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    gap: 16,
  },
  dangerLabel: { color: c.danger, fontSize: 15, fontWeight: '500' },
});
