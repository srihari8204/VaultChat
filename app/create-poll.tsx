// @ts-nocheck
// app/create-poll.tsx — Create & Vote on Polls
// Works in group chats. Stored in Firestore: chats/{id}/polls/{pollId}
// Real-time vote updates via Firestore listener

import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput,
  Alert, StatusBar, ScrollView, Switch,
} from 'react-native';
import { useRouter, useLocalSearchParams, Stack } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';

const C = { bg: '#020B18', accent: '#4A9FFF', green: '#10B981', card: '#0A1628', danger: '#FF3C6E' };

export default function CreatePollScreen() {
  const router = useRouter();
  const { chatId, groupName } = useLocalSearchParams();
  const myUid = auth().currentUser?.uid || '';
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multiVote, setMultiVote] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [creating, setCreating] = useState(false);

  const addOption = () => {
    if (options.length >= 10) { Alert.alert('Maximum 10 options'); return; }
    setOptions([...options, '']);
  };

  const removeOption = (idx) => {
    if (options.length <= 2) return;
    setOptions(options.filter((_, i) => i !== idx));
  };

  const updateOption = (idx, text) => {
    const newOpts = [...options];
    newOpts[idx] = text;
    setOptions(newOpts);
  };

  const createPoll = async () => {
    if (!question.trim()) { Alert.alert('Enter a question'); return; }
    const validOpts = options.filter(o => o.trim());
    if (validOpts.length < 2) { Alert.alert('Need at least 2 options'); return; }

    setCreating(true);
    try {
      const myDoc = await firestore().collection('users').doc(myUid).get();
      const myName = myDoc.data()?.name || 'Someone';

      const pollData = {
        question: question.trim(),
        options: validOpts.map(o => ({ text: o.trim(), votes: [] })),
        creatorUid: myUid,
        creatorName: myName,
        multiVote,
        anonymous,
        totalVotes: 0,
        closed: false,
        createdAt: firestore.FieldValue.serverTimestamp(),
      };

      // Save poll as a special message in the chat
      await firestore().collection('chats').doc(chatId).collection('messages').add({
        senderId: myUid,
        msgType: 'poll',
        pollData,
        createdAt: firestore.FieldValue.serverTimestamp(),
        status: 'sent',
      });

      // Update last message
      await firestore().collection('chats').doc(chatId).update({
        lastMsg: '\uD83D\uDCCA Poll: ' + question.trim().slice(0, 40),
        lastTime: firestore.FieldValue.serverTimestamp(),
      });

      router.back();
    } catch (e) { Alert.alert('Error', 'Could not create poll'); }
    setCreating(false);
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Create Poll', headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff' }} />
      <ScrollView style={s.container}>
        <StatusBar barStyle="light-content" />

        <View style={s.section}>
          <Text style={s.label}>Question</Text>
          <TextInput style={s.questionInput} value={question} onChangeText={setQuestion}
            placeholder="Ask a question..." placeholderTextColor="#555" multiline maxLength={300} />
        </View>

        <View style={s.section}>
          <Text style={s.label}>Options</Text>
          {options.map((opt, i) => (
            <View key={i} style={s.optRow}>
              <View style={s.optNum}><Text style={s.optNumTxt}>{i + 1}</Text></View>
              <TextInput style={s.optInput} value={opt} onChangeText={t => updateOption(i, t)}
                placeholder={'Option ' + (i + 1)} placeholderTextColor="#555" maxLength={100} />
              {options.length > 2 && (
                <TouchableOpacity onPress={() => removeOption(i)} style={s.removeOpt}>
                  <Text style={{ color: C.danger, fontSize: 18 }}>{"\u2715"}</Text>
                </TouchableOpacity>
              )}
            </View>
          ))}
          {options.length < 10 && (
            <TouchableOpacity style={s.addOptBtn} onPress={addOption}>
              <Text style={s.addOptTxt}>{"\u2795  Add Option"}</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={s.section}>
          <Text style={s.label}>Settings</Text>
          <View style={s.settRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.settLabel}>Allow Multiple Votes</Text>
              <Text style={s.settDesc}>Members can vote for more than one option</Text>
            </View>
            <Switch value={multiVote} onValueChange={setMultiVote} thumbColor={multiVote ? C.accent : '#555'} trackColor={{ false: '#222', true: '#4A9FFF44' }} />
          </View>
          <View style={s.settRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.settLabel}>Anonymous Voting</Text>
              <Text style={s.settDesc}>Hide who voted for what</Text>
            </View>
            <Switch value={anonymous} onValueChange={setAnonymous} thumbColor={anonymous ? C.accent : '#555'} trackColor={{ false: '#222', true: '#4A9FFF44' }} />
          </View>
        </View>

        <TouchableOpacity style={[s.createBtn, creating && { opacity: 0.5 }]} onPress={createPoll} disabled={creating}>
          <Text style={s.createTxt}>{creating ? 'Creating...' : '\uD83D\uDCCA  Create Poll'}</Text>
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, padding: 16 },
  section: { marginBottom: 20 },
  label: { color: '#555', fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 8 },
  questionInput: { backgroundColor: C.card, borderRadius: 14, padding: 16, color: '#fff', fontSize: 16, minHeight: 80, borderWidth: 1, borderColor: '#111', textAlignVertical: 'top' },
  optRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 8 },
  optNum: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#111', justifyContent: 'center', alignItems: 'center' },
  optNumTxt: { color: '#555', fontSize: 12, fontWeight: '800' },
  optInput: { flex: 1, backgroundColor: C.card, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, color: '#fff', fontSize: 14, borderWidth: 1, borderColor: '#111' },
  removeOpt: { width: 32, height: 32, justifyContent: 'center', alignItems: 'center' },
  addOptBtn: { backgroundColor: '#4A9FFF15', borderRadius: 10, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: '#4A9FFF33', borderStyle: 'dashed' },
  addOptTxt: { color: C.accent, fontSize: 13, fontWeight: '600' },
  settRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: '#111' },
  settLabel: { color: '#E0E0F0', fontSize: 14, fontWeight: '600' },
  settDesc: { color: '#555', fontSize: 11, marginTop: 2 },
  createBtn: { backgroundColor: C.accent, borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  createTxt: { color: '#000', fontSize: 16, fontWeight: '900' },
});
