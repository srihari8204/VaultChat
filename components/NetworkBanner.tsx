import { useEffect, useRef, useState } from 'react';
import { Animated } from 'react-native';

export function NetworkBanner() {
  const [netState, setNetState] = useState<NetworkState>('online');
  const slideAnim = useRef(new Animated.Value(-48)).current;

  useEffect(() => {
    const unsub = subscribeNetwork(s => {
      setNetState(s);
      Animated.spring(slideAnim, {
        toValue: s !== 'online' ? 0 : -48,
        useNativeDriver: true, tension: 80, friction: 12,
      }).start();
    });
    return unsub;
  }, []);

  const bg    = netState === 'offline' ? '#EF4444' : '#F59E0B';
  const label = netState === 'offline' ? '📵 No internet connection' : '⚠️ Weak connection — messages may delay';

  return (
    <Animated.View style={{
      position:'absolute', top:0, left:0, right:0, zIndex:999,
      backgroundColor: bg, paddingVertical:8, paddingHorizontal:16,
      transform:[{translateY:slideAnim}],
    }}>
      <Text style={{ color:'#fff', fontSize:12, fontWeight:'800', textAlign:'center' }}>
        {label}
      </Text>
    </Animated.View>
  );
}

