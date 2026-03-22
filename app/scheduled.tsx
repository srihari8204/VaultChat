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
      <Stack.Screen options={{ title: 'ðŸ“… Scheduled', headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff' }} />
      <View style={{ flex: 1, backgroundColor: '#03030E' }}>
        {loading
          ? <ActivityIndicator color="#00E5FF" style={{ marginTop: 40 }} />
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
                  <Text style={{ color: '#E0E0F0', fontSize: 16, fontWeight: '600' }}>No scheduled messages</Text>
                  <Text style={{ color: '#555', fontSize: 13, marginTop: 6 }}>Long press Send in chat to schedule</Text>
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
  chatName:  { color: '#00E5FF', fontSize: 13, fontWeight: 'bold', marginBottom: 4 },
  msg:       { color: '#C0C0E0', fontSize: 14, marginBottom: 4 },
  time:      { color: '#FF8C42', fontSize: 12 },
  cancelBtn: { padding: 8 },
});
