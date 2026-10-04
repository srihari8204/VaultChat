// components/shopbook/notifications.tsx — Shop Book: the notification inbox (customer and owner).
// Moved out of components/shopbook/customerViews.tsx unchanged (round 7 split).
// Palette and styles come from ./theme.

import { useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, Alert, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { dateLocale, notificationTarget, type NotificationTarget } from '../../utils/shopbook';
import * as SB from '../../services/shopBookService';
import { LoadingState, ErrorState } from '../finance/ui';
import { t } from '../../lib/shopbookI18n';
import { C, s } from './theme';
import { SubHeader, Empty } from './shared';
import { useShopLoad } from './useShopLoad';
import { userErrorText } from '../../lib/userErrorText';

export function NotificationCenter({ mode, onBack, onRead, onReadOne, onOpen }: {
  mode: 'customer' | 'owner';
  onBack: () => void; onRead: () => void; onReadOne: () => void;
  onOpen: (target: NotificationTarget) => void;
}) {
  const [items, setItems] = useState<SB.Notification[]>([]);
  const { loading, err, load } = useShopLoad(fetchNotifications, setItems);

  const markAll = async () => {
    try { await SB.markNotificationsRead(); onRead(); load(); }
    catch (e) { Alert.alert('Could not mark as read', userErrorText(e, 'Try again')); }
  };

  // Opening a row reads it. Marking is best-effort: the badge corrects itself
  // on the next inbox load, and a failed mark must not block the navigation.
  const open = (n: SB.Notification, target: NotificationTarget) => {
    if (!n.read) {
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      onReadOne();
      SB.markNotificationsRead([n.id]).catch(() => {});
    }
    onOpen(target);
  };

  const renderItem = ({ item: n }: { item: SB.Notification }) => {
    const target = notificationTarget(n, mode);
    const label = [n.read ? '' : 'Unread', n.title, n.body].filter(Boolean).join('. ');
    const body = (
      <>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={s.cardTitle}>{n.title}</Text>
          {!!n.body && <Text style={s.cardSub}>{n.body}</Text>}
          <Text style={[s.cardSub, { fontSize: 11 }]}>{new Date(n.createdAt).toLocaleString(dateLocale())}</Text>
        </View>
        {!n.read && <View style={[s.pillDot, { backgroundColor: C.green }]} />}
        {target && <Ionicons name="chevron-forward" size={18} color={C.sub} />}
      </>
    );
    // Only a row with somewhere to go is a button; the rest stay plain text
    // rather than touchables that do nothing.
    return target ? (
      <TouchableOpacity style={[s.card, !n.read && { borderColor: C.green }]} onPress={() => open(n, target)}
        accessibilityRole="button" accessibilityLabel={label}
        accessibilityHint={target.kind === 'returns' ? 'Opens your returns' : 'Opens the order'}>
        {body}
      </TouchableOpacity>
    ) : (
      <View style={[s.card, !n.read && { borderColor: C.green }]} accessible accessibilityLabel={label}>
        {body}
      </View>
    );
  };

  return (
    <>
      <SubHeader title={t('notif.title')} onBack={onBack}
        right={{ icon: 'checkmark-done-outline', label: t('notif.markAllRead'), onPress: markAll }} />
      {/* Up to 100 rows come back, so the inbox is a virtualized list. */}
      <FlatList
        data={items}
        keyExtractor={(n) => n.id}
        renderItem={renderItem}
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.green} />}
        ListHeaderComponent={(
          <>
            {loading && items.length === 0 && <LoadingState />}
            {!!err && !loading && <ErrorState title="Couldn’t load notifications" sub={err} onRetry={load} />}
            {!loading && !err && items.length === 0 && <Empty icon="notifications-off-outline" text={t('notif.empty')} />}
          </>
        )}
        ListFooterComponent={items.length > 0 ? (
          <TouchableOpacity style={s.outlineBtn} onPress={markAll} accessibilityRole="button">
            <Ionicons name="checkmark-done" size={18} color={C.green} />
            <Text style={s.outlineBtnText}>{t('notif.markAllRead')}</Text>
          </TouchableOpacity>
        ) : null}
      />
    </>
  );
}

const fetchNotifications = () => SB.notifications().then((r) => r.notifications);
