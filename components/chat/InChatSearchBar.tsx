// components/chat/InChatSearchBar.tsx — the chat screen's inline "Find in chat"
// bar: the field, a live match count, previous/next and close.
//
// It searches the rows the thread RENDERS (app/chat.tsx renderMessages), so the
// count and the stepping agree with what the bubbles highlight. Older history
// that is not loaded is the /in-chat-search screen's job; the bar's "all
// messages" button opens it (onSearchAll), and a picked result jumps back here.

import { useEffect, useMemo, useState } from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../lib/theme';
import { countVisibleMatches } from '../../lib/inChatSearchCount';
import { useS, type DisplayMessage } from './chatStyles';
import { isProtectedMessage } from './protectedText';

export function InChatSearchBar({ renderMessages: renderedRows, searchQ, setSearchQ, onClose, onGoTo, onSearchAll }: {
  renderMessages: DisplayMessage[];
  searchQ: string;
  setSearchQ: (q: string) => void;
  onClose: () => void;
  /** Scroll the thread to this row (an element of renderMessages). */
  onGoTo: (row: DisplayMessage) => void;
  /** Open the full-history search (/in-chat-search) for what is not loaded. */
  onSearchAll: () => void;
}) {
  const S = useS();
  const { colors } = useTheme();
  // View-once and Invisible Ink rows are never searched: a count or a jump to
  // a hidden row would reveal what it says without the reveal.
  const renderMessages = useMemo(() => renderedRows.filter(m => !isProtectedMessage(m)), [renderedRows]);
  // Matching rows, newest first (the list order). The per-row test IS the
  // counter's own test, so the stepping can never disagree with the count.
  const hits = useMemo(
    () => (searchQ.trim() ? renderMessages.filter(m => countVisibleMatches([m], searchQ) > 0) : []),
    [renderMessages, searchQ],
  );
  // -1 = not stepped yet. Reset whenever the query changes.
  const [hit, setHit] = useState(-1);
  useEffect(() => { setHit(-1); }, [searchQ]);

  const total = countVisibleMatches(renderMessages, searchQ);
  const step = (dir: 1 | -1) => {
    if (!hits.length) return;
    // dir 1 = older (up the inverted list), -1 = newer. Wraps at either end.
    const next = hit < 0 ? (dir === 1 ? 0 : hits.length - 1) : (hit + dir + hits.length) % hits.length;
    setHit(next);
    onGoTo(hits[next]);
  };

  return (
    <View style={S.inChatSearchBar}>
      <TextInput
        style={S.inChatSearchInput}
        placeholder="Find in chat…"
        placeholderTextColor={colors.textDim}
        value={searchQ}
        onChangeText={setSearchQ}
        autoFocus
        maxLength={200}
        accessibilityLabel="Find in chat"
        returnKeyType="search"
        onSubmitEditing={() => step(1)}
      />
      {searchQ.length > 0 && (
        <Text style={S.inChatSearchCount} numberOfLines={1} accessibilityLiveRegion="polite">
          {hit >= 0 && total > 0 ? `${hit + 1} of ${total}` : `${total} ${total === 1 ? 'match' : 'matches'}`}
        </Text>
      )}
      <TouchableOpacity
        onPress={() => step(1)}
        disabled={!hits.length}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Previous match"
        accessibilityHint="Older message"
        accessibilityState={{ disabled: !hits.length }}
      >
        <Ionicons name="chevron-up" size={20} color={hits.length ? colors.text : colors.textFaint} />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={() => step(-1)}
        disabled={!hits.length}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Next match"
        accessibilityHint="Newer message"
        accessibilityState={{ disabled: !hits.length }}
      >
        <Ionicons name="chevron-down" size={20} color={hits.length ? colors.text : colors.textFaint} />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={onSearchAll}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Search all messages"
        accessibilityHint="Also searches older history that is not loaded here"
      >
        <Ionicons name="albums-outline" size={19} color={colors.text} />
      </TouchableOpacity>
      {/* The dismiss lives on the bar now that the header toggle is gone.
          It belongs here anyway — you close a search field from the field,
          not from a button three positions away in the app bar. */}
      <TouchableOpacity
        onPress={onClose}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Close search"
      >
        <Ionicons name="close" size={20} color={colors.textDim} />
      </TouchableOpacity>
    </View>
  );
}
