import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import {
    Alert,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View
} from 'react-native';

export default function ContactScreen() {
  const router = useRouter();
  const { name, avatar } = useLocalSearchParams();
  const [isMuted, setIsMuted] = useState(false);
  const [isBlocked, setIsBlocked] = useState(false);

  const trustScore = 87;
  const trustColor = trustScore >= 80 ? '#22C55E' : trustScore >= 60 ? '#F59E0B' : '#EF4444';

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
          { label: 'VaultID Verified', score: 30, max: 30, color: '#22C55E' },
          { label: 'Account Age', score: 18, max: 20, color: '#3B82F6' },
          { label: 'Mutual Contacts', score: 20, max: 20, color: '#8B5CF6' },
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
            value: '30 minutes', color: '#3B82F6',
            onPress: () => Alert.alert('HideTimer', 'Chat blurs after 30 min of inactivity')
          },
          {
            icon: '🔕', label: 'Mute Notifications',
            value: isMuted ? 'Muted' : 'On', color: isMuted ? '#EF4444' : '#22C55E',
            onPress: () => setIsMuted(!isMuted)
          },
          {
            icon: '🚫', label: 'Block Contact',
            value: isBlocked ? 'Blocked' : 'Not blocked', color: isBlocked ? '#EF4444' : '#475569',
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#050D1F' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 55,
    paddingBottom: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#0F1729',
  },
  backBtn: { padding: 4 },
  backText: { color: '#1D4ED8', fontSize: 24, fontWeight: 'bold' },
  headerTitle: { color: '#000000', fontSize: 17, fontWeight: 'bold' },
  editBtn: { padding: 4 },
  editText: { color: '#1D4ED8', fontSize: 15 },
  profileCard: {
    alignItems: 'center',
    paddingVertical: 32,
    paddingHorizontal: 24,
    borderBottomWidth: 1,
    borderBottomColor: '#0F1729',
  },
  bigAvatar: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#0F1729',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 3,
    borderColor: '#1D4ED8',
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
  onlineBadgeText: { color: '#22C55E', fontSize: 10, fontWeight: 'bold' },
  contactName: {
    color: '#000000', fontSize: 24, fontWeight: 'bold', marginTop: 8
  },
  contactPhone: { color: '#64748B', fontSize: 14, marginTop: 4 },
  contactStatus: {
    color: '#94A3B8', fontSize: 13, marginTop: 8,
    textAlign: 'center', fontStyle: 'italic'
  },
  actionRow: {
    flexDirection: 'row',
    marginTop: 24,
    gap: 16,
  },
  actionBtn: {
    alignItems: 'center',
    backgroundColor: '#0F1729',
    borderRadius: 16,
    padding: 16,
    minWidth: 68,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  actionIcon: { fontSize: 24, marginBottom: 6 },
  actionLabel: { color: '#94A3B8', fontSize: 12 },
  section: {
    marginHorizontal: 16,
    marginTop: 20,
  },
  sectionTitle: {
    color: '#64748B', fontSize: 13,
    fontWeight: '600', marginBottom: 12,
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  trustCard: {
    flexDirection: 'row',
    backgroundColor: '#0F1729',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1E293B',
    marginBottom: 12,
    alignItems: 'center',
  },
  trustLeft: { flex: 1 },
  trustTitle: { color: '#000000', fontSize: 16, fontWeight: 'bold' },
  trustDesc: { color: '#475569', fontSize: 12, marginTop: 4, lineHeight: 16 },
  trustScoreCircle: {
    alignItems: 'center',
    backgroundColor: '#050D1F',
    borderRadius: 40,
    width: 70,
    height: 70,
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#22C55E',
  },
  trustScoreNum: { fontSize: 24, fontWeight: 'bold' },
  trustScoreMax: { color: '#475569', fontSize: 10 },
  scoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 8,
  },
  scoreLabel: { color: '#94A3B8', fontSize: 12, width: 120 },
  scoreBar: {
    flex: 1, height: 6,
    backgroundColor: '#1E293B',
    borderRadius: 3,
    overflow: 'hidden',
  },
  scoreBarFill: { height: '100%', borderRadius: 3 },
  scoreNum: { fontSize: 11, width: 32, textAlign: 'right' },
  vaultIdCard: {
    backgroundColor: '#0F1729',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  vaultIdLabel: { color: '#64748B', fontSize: 12 },
  vaultIdValue: {
    color: '#3B82F6', fontSize: 14,
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
  verifiedText: { color: '#22C55E', fontSize: 10, fontWeight: 'bold' },
  mediaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  mediaItem: {
    width: 80, height: 80,
    backgroundColor: '#0F1729',
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  mediaIcon: { fontSize: 32 },
  viewAllBtn: { alignItems: 'center', paddingVertical: 8 },
  viewAllText: { color: '#1D4ED8', fontSize: 14 },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0F1729',
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  settingIcon: { fontSize: 20, marginRight: 12 },
  settingLabel: { color: '#000000', fontSize: 15, flex: 1 },
  settingValue: { fontSize: 13, marginRight: 8 },
  settingArrow: { color: '#475569', fontSize: 18 },
  dangerBtn: {
    backgroundColor: '#1A0A0A',
    borderRadius: 14,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#7F1D1D',
  },
  dangerText: { color: '#EF4444', fontSize: 15, fontWeight: '600' },
});
