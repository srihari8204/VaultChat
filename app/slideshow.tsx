// app/slideshow.tsx
// Slideshow viewer for multiple images — swipe through with transitions

import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useRef, useState } from 'react';
import {
  Alert, Dimensions, FlatList, Image, StyleSheet,
  Text, TouchableOpacity, View,
} from 'react-native';

const { width: SW, height: SH } = Dimensions.get('window');

export default function SlideshowScreen() {
  const router = useRouter();
  const { images: imagesParam, startIndex: startParam } = useLocalSearchParams<{
    images: string; startIndex?: string;
  }>();

  const imageList: string[] = imagesParam ? JSON.parse(imagesParam) : [];
  const startIdx = parseInt(startParam || '0');

  const [currentIndex, setCurrentIndex] = useState(startIdx);
  const [showControls, setShowControls] = useState(true);
  const [autoplay, setAutoplay] = useState(false);
  const flatRef = useRef<FlatList>(null);
  const autoplayTimer = useRef<any>(null);

  const goTo = (idx: number) => {
    if (idx >= 0 && idx < imageList.length) {
      flatRef.current?.scrollToIndex({ index: idx, animated: true });
      setCurrentIndex(idx);
    }
  };

  const toggleAutoplay = () => {
    if (autoplay) {
      clearInterval(autoplayTimer.current);
      setAutoplay(false);
    } else {
      setAutoplay(true);
      autoplayTimer.current = setInterval(() => {
        setCurrentIndex(prev => {
          const next = (prev + 1) % imageList.length;
          flatRef.current?.scrollToIndex({ index: next, animated: true });
          return next;
        });
      }, 3000);
    }
  };

  const saveToGallery = async () => {
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') { Alert.alert('Permission needed'); return; }
      await MediaLibrary.saveToLibraryAsync(imageList[currentIndex]);
      Alert.alert('Saved!', 'Image saved to your gallery');
    } catch { Alert.alert('Error', 'Could not save image'); }
  };

  const shareImage = async () => {
    try {
      await Sharing.shareAsync(imageList[currentIndex]);
    } catch {}
  };

  const renderImage = ({ item }: { item: string }) => (
    <TouchableOpacity
      activeOpacity={1}
      onPress={() => setShowControls(p => !p)}
      style={{ width: SW, height: SH, justifyContent: 'center', alignItems: 'center' }}
    >
      <Image
        source={{ uri: item }}
        style={{ width: SW, height: SW * 1.2 }}
        resizeMode="contain"
      />
    </TouchableOpacity>
  );

  if (imageList.length === 0) {
    return (
      <View style={[st.screen, { justifyContent: 'center', alignItems: 'center' }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Text style={{ color: '#fff', fontSize: 18 }}>No images</Text>
        <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 20 }}>
          <Text style={{ color: '#4A9FFF' }}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={st.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      <FlatList
        ref={flatRef}
        data={imageList}
        keyExtractor={(_, i) => i.toString()}
        renderItem={renderImage}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        initialScrollIndex={startIdx}
        getItemLayout={(_, i) => ({ length: SW, offset: SW * i, index: i })}
        onMomentumScrollEnd={e => {
          const idx = Math.round(e.nativeEvent.contentOffset.x / SW);
          setCurrentIndex(idx);
        }}
      />

      {/* Top bar */}
      {showControls && (
        <View style={st.topBar}>
          <TouchableOpacity onPress={() => { clearInterval(autoplayTimer.current); router.back(); }} style={st.topBtn}>
            <Text style={{ color: '#fff', fontSize: 20 }}>✕</Text>
          </TouchableOpacity>
          <Text style={st.counter}>{currentIndex + 1} / {imageList.length}</Text>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <TouchableOpacity onPress={shareImage} style={st.topBtn}>
              <Text style={{ fontSize: 18 }}>📤</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={saveToGallery} style={st.topBtn}>
              <Text style={{ fontSize: 18 }}>💾</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Bottom controls */}
      {showControls && (
        <View style={st.bottomBar}>
          {/* Thumbnail strip */}
          <FlatList
            data={imageList}
            keyExtractor={(_, i) => 'thumb' + i}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 16, gap: 8, marginBottom: 12 }}
            renderItem={({ item, index }) => (
              <TouchableOpacity onPress={() => goTo(index)}>
                <Image
                  source={{ uri: item }}
                  style={[st.thumb, currentIndex === index && st.thumbActive]}
                />
              </TouchableOpacity>
            )}
          />

          {/* Controls row */}
          <View style={st.controlRow}>
            <TouchableOpacity onPress={() => goTo(currentIndex - 1)} disabled={currentIndex === 0} style={st.navBtn}>
              <Text style={[st.navTxt, currentIndex === 0 && { opacity: 0.3 }]}>◀ Prev</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={toggleAutoplay} style={[st.autoBtn, autoplay && st.autoBtnActive]}>
              <Text style={{ color: autoplay ? '#000' : '#4A9FFF', fontWeight: '800', fontSize: 13 }}>
                {autoplay ? '⏸ Stop' : '▶ Slideshow'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={() => goTo(currentIndex + 1)} disabled={currentIndex === imageList.length - 1} style={st.navBtn}>
              <Text style={[st.navTxt, currentIndex === imageList.length - 1 && { opacity: 0.3 }]}>Next ▶</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Dots indicator */}
      {showControls && imageList.length <= 20 && (
        <View style={st.dots}>
          {imageList.map((_, i) => (
            <View key={i} style={[st.dot, currentIndex === i && st.dotActive]} />
          ))}
        </View>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  topBar: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 50, paddingHorizontal: 16, paddingBottom: 12, backgroundColor: 'rgba(0,0,0,0.6)' },
  topBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.1)', justifyContent: 'center', alignItems: 'center' },
  counter: { color: '#fff', fontSize: 16, fontWeight: '700' },
  bottomBar: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingBottom: 36, backgroundColor: 'rgba(0,0,0,0.7)' },
  thumb: { width: 50, height: 50, borderRadius: 8, borderWidth: 2, borderColor: 'transparent' },
  thumbActive: { borderColor: '#4A9FFF' },
  controlRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20 },
  navBtn: { paddingHorizontal: 16, paddingVertical: 10 },
  navTxt: { color: '#fff', fontSize: 14, fontWeight: '600' },
  autoBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20, borderWidth: 1, borderColor: '#4A9FFF', backgroundColor: 'rgba(0,229,255,0.1)' },
  autoBtnActive: { backgroundColor: '#4A9FFF', borderColor: '#4A9FFF' },
  dots: { position: 'absolute', bottom: 130, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.3)' },
  dotActive: { backgroundColor: '#4A9FFF', width: 18, borderRadius: 3 },
});
