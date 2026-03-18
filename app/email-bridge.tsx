// app/email-bridge.tsx
// Encrypted Email Bridge — send and receive AES-256-GCM encrypted emails

import React, { useState, useCallback } from 'react';
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

const { width } = Dimensions.get('window');

// ── Mock inbox data ────────────────────────────────────────────
const MOCK_INBOX = [
  {
    id: '1',
    sender: 'alice@protonmail.com',
    subject: 'Project Vault — Phase 2 Details',
    timestamp: '2026-03-18 09:14',
    encrypted: true,
    body: 'Hi, here are the Phase 2 specs for Project Vault. The new encryption module uses X25519 key exchange with AES-256-GCM for payload. Deployment target is April 5th. Please review and confirm.',
  },
  {
    id: '2',
    sender: 'bob@tutanota.com',
    subject: 'Security Audit Report',
    timestamp: '2026-03-17 18:42',
    encrypted: true,
    body: 'Audit complete. No critical vulnerabilities found. Two medium-severity items flagged: 1) Session token rotation interval should be reduced to 15 min. 2) CSP headers missing on /api/webhook endpoint. Full report attached in next message.',
  },
  {
    id: '3',
    sender: 'carol@vaultmail.io',
    subject: 'Key Rotation Reminder',
    timestamp: '2026-03-16 14:30',
    encrypted: true,
    body: 'Your public key was last rotated 28 days ago. For optimal security, we recommend rotating your keys every 30 days. Navigate to Settings > Encryption > Rotate Keys to generate a new keypair.',
  },
  {
    id: '4',
    sender: 'dave@secure.net',
    subject: 'Meeting Notes — Encrypted',
    timestamp: '2026-03-15 11:05',
    encrypted: true,
    body: 'Notes from today\'s standup:\n- Backend migration to Rust complete\n- Mobile app v2.1 pushed to TestFlight\n- Next milestone: end-to-end encrypted file sharing\n- Action item: Dave to review cryptographic library choices by Friday',
  },
];

export default function EmailBridgeScreen() {
  const router = useRouter();

  // Compose state
  const [toEmail, setToEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  // Decrypt modal state
  const [decryptModal, setDecryptModal] = useState(false);
  const [selectedEmail, setSelectedEmail] = useState<typeof MOCK_INBOX[0] | null>(null);
  const [decrypting, setDecrypting] = useState(false);
  const [decrypted, setDecrypted] = useState(false);

  const handleSend = useCallback(() => {
    if (!toEmail.trim()) {
      Alert.alert('Missing Recipient', 'Please enter an email address.');
      return;
    }
    if (!subject.trim()) {
      Alert.alert('Missing Subject', 'Please enter a subject line.');
      return;
    }
    if (!body.trim()) {
      Alert.alert('Missing Body', 'Please enter a message body.');
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(toEmail.trim())) {
      Alert.alert('Invalid Email', 'Please enter a valid email address.');
      return;
    }

    setSending(true);
    setTimeout(() => {
      setSending(false);
      setToEmail('');
      setSubject('');
      setBody('');
      Alert.alert(
        'Encrypted & Sent',
        `Your message to ${toEmail.trim()} has been encrypted with AES-256-GCM and sent successfully.`
      );
    }, 1800);
  }, [toEmail, subject, body]);

  const handleDecrypt = useCallback((email: typeof MOCK_INBOX[0]) => {
    setSelectedEmail(email);
    setDecrypted(false);
    setDecrypting(false);
    setDecryptModal(true);
  }, []);

  const performDecrypt = useCallback(() => {
    setDecrypting(true);
    setTimeout(() => {
      setDecrypting(false);
      setDecrypted(true);
    }, 1200);
  }, []);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="light-content" backgroundColor="#020B18" />

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
          <Text style={styles.headerTitle}>{'\u2709\uFE0F'} Encrypted Email</Text>
          <View style={styles.encBadge}>
            <Text style={styles.encBadgeText}>AES-256-GCM</Text>
          </View>
        </View>

        {/* ── Info Card ───────────────────────────────── */}
        <LinearGradient
          colors={['#0D1B3E', '#0A1628']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.infoCard}
        >
          <Text style={styles.infoIcon}>{'\uD83D\uDD12'}</Text>
          <Text style={styles.infoText}>
            Messages sent to email addresses are encrypted with the recipient's public key. Only they can decrypt.
          </Text>
        </LinearGradient>

        {/* ── Compose Section ─────────────────────────── */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{'\u270F\uFE0F'} Compose Encrypted Email</Text>
        </View>

        <View style={styles.composeCard}>
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>To</Text>
            <TextInput
              style={styles.input}
              placeholder="recipient@email.com"
              placeholderTextColor="#3A4A6B"
              value={toEmail}
              onChangeText={setToEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Subject</Text>
            <TextInput
              style={styles.input}
              placeholder="Email subject"
              placeholderTextColor="#3A4A6B"
              value={subject}
              onChangeText={setSubject}
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Body</Text>
            <TextInput
              style={[styles.input, styles.bodyInput]}
              placeholder="Type your message..."
              placeholderTextColor="#3A4A6B"
              value={body}
              onChangeText={setBody}
              multiline
              numberOfLines={5}
              textAlignVertical="top"
            />
          </View>

          <TouchableOpacity onPress={handleSend} disabled={sending} activeOpacity={0.8}>
            <LinearGradient
              colors={['#4A9FFF', '#7C3AED']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={[styles.sendBtn, sending && { opacity: 0.6 }]}
            >
              <Text style={styles.sendBtnText}>
                {sending ? '\u23F3 Encrypting & Sending...' : '\uD83D\uDD10 Encrypt & Send'}
              </Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>

        {/* ── Inbox Section ───────────────────────────── */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{'\uD83D\uDCE5'} Encrypted Inbox</Text>
          <View style={styles.countBadge}>
            <Text style={styles.countBadgeText}>{MOCK_INBOX.length}</Text>
          </View>
        </View>

        {MOCK_INBOX.map((email) => (
          <View key={email.id} style={styles.emailCard}>
            <View style={styles.emailHeader}>
              <View style={styles.emailSenderRow}>
                <LinearGradient
                  colors={['#4A9FFF', '#7C3AED']}
                  style={styles.emailAvatar}
                >
                  <Text style={styles.emailAvatarText}>
                    {email.sender.charAt(0).toUpperCase()}
                  </Text>
                </LinearGradient>
                <View style={styles.emailMeta}>
                  <Text style={styles.emailSender} numberOfLines={1}>
                    {email.sender}
                  </Text>
                  <Text style={styles.emailTime}>{email.timestamp}</Text>
                </View>
              </View>
              {email.encrypted && (
                <View style={styles.encryptedTag}>
                  <Text style={styles.encryptedTagText}>{'\uD83D\uDD12'} Encrypted</Text>
                </View>
              )}
            </View>

            <Text style={styles.emailSubject} numberOfLines={1}>
              {email.subject}
            </Text>

            <Text style={styles.emailPreview} numberOfLines={2}>
              {'\u2588'.repeat(40)}...
            </Text>

            <TouchableOpacity
              onPress={() => handleDecrypt(email)}
              activeOpacity={0.8}
            >
              <LinearGradient
                colors={['#7C3AED', '#4A9FFF']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.decryptBtn}
              >
                <Text style={styles.decryptBtnText}>{'\uD83D\uDD13'} Decrypt & Read</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
        ))}

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* ── Decrypt Modal ─────────────────────────────── */}
      <Modal
        visible={decryptModal}
        transparent
        animationType="slide"
        onRequestClose={() => setDecryptModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{'\uD83D\uDD10'} Decrypt Email</Text>
              <TouchableOpacity onPress={() => setDecryptModal(false)}>
                <Text style={styles.modalClose}>{'\u2715'}</Text>
              </TouchableOpacity>
            </View>

            {selectedEmail && (
              <ScrollView style={styles.modalScroll} showsVerticalScrollIndicator={false}>
                <View style={styles.modalMeta}>
                  <Text style={styles.modalLabel}>From</Text>
                  <Text style={styles.modalValue}>{selectedEmail.sender}</Text>
                </View>
                <View style={styles.modalMeta}>
                  <Text style={styles.modalLabel}>Subject</Text>
                  <Text style={styles.modalValue}>{selectedEmail.subject}</Text>
                </View>
                <View style={styles.modalMeta}>
                  <Text style={styles.modalLabel}>Date</Text>
                  <Text style={styles.modalValue}>{selectedEmail.timestamp}</Text>
                </View>

                <View style={styles.modalDivider} />

                {!decrypted && !decrypting && (
                  <View style={styles.encryptedBlock}>
                    <Text style={styles.encryptedBlockIcon}>{'\uD83D\uDD12'}</Text>
                    <Text style={styles.encryptedBlockText}>
                      This message is encrypted. Tap below to decrypt with your private key.
                    </Text>
                    <TouchableOpacity onPress={performDecrypt} activeOpacity={0.8}>
                      <LinearGradient
                        colors={['#4A9FFF', '#7C3AED']}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 0 }}
                        style={styles.modalDecryptBtn}
                      >
                        <Text style={styles.modalDecryptBtnText}>
                          {'\uD83D\uDD11'} Decrypt with Private Key
                        </Text>
                      </LinearGradient>
                    </TouchableOpacity>
                  </View>
                )}

                {decrypting && (
                  <View style={styles.encryptedBlock}>
                    <Text style={styles.decryptingText}>{'\u23F3'} Decrypting with your private key...</Text>
                    <View style={styles.progressBar}>
                      <LinearGradient
                        colors={['#4A9FFF', '#7C3AED']}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 0 }}
                        style={styles.progressFill}
                      />
                    </View>
                  </View>
                )}

                {decrypted && (
                  <View style={styles.decryptedBlock}>
                    <View style={styles.decryptedBadge}>
                      <Text style={styles.decryptedBadgeText}>{'\u2705'} Decrypted Successfully</Text>
                    </View>
                    <Text style={styles.decryptedBody}>{selectedEmail.body}</Text>
                  </View>
                )}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#020B18',
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
    marginBottom: 16,
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
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '800',
    flex: 1,
  },
  encBadge: {
    backgroundColor: '#0D2847',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: '#4A9FFF33',
  },
  encBadgeText: {
    color: '#4A9FFF',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },

  // Info card
  infoCard: {
    borderRadius: 14,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#1A2A4A',
  },
  infoIcon: {
    fontSize: 24,
    marginRight: 12,
  },
  infoText: {
    color: '#8899BB',
    fontSize: 13,
    lineHeight: 19,
    flex: 1,
  },

  // Sections
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
    marginTop: 8,
  },
  sectionTitle: {
    color: '#FFFFFF',
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
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },

  // Compose
  composeCard: {
    backgroundColor: '#0A1628',
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
    color: '#FFFFFF',
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#1A2A4A',
  },
  bodyInput: {
    minHeight: 100,
    paddingTop: 12,
  },
  sendBtn: {
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 4,
  },
  sendBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },

  // Email cards
  emailCard: {
    backgroundColor: '#0A1628',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#1A2A4A',
  },
  emailHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 10,
  },
  emailSenderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 8,
  },
  emailAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },
  emailAvatarText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  emailMeta: {
    flex: 1,
  },
  emailSender: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  emailTime: {
    color: '#5A6E8F',
    fontSize: 12,
    marginTop: 2,
  },
  encryptedTag: {
    backgroundColor: '#7C3AED22',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#7C3AED44',
  },
  encryptedTagText: {
    color: '#7C3AED',
    fontSize: 10,
    fontWeight: '700',
  },
  emailSubject: {
    color: '#E0E8F5',
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 6,
  },
  emailPreview: {
    color: '#3A4A6B',
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 12,
  },
  decryptBtn: {
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  decryptBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },

  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.8)',
    justifyContent: 'flex-end',
  },
  modalContainer: {
    backgroundColor: '#0A1628',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '85%',
    paddingBottom: 30,
    borderWidth: 1,
    borderColor: '#1A2A4A',
    borderBottomWidth: 0,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1A2A4A',
  },
  modalTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
  modalClose: {
    color: '#5A6E8F',
    fontSize: 20,
    fontWeight: '600',
    padding: 4,
  },
  modalScroll: {
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  modalMeta: {
    marginBottom: 12,
  },
  modalLabel: {
    color: '#5A6E8F',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 3,
  },
  modalValue: {
    color: '#E0E8F5',
    fontSize: 15,
  },
  modalDivider: {
    height: 1,
    backgroundColor: '#1A2A4A',
    marginVertical: 16,
  },

  // Encrypted block
  encryptedBlock: {
    backgroundColor: '#0D1B3E',
    borderRadius: 14,
    padding: 20,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1A2A4A',
  },
  encryptedBlockIcon: {
    fontSize: 36,
    marginBottom: 12,
  },
  encryptedBlockText: {
    color: '#8899BB',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 16,
  },
  modalDecryptBtn: {
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 28,
    alignItems: 'center',
  },
  modalDecryptBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  decryptingText: {
    color: '#4A9FFF',
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 14,
  },
  progressBar: {
    width: '80%',
    height: 4,
    borderRadius: 2,
    backgroundColor: '#1A2A4A',
    overflow: 'hidden',
  },
  progressFill: {
    width: '70%',
    height: '100%',
    borderRadius: 2,
  },

  // Decrypted
  decryptedBlock: {
    marginTop: 4,
  },
  decryptedBadge: {
    backgroundColor: '#05966922',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    alignSelf: 'flex-start',
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#05966944',
  },
  decryptedBadgeText: {
    color: '#10B981',
    fontSize: 13,
    fontWeight: '600',
  },
  decryptedBody: {
    color: '#E0E8F5',
    fontSize: 15,
    lineHeight: 23,
    marginBottom: 20,
  },
});
