import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import {
    Alert, Animated, Image,
    ScrollView,
    StyleSheet,
    Switch,
    Text,
    TouchableOpacity,
    View
} from 'react-native';

const FAMILY_MEMBERS = [
  { id: '1', name: 'Priya (Daughter)', age: 14, photo: 'https://i.pravatar.cc/150?img=5',
    status: 'online', location: 'School', safeScore: 98, screenTime: '2h 15m',
    gradient: ['#43E97B', '#38F9D7'] as [string,string] },
  { id: '2', name: 'Rahul (Son)', age: 11, photo: 'https://i.pravatar.cc/150?img=8',
    status: 'online', location: 'Home', safeScore: 95, screenTime: '1h 40m',
    gradient: ['#4FACFE', '#00C9FF'] as [string,string] },
  { id: '3', name: 'Mom', age: 58, photo: 'https://i.pravatar.cc/150?img=9',
    status: 'offline', location: 'Last seen: Market', safeScore: 100, screenTime: '45m',
    gradient: ['#FA709A', '#FEE140'] as [string,string] },
];

const CONTENT_FILTERS = [
  { id: 'adult',    icon: '🔞', label: 'Adult Content',    blocked: true  },
  { id: 'violence', icon: '⚔️', label: 'Violence',         blocked: true  },
  { id: 'gambling', icon: '🎰', label: 'Gambling',          blocked: true  },
  { id: 'drugs',    icon: '💊', label: 'Drugs & Alcohol',   blocked: true  },
  { id: 'social',   icon: '📱', label: 'Social Media',      blocked: false },
  { id: 'gaming',   icon: '🎮', label: 'Gaming (18+)',      blocked: false },
];

export default function FamilyScreen() {
  const router = useRouter();
  const [filters, setFilters] = useState(CONTENT_FILTERS);
  const [locationSharing, setLocationSharing] = useState(true);
  const [screenTimeLimit, setScreenTimeLimit] = useState(true);
  const [safeSearch, setSafeSearch]           = useState(true);
  const [bedtimeMode, setBedtimeMode]         = useState(true);
  const [selectedMember, setSelectedMember]   = useState<string | null>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  const toggleFilter = (id: string) => {
    setFilters(prev => prev.map(f => f.id === id ? { ...f, blocked: !f.blocked } : f));
  };

  const familySafeScore = Math.round(
    FAMILY_MEMBERS.reduce((s, m) => s + m.safeScore, 0) / FAMILY_MEMBERS.length
  );

  return (
    <View style={styles.container}>

      {/* ── HEADER ─────────────────────────────────── */}
      <LinearGradient colors={['#030A18', '#050D1F']} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backArrow}>←</Text>
        </TouchableOpacity>
        <View>
          <Text style={styles.headerTitle}>👨‍👩‍👧 SafeFamily Hub</Text>
          <Text style={styles.headerSub}>World-First Family Protection 🏆</Text>
        </View>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => Alert.alert('Add Member', 'Send invite link to family member?\n\nThey will receive a secure VaultChat invite!', [
            { text: 'Send Invite 📨', onPress: () => Alert.alert('✅ Invite Sent!', 'Your family member will receive a VaultChat invite.') },
            { text: 'Cancel', style: 'cancel' },
          ])}
        >
          <LinearGradient colors={['#1D4ED8', '#7C3AED']} style={styles.addBtnGrad}>
            <Text style={styles.addBtnText}>+ Add</Text>
          </LinearGradient>
        </TouchableOpacity>
      </LinearGradient>

      <ScrollView showsVerticalScrollIndicator={false}>

        {/* ── FAMILY SAFE SCORE ──────────────────────── */}
        <LinearGradient
          colors={['#064E3B', '#065F46']}
          style={styles.safeScoreCard}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
        >
          <View style={styles.safeScoreLeft}>
            <Text style={styles.safeScoreTitle}>👨‍👩‍👧 Family Safety Score</Text>
            <Text style={styles.safeScoreSubtitle}>All members protected by VaultChat</Text>
            <View style={styles.safeScoreBarBg}>
              <View style={[styles.safeScoreBarFill, { width: `${familySafeScore}%` }]} />
            </View>
            <Text style={styles.safeScoreNote}>
              🛡️ {FAMILY_MEMBERS.filter(m => m.status === 'online').length} members online now
            </Text>
          </View>
          <View style={styles.safeScoreRight}>
            <Text style={styles.safeScoreNum}>{familySafeScore}</Text>
            <Text style={styles.safeScoreMax}>/100</Text>
          </View>
        </LinearGradient>

        {/* ── FAMILY MEMBERS ─────────────────────────── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>👥 FAMILY MEMBERS</Text>
          {FAMILY_MEMBERS.map(member => (
            <TouchableOpacity
              key={member.id}
              style={[styles.memberCard,
                selectedMember === member.id && styles.memberCardSelected]}
              onPress={() => setSelectedMember(
                selectedMember === member.id ? null : member.id
              )}
              activeOpacity={0.8}
            >
              {/* Avatar + gradient ring */}
              <LinearGradient
                colors={member.gradient}
                style={styles.memberAvatarRing}
              >
                <Image source={{ uri: member.photo }} style={styles.memberPhoto} />
              </LinearGradient>

              {/* Online dot */}
              {member.status === 'online' && (
                <View style={styles.memberOnlineDot} />
              )}

              {/* Info */}
              <View style={styles.memberInfo}>
                <View style={styles.memberRow1}>
                  <Text style={styles.memberName}>{member.name}</Text>
                  <Text style={styles.memberAge}>Age {member.age}</Text>
                </View>
                <View style={styles.memberRow2}>
                  <Text style={styles.memberLocation}>📍 {member.location}</Text>
                  <Text style={styles.memberScreen}>⏱ {member.screenTime}</Text>
                </View>
                {/* Safe score bar */}
                <View style={styles.memberScoreRow}>
                  <View style={styles.memberScoreBarBg}>
                    <LinearGradient
                      colors={member.gradient}
                      style={[styles.memberScoreBarFill, { width: `${member.safeScore}%` }]}
                      start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    />
                  </View>
                  <Text style={styles.memberScoreText}>{member.safeScore}/100</Text>
                </View>
              </View>

              <Text style={styles.memberChevron}>
                {selectedMember === member.id ? '▲' : '▼'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* ── CONTENT FILTERS ────────────────────────── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>🚫 CONTENT FILTERS</Text>
          <View style={styles.card}>
            {filters.map((filter, i) => (
              <View key={filter.id}>
                <View style={styles.filterRow}>
                  <View style={styles.filterLeft}>
                    <View style={[styles.filterIconBox,
                      { backgroundColor: filter.blocked ? '#1A0A0A' : '#0D1E3A' }]}>
                      <Text style={styles.filterIcon}>{filter.icon}</Text>
                    </View>
                    <View>
                      <Text style={styles.filterLabel}>{filter.label}</Text>
                      <Text style={[styles.filterStatus,
                        { color: filter.blocked ? '#EF4444' : '#22C55E' }]}>
                        {filter.blocked ? '🚫 Blocked' : '✅ Allowed'}
                      </Text>
                    </View>
                  </View>
                  <Switch
                    value={filter.blocked}
                    onValueChange={() => toggleFilter(filter.id)}
                    trackColor={{ false: '#1E293B', true: '#EF4444' }}
                    thumbColor="#FFFFFF"
                  />
                </View>
                {i < filters.length - 1 && <View style={styles.divider} />}
              </View>
            ))}
          </View>
        </View>

        {/* ── SAFETY CONTROLS ────────────────────────── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>⚙️ SAFETY CONTROLS</Text>
          <View style={styles.card}>
            {[
              { icon: '📍', label: 'Location Sharing',  sub: 'See where family is in real-time',    val: locationSharing, set: setLocationSharing },
              { icon: '⏰', label: 'Screen Time Limit', sub: 'Max 3 hours/day for children',         val: screenTimeLimit, set: setScreenTimeLimit },
              { icon: '🔍', label: 'Safe Search',       sub: 'Filter harmful search results',        val: safeSearch,      set: setSafeSearch      },
              { icon: '🌙', label: 'Bedtime Mode',      sub: 'No messages after 10 PM for kids',     val: bedtimeMode,     set: setBedtimeMode     },
            ].map((item, i, arr) => (
              <View key={i}>
                <View style={styles.controlRow}>
                  <View style={styles.controlLeft}>
                    <View style={styles.controlIconBox}>
                      <Text style={styles.controlIcon}>{item.icon}</Text>
                    </View>
                    <View>
                      <Text style={styles.controlLabel}>{item.label}</Text>
                      <Text style={styles.controlSub}>{item.sub}</Text>
                    </View>
                  </View>
                  <Switch
                    value={item.val}
                    onValueChange={() => item.set(!item.val)}
                    trackColor={{ false: '#1E293B', true: '#1D4ED8' }}
                    thumbColor={item.val ? '#FFFFFF' : '#475569'}
                  />
                </View>
                {i < arr.length - 1 && <View style={styles.divider} />}
              </View>
            ))}
          </View>
        </View>

        {/* ── QUICK ACTIONS ──────────────────────────── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>⚡ QUICK ACTIONS</Text>
          <View style={styles.actionsGrid}>
            {[
              { icon: '🆘', label: 'SOS Alert',      color: ['#7F1D1D','#991B1B'] as [string,string],
                onPress: () => Alert.alert('🆘 SOS Alert Sent!', 'All family members have been notified of your emergency!') },
              { icon: '📍', label: 'Find Family',    color: ['#0D2A5A','#1A0A3A'] as [string,string],
                onPress: () => Alert.alert('📍 Live Location', `Priya: School\nRahul: Home\nMom: Last seen Market\n\nAll locations from 5 min ago`) },
              { icon: '⏰', label: 'Screen Report',  color: ['#064E3B','#065F46'] as [string,string],
                onPress: () => Alert.alert('📊 Today\'s Screen Time', 'Priya: 2h 15m ✅\nRahul: 1h 40m ✅\nMom: 45m ✅\n\nAll within limits!') },
              { icon: '🔒', label: 'Lock All',       color: ['#1A0A2A','#2D1B69'] as [string,string],
                onPress: () => Alert.alert('🔒 All Devices Locked', 'All family member devices have been locked remotely!', [
                  { text: 'Unlock All', onPress: () => Alert.alert('✅ Unlocked', 'All devices unlocked!') },
                  { text: 'Keep Locked' },
                ]) },
            ].map((a, i) => (
              <TouchableOpacity key={i} style={styles.actionCard} onPress={a.onPress}>
                <LinearGradient colors={a.color} style={styles.actionCardInner}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
                  <Text style={styles.actionCardIcon}>{a.icon}</Text>
                  <Text style={styles.actionCardLabel}>{a.label}</Text>
                </LinearGradient>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* ── WORLD FIRST BADGE ──────────────────────── */}
        <LinearGradient
          colors={['#1D4ED8', '#7C3AED']}
          style={styles.worldFirstBadge}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
        >
          <Text style={styles.worldFirstEmoji}>🏆</Text>
          <View>
            <Text style={styles.worldFirstTitle}>World-First Feature</Text>
            <Text style={styles.worldFirstSub}>
              No other messenger has family safety controls built in
            </Text>
          </View>
        </LinearGradient>

        <View style={{ height: 50 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#030A18' },

  header: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 54, paddingBottom: 14, paddingHorizontal: 16,
    borderBottomWidth: 1, borderBottomColor: '#0D1E3A',
  },
  backBtn: { padding: 6 },
  backArrow: { color: '#4A9FFF', fontSize: 26, fontWeight: '300' },
  headerTitle: { color: '#FFFFFF', fontSize: 17, fontWeight: '800', textAlign: 'center' },
  headerSub: { color: '#2D4A6B', fontSize: 11, textAlign: 'center' },
  addBtn: { borderRadius: 10, overflow: 'hidden' },
  addBtnGrad: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10 },
  addBtnText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },

  // SAFE SCORE CARD
  safeScoreCard: {
    margin: 16, borderRadius: 20, padding: 20,
    flexDirection: 'row', alignItems: 'center',
    elevation: 10, shadowColor: '#22C55E',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3, shadowRadius: 12,
  },
  safeScoreLeft: { flex: 1, gap: 6 },
  safeScoreTitle:    { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  safeScoreSubtitle: { color: 'rgba(255,255,255,0.7)', fontSize: 12 },
  safeScoreBarBg: {
    height: 6, backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 3, marginTop: 4,
  },
  safeScoreBarFill: { height: 6, backgroundColor: '#4ADE80', borderRadius: 3 },
  safeScoreNote: { color: 'rgba(255,255,255,0.6)', fontSize: 11 },
  safeScoreRight: { alignItems: 'center', marginLeft: 16 },
  safeScoreNum: { color: '#4ADE80', fontSize: 48, fontWeight: '900', lineHeight: 54 },
  safeScoreMax: { color: 'rgba(255,255,255,0.5)', fontSize: 14 },

  // SECTIONS
  section: { marginHorizontal: 16, marginBottom: 20 },
  sectionTitle: {
    color: '#2D4A6B', fontSize: 11, fontWeight: '800',
    letterSpacing: 1, marginBottom: 10, marginLeft: 4,
  },
  card: {
    backgroundColor: '#0A1628', borderRadius: 16,
    borderWidth: 1, borderColor: '#0D1E3A', overflow: 'hidden',
  },
  divider: { height: 1, backgroundColor: '#0D1E3A', marginLeft: 56 },

  // MEMBER CARD
  memberCard: {
    backgroundColor: '#0A1628', borderRadius: 16,
    borderWidth: 1, borderColor: '#0D1E3A',
    padding: 14, marginBottom: 10,
    flexDirection: 'row', alignItems: 'center', gap: 12,
  },
  memberCardSelected: { borderColor: '#1D4ED8', backgroundColor: '#0D1E3A' },
  memberAvatarRing: {
    width: 52, height: 52, borderRadius: 26,
    justifyContent: 'center', alignItems: 'center', padding: 2.5,
  },
  memberPhoto: {
    width: 44, height: 44, borderRadius: 22,
    borderWidth: 2, borderColor: '#030A18',
  },
  memberOnlineDot: {
    position: 'absolute', left: 52, top: 10,
    width: 12, height: 12, borderRadius: 6,
    backgroundColor: '#22C55E', borderWidth: 2, borderColor: '#030A18',
  },
  memberInfo: { flex: 1, gap: 4 },
  memberRow1: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  memberName: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  memberAge:  { color: '#2D4A6B', fontSize: 11 },
  memberRow2: { flexDirection: 'row', gap: 12 },
  memberLocation: { color: '#3D5A7A', fontSize: 11 },
  memberScreen:   { color: '#3D5A7A', fontSize: 11 },
  memberScoreRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  memberScoreBarBg: {
    flex: 1, height: 4,
    backgroundColor: '#0D1E3A', borderRadius: 2,
  },
  memberScoreBarFill: { height: 4, borderRadius: 2 },
  memberScoreText: { color: '#22C55E', fontSize: 10, fontWeight: '700' },
  memberChevron: { color: '#2D4A6B', fontSize: 12 },

  // FILTERS
  filterRow: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 12,
  },
  filterLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  filterIconBox: {
    width: 36, height: 36, borderRadius: 10,
    justifyContent: 'center', alignItems: 'center',
  },
  filterIcon:   { fontSize: 18 },
  filterLabel:  { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  filterStatus: { fontSize: 11, marginTop: 2 },

  // CONTROLS
  controlRow: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 13,
  },
  controlLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  controlIconBox: {
    width: 36, height: 36, borderRadius: 10,
    justifyContent: 'center', alignItems: 'center',
    backgroundColor: '#0D1E3A',
  },
  controlIcon:  { fontSize: 18 },
  controlLabel: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  controlSub:   { color: '#3D5A7A', fontSize: 11, marginTop: 2 },

  // ACTIONS GRID
  actionsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  actionCard: { width: '47%', borderRadius: 14, overflow: 'hidden' },
  actionCardInner: {
    padding: 16, borderRadius: 14, alignItems: 'center', gap: 8,
    borderWidth: 1, borderColor: '#1D4ED820',
  },
  actionCardIcon:  { fontSize: 28 },
  actionCardLabel: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },

  // WORLD FIRST BADGE
  worldFirstBadge: {
    marginHorizontal: 16, marginBottom: 16,
    borderRadius: 16, padding: 16,
    flexDirection: 'row', alignItems: 'center', gap: 14,
  },
  worldFirstEmoji: { fontSize: 36 },
  worldFirstTitle: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  worldFirstSub:   { color: 'rgba(255,255,255,0.7)', fontSize: 12, marginTop: 2 },
});
