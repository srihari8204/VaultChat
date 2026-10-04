// components/sos/SosContacts.tsx — the Emergency SOS screen's contact picker
// (split out of app/emergency-sos.tsx). The screen owns the list and selection.

import React from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../lib/theme';
import { useSosStyles } from './sosStyles';

export type SosContact = { uid: string; name: string; vaultId: string };

export default function SosContacts({ contacts, selected, onToggle, locked, loading, everLoaded, loadError, onRetry }: {
  contacts: SosContact[]; selected: string[]; onToggle: (uid: string) => void;
  /** The recipients are fixed once the countdown starts (or while sending). */
  locked: boolean;
  loading: boolean; everLoaded: boolean; loadError: boolean; onRetry: () => void;
}) {
  const { colors } = useTheme();
  const styles = useSosStyles();
  const router = useRouter();
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle} accessibilityRole="header">SOS Contacts</Text>
        {contacts.length > 0 && (
          <TouchableOpacity
            onPress={() => router.push('/trusted-contacts')}
            accessibilityRole="button"
            accessibilityLabel="Edit trusted contacts"
            hitSlop={12}
          >
            <Text style={styles.editLink}>Edit</Text>
          </TouchableOpacity>
        )}
      </View>
      {loading && !everLoaded ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: 16 }} />
      ) : loadError && !everLoaded ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyText}>
            Couldn&apos;t load your trusted contacts. Check your connection. An SOS still goes to all of them.
          </Text>
          <TouchableOpacity onPress={onRetry} style={styles.setupBtn} accessibilityRole="button" accessibilityLabel="Retry loading trusted contacts">
            <Text style={styles.setupBtnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : contacts.length === 0 ? (
        <View style={styles.emptyCard}>
          {loadError && (
            <Text style={styles.refreshWarn} accessibilityLiveRegion="polite">
              Couldn&apos;t refresh this list. It was empty when it last loaded.
            </Text>
          )}
          <Text style={styles.emptyText}>No trusted contacts set up</Text>
          <TouchableOpacity onPress={() => router.push('/trusted-contacts')} style={styles.setupBtn} accessibilityRole="button">
            <Text style={styles.setupBtnText}>Set Up Trusted Contacts</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
        {loadError && (
          <Text style={styles.refreshWarn} accessibilityLiveRegion="polite">
            Couldn&apos;t refresh this list — showing the last one loaded.
          </Text>
        )}
        {contacts.map(contact => (
          <TouchableOpacity
            key={contact.uid}
            style={[styles.contactRow, selected.includes(contact.uid) && styles.contactSelected]}
            onPress={() => onToggle(contact.uid)}
            // Fixed once the countdown starts.
            disabled={locked}
            accessibilityRole="checkbox"
            accessibilityLabel={`${contact.name}, @${contact.vaultId}`}
            accessibilityState={{ checked: selected.includes(contact.uid), disabled: locked }}
          >
            <View style={[styles.contactCheck, selected.includes(contact.uid) && styles.contactCheckActive]}>
              {selected.includes(contact.uid) && <Ionicons name="checkmark" size={14} color={colors.accent} />}
            </View>
            <View style={styles.contactInfo}>
              <Text numberOfLines={1} style={styles.contactName}>{contact.name}</Text>
              <Text style={styles.contactId}>@{contact.vaultId}</Text>
            </View>
          </TouchableOpacity>
        ))}
        </>
      )}
    </View>
  );
}
