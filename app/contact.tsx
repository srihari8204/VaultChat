import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState , useMemo} from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function ContactScreen() {
  const { colors } = useTheme();
  const styles = useS();
  const router = useRouter();
  const { name, avatar } = useLocalSearchParams();
  const [isMuted, setIsMuted] = useState(false);
  const [isBlocked, setIsBlocked] = useState(false);

  const trustScore = 87;
  const trustColor = trustScore >= 80 ? colors.primary : trustScore >= 60 ? '#F59E0B' : colors.danger;

  return (
    <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backText}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Contact Info</Text>
        <TouchableOpacity style={styles.editBtn}>
          <Text style={styles.editText}>Edit</Text>
        </TouchableOpacity>
      </View>

      {/* Profile Card */}
      <View style={styles.profileCard}>
        {/* Big Avatar */}
        <View style={styles.bigAvatar}>
          <Text style={styles.bigAvatarEmoji}>{avatar || '👤'}</Text>
          <View style={styles.onlineBadge}>
            <Text style={styles.onlineBadgeText}>● Online</Text>
          </View>
        </View>

        <Text style={styles.contactName}>{name || 'Contact'}</Text>
        <Text style={styles.contactPhone}>+91 98765 43210</Text>
        <Text style={styles.contactStatus}>
          &quot;Privacy is not a luxury — it&apos;s a right 🛡️&quot;
        </Text>

        {/* Action Buttons Row */}
        <View style={styles.actionRow}>
          {[
            { icon: '💬', label: 'Message' },
            { icon: '📞', label: 'Voice' },
            { icon: '🎥', label: 'Video' },
            { icon: '🔍', label: 'Search' },
          ].map((btn, i) => (
            <TouchableOpacity
              key={i}
              style={styles.actionBtn}
              onPress={() => {
                if (btn.label === 'Voice') router.push({ pathname: '/voicecall' as any, params: { name, avatar } });
                if (btn.label === 'Video') router.push({ pathname: '/videocall' as any, params: { name, avatar } });
                if (btn.label === 'Message') router.push({ pathname: '/chat' as any, params: { name, avatar } });
              }}
            >
              <Text style={styles.actionIcon}>{btn.icon}</Text>
              <Text style={styles.actionLabel}>{btn.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* TrustScore */}
      <View style={styles.section}>
        <View style={styles.trustCard}>
          <View style={styles.trustLeft}>
            <Text style={styles.trustTitle}>🌡️ TrustScore</Text>
            <Text style={styles.trustDesc}>
              Based on account age, verification, and mutual contacts
            </Text>
          </View>
          <View style={styles.trustScoreCircle}>
            <Text style={[styles.trustScoreNum, { color: trustColor }]}>{trustScore}</Text>
            <Text style={styles.trustScoreMax}>/100</Text>
          </View>
        </View>

        {/* Score breakdown */}
        {[
          { label: 'VaultID Verified', score: 30, max: 30, color: colors.primary },
          { label: 'Account Age', score: 18, max: 20, color: colors.accent },
          { label: 'Mutual Contacts', score: 20, max: 20, color: colors.purple },
          { label: 'No Incidents', score: 19, max: 30, color: '#F59E0B' },
        ].map((item, i) => (
          <View key={i} style={styles.scoreRow}>
            <Text style={styles.scoreLabel}>{item.label}</Text>
            <View style={styles.scoreBar}>
              <View style={[styles.scoreBarFill, {
                width: `${(item.score / item.max) * 100}%`,
                backgroundColor: item.color
              }]} />
            </View>
            <Text style={[styles.scoreNum, { color: item.color }]}>
              {item.score}/{item.max}
            </Text>
          </View>
        ))}
      </View>

      {/* VaultID Info */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>⛓️ VaultID</Text>
        <View style={styles.vaultIdCard}>
          <Text style={styles.vaultIdLabel}>Blockchain Identity</Text>
          <Text style={styles.vaultIdValue}>vault:0x8f3a...2d9c</Text>
          <View style={styles.verifiedBadge}>
            <Text style={styles.verifiedText}>✅ VERIFIED ON BLOCKCHAIN</Text>
          </View>
        </View>
      </View>

      {/* Media Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>📸 Shared Media</Text>
        <View style={styles.mediaGrid}>
          {['🖼️','📄','🎵','🎥','🖼️','📄'].map((icon, i) => (
            <View key={i} style={styles.mediaItem}>
              <Text style={styles.mediaIcon}>{icon}</Text>
            </View>
          ))}
        </View>
        <TouchableOpacity style={styles.viewAllBtn}>
          <Text style={styles.viewAllText}>View All Media →</Text>
        </TouchableOpacity>
      </View>

      {/* Security Settings */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>🔒 Privacy & Security</Text>

        {[
          {
            icon: '⏱️', label: 'HideTimer',
            value: '30 minutes', color: colors.accent,
            onPress: () => Alert.alert('HideTimer', 'Chat blurs after 30 min of inactivity')
          },
          {
            icon: '🔕', label: 'Mute Notifications',
            value: isMuted ? 'Muted' : 'On', color: isMuted ? colors.danger : colors.primary,
            onPress: () => setIsMuted(!isMuted)
          },
          {
            icon: '🚫', label: 'Block Contact',
            value: isBlocked ? 'Blocked' : 'Not blocked', color: isBlocked ? colors.danger : '#475569',
            onPress: () => {
              Alert.alert(
                isBlocked ? 'Unblock?' : 'Block Contact?',
                isBlocked ? `Unblock ${name}?` : `Block ${name}? They won't be able to message you.`,
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: isBlocked ? 'Unblock' : 'Block', onPress: () => setIsBlocked(!isBlocked) }
                ]
              );
            }
          },
        ].map((item, i) => (
          <TouchableOpacity key={i} style={styles.settingRow} onPress={item.onPress}>
            <Text style={styles.settingIcon}>{item.icon}</Text>
            <Text style={styles.settingLabel}>{item.label}</Text>
            <Text style={[styles.settingValue, { color: item.color }]}>{item.value}</Text>
            <Text style={styles.settingArrow}>›</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Danger Zone */}
      <View style={[styles.section, { marginBottom: 40 }]}>
        <TouchableOpacity
          style={styles.dangerBtn}
          onPress={() => Alert.alert('Delete Chat?', 'This will delete all messages. Cannot be undone.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: () => router.back() }
          ])}
        >
          <Text style={styles.dangerText}>🗑️ Delete Chat</Text>
        </TouchableOpacity>
      </View>

    </ScrollView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 55,
    paddingBottom: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  backBtn: { padding: 4 },
  backText: { color: c.accent, fontSize: 24, fontWeight: 'bold' },
  headerTitle: { color: '#000000', fontSize: 17, fontWeight: 'bold' },
  editBtn: { padding: 4 },
  editText: { color: c.accent, fontSize: 15 },
  profileCard: {
    alignItems: 'center',
    paddingVertical: 32,
    paddingHorizontal: 24,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  bigAvatar: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#ffffff',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 3,
    borderColor: c.accent,
    marginBottom: 8,
  },
  bigAvatarEmoji: { fontSize: 56 },
  onlineBadge: {
    position: 'absolute',
    bottom: 4,
    backgroundColor: '#052e16',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  onlineBadgeText: { color: c.primary, fontSize: 10, fontWeight: 'bold' },
  contactName: {
    color: '#000000', fontSize: 24, fontWeight: 'bold', marginTop: 8
  },
  contactPhone: { color: c.textDim, fontSize: 14, marginTop: 4 },
  contactStatus: {
    color: c.textDim, fontSize: 13, marginTop: 8,
    textAlign: 'center', fontStyle: 'italic'
  },
  actionRow: {
    flexDirection: 'row',
    marginTop: 24,
    gap: 16,
  },
  actionBtn: {
    alignItems: 'center',
    backgroundColor: c.bg,
    borderRadius: 16,
    padding: 16,
    minWidth: 68,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  actionIcon: { fontSize: 24, marginBottom: 6 },
  actionLabel: { color: c.textDim, fontSize: 12 },
  section: {
    marginHorizontal: 16,
    marginTop: 20,
  },
  sectionTitle: {
    color: c.textDim, fontSize: 13,
    fontWeight: '600', marginBottom: 12,
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  trustCard: {
    flexDirection: 'row',
    backgroundColor: c.bg,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    marginBottom: 12,
    alignItems: 'center',
  },
  trustLeft: { flex: 1 },
  trustTitle: { color: '#000000', fontSize: 16, fontWeight: 'bold' },
  trustDesc: { color: '#475569', fontSize: 12, marginTop: 4, lineHeight: 16 },
  trustScoreCircle: {
    alignItems: 'center',
    backgroundColor: c.bg,
    borderRadius: 40,
    width: 70,
    height: 70,
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: c.primary,
  },
  trustScoreNum: { fontSize: 24, fontWeight: 'bold' },
  trustScoreMax: { color: '#475569', fontSize: 10 },
  scoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 8,
  },
  scoreLabel: { color: c.textDim, fontSize: 12, width: 120 },
  scoreBar: {
    flex: 1, height: 6,
    backgroundColor: '#E5E7EB',
    borderRadius: 3,
    overflow: 'hidden',
  },
  scoreBarFill: { height: '100%', borderRadius: 3 },
  scoreNum: { fontSize: 11, width: 32, textAlign: 'right' },
  vaultIdCard: {
    backgroundColor: c.bg,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  vaultIdLabel: { color: c.textDim, fontSize: 12 },
  vaultIdValue: {
    color: c.accent, fontSize: 14,
    fontFamily: 'monospace', marginTop: 4,
  },
  verifiedBadge: {
    backgroundColor: '#052e16',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignSelf: 'flex-start',
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#166534',
  },
  verifiedText: { color: c.primary, fontSize: 10, fontWeight: 'bold' },
  mediaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  mediaItem: {
    width: 80, height: 80,
    backgroundColor: c.bg,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  mediaIcon: { fontSize: 32 },
  viewAllBtn: { alignItems: 'center', paddingVertical: 8 },
  viewAllText: { color: c.accent, fontSize: 14 },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.bg,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  settingIcon: { fontSize: 20, marginRight: 12 },
  settingLabel: { color: '#000000', fontSize: 15, flex: 1 },
  settingValue: { fontSize: 13, marginRight: 8 },
  settingArrow: { color: '#475569', fontSize: 18 },
  dangerBtn: {
    backgroundColor: c.bg,
    borderRadius: 14,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#7F1D1D',
  },
  dangerText: { color: c.danger, fontSize: 15, fontWeight: '600' },
});
