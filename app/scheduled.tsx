// app/scheduled.tsx
// View and cancel pending scheduled messages

import React, { useState, useEffect } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { Stack } from 'expo-router';
import { getPendingScheduled, deleteScheduled, ScheduledMessage } from '../services/scheduledService';

export default function ScheduledScreen() {
  const [items,   setItems]   = useState<ScheduledMessage[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setItems(await getPendingScheduled());
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const cancel = (item: ScheduledMessage) => {
    Alert.alert('Cancel scheduled message?', `"${item.plaintext.substring(0, 60)}"`, [
      { text: 'Keep', style: 'cancel' },
      { text: 'Cancel message', style: 'destructive', onPress: async () => {
        await deleteScheduled(item.id);
        load();
      }},
    ]);
  };

  const fmt = (d: Date) => d?.toLocaleString?.([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) ?? '';

  return (
    <>
      <Stack.Screen options={{ title: 'ðŸ“… Scheduled', headerStyle: { backgroundColor: '#FFFFFF' }, headerTintColor: '#1F2937' }} />
      <View style={{ flex: 1, backgroundColor: '#FFFFFF' }}>
        {loading
          ? <ActivityIndicator color="#4A9FFF" style={{ marginTop: 40 }} />
          : <FlatList
              data={items}
              keyExtractor={i => i.id}
              renderItem={({ item }) => (
                <View style={s.item}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.chatName}>To: {item.chatName}</Text>
                    <Text style={s.msg} numberOfLines={2}>{item.plaintext}</Text>
                    <Text style={s.time}>ðŸ“… {fmt(item.scheduledFor)}</Text>
                  </View>
                  <TouchableOpacity onPress={() => cancel(item)} style={s.cancelBtn}>
                    <Text style={{ color: '#FF3C6E', fontSize: 13 }}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              )}
              ListEmptyComponent={
                <View style={{ alignItems: 'center', paddingTop: 80 }}>
                  <Text style={{ fontSize: 40, marginBottom: 12 }}>ðŸ“…</Text>
                  <Text style={{ color: '#1F2937', fontSize: 16, fontWeight: '600' }}>No scheduled messages</Text>
                  <Text style={{ color: '#6B7280', fontSize: 13, marginTop: 6 }}>Long press Send in chat to schedule</Text>
                </View>
              }
            />
        }
      </View>
    </>
  );
}

const s = StyleSheet.create({
  item:      { flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: '#0A0A18' },
  chatName:  { color: '#4A9FFF', fontSize: 13, fontWeight: 'bold', marginBottom: 4 },
  msg:       { color: '#C0C0E0', fontSize: 14, marginBottom: 4 },
  time:      { color: '#FF8C42', fontSize: 12 },
  cancelBtn: { padding: 8 },
});
