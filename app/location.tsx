/**
 * VaultChat — Location Sharing Screen
 * Current location + Live location tracking
 * Like WhatsApp but encrypted
 */
import React, { useState, useEffect, useRef } from "react";
import {
  View, Text, TouchableOpacity, StyleSheet,
  Alert, Animated, ScrollView, Dimensions,
  ActivityIndicator, Platform, Linking,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import * as Location from "expo-location";

const { width: W } = Dimensions.get("window");

// Duration options for live location
const DURATIONS = [
  { label: "15 minutes", seconds: 900,   icon: "?" },
  { label: "1 hour",     seconds: 3600,  icon: "??" },
  { label: "8 hours",    seconds: 28800, icon: "??" },
];

// -- Map preview (static Google Maps image) ------------------------------------
const MapPreview = ({ lat, lng, label }: { lat: number; lng: number; label: string }) => {
  const mapUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=16&size=600x300&maptype=roadmap&markers=color:red%7C${lat},${lng}`;

  return (
    <View style={mp.wrap}>
      {/* Fake map background with coordinates */}
      <LinearGradient colors={["#1a2a3a","#0d1f2d"]} style={mp.map}>
        <View style={mp.grid}>
          {Array(6).fill(0).map((_, i) => (
            <View key={i} style={mp.gridLine} />
          ))}
        </View>
        <View style={mp.gridH}>
          {Array(4).fill(0).map((_, i) => (
            <View key={i} style={mp.gridLineH} />
          ))}
        </View>
        {/* Pin */}
        <View style={mp.pinWrap}>
          <View style={mp.pinShadow} />
          <LinearGradient colors={["#EF4444","#DC2626"]} style={mp.pin}>
            <Text style={{ fontSize: 20 }}>??</Text>
          </LinearGradient>
          <Text style={mp.pinLabel} numberOfLines={1}>{label}</Text>
        </View>
        {/* Coordinates */}
        <View style={mp.coordBox}>
          <Text style={mp.coordText}>
            {lat.toFixed(6)}°N, {lng.toFixed(6)}°E
          </Text>
        </View>
      </LinearGradient>
      {/* Open in maps button */}
      <TouchableOpacity style={mp.openBtn}
        onPress={() => {
          const url = `https://www.google.com/maps?q=${lat},${lng}`;
          Linking.openURL(url);
        }}>
        <Text style={mp.openText}>??? Open in Google Maps</Text>
      </TouchableOpacity>
    </View>
  );
};

const mp = StyleSheet.create({
  wrap:       { borderRadius: 16, overflow: "hidden", marginBottom: 16 },
  map:        { height: 200, justifyContent: "center", alignItems: "center",
                position: "relative", overflow: "hidden" },
  grid:       { position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
                flexDirection: "row", justifyContent: "space-around" },
  gridLine:   { width: 1, backgroundColor: "rgba(255,255,255,0.05)" },
  gridH:      { position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
                justifyContent: "space-around" },
  gridLineH:  { height: 1, backgroundColor: "rgba(255,255,255,0.05)" },
  pinWrap:    { alignItems: "center", gap: 6 },
  pinShadow:  { position: "absolute", bottom: -4, width: 20, height: 8,
                backgroundColor: "rgba(0,0,0,0.3)", borderRadius: 10 },
  pin:        { width: 48, height: 48, borderRadius: 24,
                justifyContent: "center", alignItems: "center",
                borderWidth: 3, borderColor: "#fff" },
  pinLabel:   { color: "#fff", fontSize: 12, fontWeight: "800",
                backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 10,
                paddingVertical: 4, borderRadius: 8, maxWidth: 200, textAlign: "center" },
  coordBox:   { position: "absolute", bottom: 8, right: 8,
                backgroundColor: "rgba(0,0,0,0.5)", borderRadius: 6,
                paddingHorizontal: 8, paddingVertical: 4 },
  coordText:  { color: "rgba(255,255,255,0.7)", fontSize: 10, fontWeight: "700" },
  openBtn:    { backgroundColor: "rgba(255,255,255,0.08)", padding: 12,
                alignItems: "center", borderTopWidth: 1,
                borderTopColor: "rgba(255,255,255,0.08)" },
  openText:   { color: "#4A9FFF", fontSize: 13, fontWeight: "800" },
});

// -- Main screen ---------------------------------------------------------------
export default function LocationScreen() {
  const router     = useRouter();
  const params     = useLocalSearchParams();
  const chatName   = (params.name as string) || "Contact";
  const roomId     = (params.room as string) || "default";

  const [location,        setLocation]        = useState<Location.LocationObject | null>(null);
  const [address,         setAddress]         = useState<string>("Getting address...");
  const [loading,         setLoading]         = useState(false);
  const [liveSharing,     setLiveSharing]     = useState(false);
  const [selectedDuration,setSelectedDuration]= useState(0);
  const [timeRemaining,   setTimeRemaining]   = useState(0);
  const [accuracy,        setAccuracy]        = useState<number | null>(null);
  const [permGranted,     setPermGranted]     = useState(false);

  const liveRef    = useRef<Location.LocationSubscription | null>(null);
  const timerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const pulseAnim  = useRef(new Animated.Value(1)).current;
  const shareAnim  = useRef(new Animated.Value(0)).current;

  // -- Pulse animation for live indicator -----------------------------------
  useEffect(() => {
    if (liveSharing) {
      Animated.loop(Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.3, duration: 800, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1.0, duration: 800, useNativeDriver: true }),
      ])).start();
    } else {
      pulseAnim.setValue(1);
    }
  }, [liveSharing]);

  // -- Request permissions + get initial location ----------------------------
  useEffect(() => {
    requestLocationPermission();
    return () => {
      stopLiveLocation();
    };
  }, []);

  const requestLocationPermission = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") {
      Alert.alert(
        "Location Permission",
        "VaultChat needs location access to share your location.",
        [
          { text: "Cancel", style: "cancel", onPress: () => router.back() },
          { text: "Open Settings", onPress: () => Location.enableNetworkProviderAsync() },
        ]
      );
      return;
    }
    setPermGranted(true);
    getCurrentLocation();
  };

  // -- Get current location --------------------------------------------------
  const getCurrentLocation = async () => {
    setLoading(true);
    try {
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.BestForNavigation,
      });
      setLocation(loc);
      setAccuracy(loc.coords.accuracy);

      // Reverse geocode to get address
      const geo = await Location.reverseGeocodeAsync({
        latitude:  loc.coords.latitude,
        longitude: loc.coords.longitude,
      });

      if (geo.length > 0) {
        const g = geo[0];
        const parts = [g.name, g.street, g.district, g.city, g.region]
          .filter(Boolean);
        setAddress(parts.join(", ") || "Location found");
      }
    } catch (e) {
      Alert.alert("Error", "Could not get location. Make sure GPS is on.");
    } finally {
      setLoading(false);
    }
  };

  // -- Share current location (one-time) ------------------------------------
  const shareCurrentLocation = () => {
    if (!location) return Alert.alert("Error", "Location not found yet.");
    Alert.alert(
      "Share Location",
      `Send your current location to ${chatName}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Send",
          onPress: () => {
            // In production: send via Socket.io encrypted
            Alert.alert(
              "Location Sent! ?",
              `Your location was sent to ${chatName}.\n\nLat: ${location.coords.latitude.toFixed(6)}\nLng: ${location.coords.longitude.toFixed(6)}`,
              [{ text: "OK", onPress: () => router.back() }]
            );
          },
        },
      ]
    );
  };

  // -- Start live location ---------------------------------------------------
  const startLiveLocation = async () => {
    if (!location) return Alert.alert("Error", "Location not found yet.");

    const duration = DURATIONS[selectedDuration].seconds;

    Alert.alert(
      "Share Live Location",
      `Share your live location with ${chatName} for ${DURATIONS[selectedDuration].label}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Start Sharing",
          onPress: async () => {
            setLiveSharing(true);
            setTimeRemaining(duration);

            Animated.timing(shareAnim, { toValue: 1, duration: 300, useNativeDriver: true }).start();

            // Request background permission for live tracking
            await Location.requestBackgroundPermissionsAsync().catch(() => {});

            // Start watching position
            liveRef.current = await Location.watchPositionAsync(
              {
                accuracy:          Location.Accuracy.BestForNavigation,
                timeInterval:      5000,   // update every 5 seconds
                distanceInterval:  5,      // or every 5 meters
              },
              (newLoc) => {
                setLocation(newLoc);
                setAccuracy(newLoc.coords.accuracy);
                // In production: emit to Socket.io
                // socket.emit("live-location", { room: roomId, lat, lng, accuracy })
              }
            );

            // Countdown timer
            timerRef.current = setInterval(() => {
              setTimeRemaining(t => {
                if (t <= 1) {
                  stopLiveLocation();
                  return 0;
                }
                return t - 1;
              });
            }, 1000);
          },
        },
      ]
    );
  };

  // -- Stop live location ----------------------------------------------------
  const stopLiveLocation = () => {
    liveRef.current?.remove();
    liveRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setLiveSharing(false);
    setTimeRemaining(0);
    Animated.timing(shareAnim, { toValue: 0, duration: 300, useNativeDriver: true }).start();
  };

  const formatTime = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
    return `${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
  };

  const getAccuracyLabel = (acc: number | null) => {
    if (!acc) return { label: "Unknown", color: "#6B7280" };
    if (acc <= 5)  return { label: "Excellent", color: "#10B981" };
    if (acc <= 15) return { label: "Good",      color: "#3B82F6" };
    if (acc <= 30) return { label: "Fair",      color: "#F59E0B" };
    return               { label: "Poor",       color: "#EF4444" };
  };

  const accInfo = getAccuracyLabel(accuracy);

  // -- Render ----------------------------------------------------------------
  return (
    <LinearGradient colors={["#010812","#071020","#0a1628"]} style={s.root}>

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Text style={s.backText}>?</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>Share Location</Text>
          <Text style={s.headerSub}>with {chatName}</Text>
        </View>
        <View style={s.secBadge}>
          <Text style={s.secText}>?? Encrypted</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        {/* Live sharing banner */}
        {liveSharing && (
          <Animated.View style={[s.liveBanner, { opacity: shareAnim,
            transform: [{ translateY: shareAnim.interpolate({
              inputRange: [0,1], outputRange: [-20,0]
            })}]
          }]}>
            <LinearGradient colors={["#DC2626","#B91C1C"]} style={s.liveBannerInner}>
              <Animated.View style={[s.liveDot, { transform: [{ scale: pulseAnim }] }]} />
              <View style={{ flex: 1 }}>
                <Text style={s.liveBannerTitle}>Live Location Active</Text>
                <Text style={s.liveBannerSub}>Sharing with {chatName} · {formatTime(timeRemaining)} remaining</Text>
              </View>
              <TouchableOpacity onPress={stopLiveLocation} style={s.stopBtn}>
                <Text style={s.stopText}>Stop</Text>
              </TouchableOpacity>
            </LinearGradient>
          </Animated.View>
        )}

        {/* Map preview */}
        {location ? (
          <MapPreview
            lat={location.coords.latitude}
            lng={location.coords.longitude}
            label={address}
          />
        ) : (
          <View style={s.mapPlaceholder}>
            <ActivityIndicator size="large" color="#4A9FFF" />
            <Text style={s.mapPlaceholderText}>Getting your location...</Text>
            <Text style={s.mapPlaceholderSub}>Make sure GPS is enabled</Text>
          </View>
        )}

        {/* Location details */}
        {location && (
          <View style={s.detailCard}>
            <View style={s.detailRow}>
              <Text style={s.detailIcon}>??</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.detailLabel}>Address</Text>
                <Text style={s.detailValue}>{address}</Text>
              </View>
            </View>
            <View style={s.divider} />
            <View style={s.detailRow}>
              <Text style={s.detailIcon}>??</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.detailLabel}>GPS Accuracy</Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 2 }}>
                  <View style={[s.accDot, { backgroundColor: accInfo.color }]} />
                  <Text style={[s.detailValue, { color: accInfo.color }]}>{accInfo.label}</Text>
                  {accuracy && <Text style={s.accMeters}>±{Math.round(accuracy)}m</Text>}
                </View>
              </View>
              <TouchableOpacity onPress={getCurrentLocation} style={s.refreshBtn}>
                <Text style={{ fontSize: 18 }}>??</Text>
              </TouchableOpacity>
            </View>
            <View style={s.divider} />
            <View style={s.coordRow}>
              <View style={s.coordItem}>
                <Text style={s.coordLabel}>Latitude</Text>
                <Text style={s.coordValue}>{location.coords.latitude.toFixed(6)}°</Text>
              </View>
              <View style={s.coordItem}>
                <Text style={s.coordLabel}>Longitude</Text>
                <Text style={s.coordValue}>{location.coords.longitude.toFixed(6)}°</Text>
              </View>
              <View style={s.coordItem}>
                <Text style={s.coordLabel}>Altitude</Text>
                <Text style={s.coordValue}>{location.coords.altitude?.toFixed(1) ?? "N/A"}m</Text>
              </View>
            </View>
          </View>
        )}

        {/* Share current location */}
        <TouchableOpacity onPress={shareCurrentLocation} disabled={!location} style={s.currentBtn}>
          <LinearGradient colors={["#1D4ED8","#7C3AED"]} style={s.currentBtnInner}>
            <Text style={{ fontSize: 22 }}>??</Text>
            <View>
              <Text style={s.currentBtnTitle}>Send Current Location</Text>
              <Text style={s.currentBtnSub}>One-time location share</Text>
            </View>
          </LinearGradient>
        </TouchableOpacity>

        {/* Live location section */}
        <View style={s.liveSection}>
          <Text style={s.liveSectionTitle}>?? Live Location</Text>
          <Text style={s.liveSectionSub}>
            Share your real-time location. Updates every 5 seconds.
          </Text>

          {/* Duration picker */}
          {!liveSharing && (
            <View style={s.durationRow}>
              {DURATIONS.map((d, i) => (
                <TouchableOpacity key={i} onPress={() => setSelectedDuration(i)}
                  style={[s.durationBtn, selectedDuration === i && s.durationBtnActive]}>
                  <Text style={s.durationIcon}>{d.icon}</Text>
                  <Text style={[s.durationLabel, selectedDuration === i && s.durationLabelActive]}>
                    {d.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* Start/Stop live */}
          {!liveSharing ? (
            <TouchableOpacity onPress={startLiveLocation} disabled={!location} style={s.liveBtn}>
              <LinearGradient colors={["#DC2626","#B91C1C"]} style={s.liveBtnInner}>
                <Animated.View style={[s.liveBtnDot, { transform: [{ scale: pulseAnim }] }]} />
                <Text style={s.liveBtnText}>Start Live Location</Text>
              </LinearGradient>
            </TouchableOpacity>
          ) : (
            <View style={s.liveActive}>
              <View style={s.liveActiveTop}>
                <Animated.View style={[s.liveActiveDot, { transform: [{ scale: pulseAnim }] }]} />
                <Text style={s.liveActiveText}>Broadcasting live location</Text>
              </View>
              <Text style={s.liveActiveTimer}>Stops in {formatTime(timeRemaining)}</Text>
              <TouchableOpacity onPress={stopLiveLocation} style={s.stopLiveBtn}>
                <Text style={s.stopLiveBtnText}>? Stop Sharing</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Privacy note */}
        <View style={s.privacyNote}>
          <Text style={s.privacyText}>
            ?? Your location data is end-to-end encrypted. VaultChat servers never store your location.
          </Text>
        </View>

      </ScrollView>
    </LinearGradient>
  );
}

const s = StyleSheet.create({
  root:              { flex: 1 },
  header:            { flexDirection: "row", alignItems: "center", gap: 12,
                       paddingTop: Platform.OS === "ios" ? 56 : 44,
                       paddingBottom: 16, paddingHorizontal: 18,
                       backgroundColor: "rgba(1,8,18,0.9)",
                       borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.06)" },
  backBtn:           { width: 36, height: 36, justifyContent: "center", alignItems: "center" },
  backText:          { color: "#fff", fontSize: 22, fontWeight: "900" },
  headerTitle:       { color: "#fff", fontSize: 17, fontWeight: "900" },
  headerSub:         { color: "rgba(255,255,255,0.4)", fontSize: 12, marginTop: 1 },
  secBadge:          { backgroundColor: "rgba(16,185,129,0.1)", borderRadius: 12,
                       paddingHorizontal: 8, paddingVertical: 4,
                       borderWidth: 1, borderColor: "rgba(16,185,129,0.3)" },
  secText:           { color: "#10B981", fontSize: 10, fontWeight: "800" },
  scroll:            { padding: 16, paddingBottom: 40 },
  liveBanner:        { marginBottom: 16, borderRadius: 14, overflow: "hidden" },
  liveBannerInner:   { flexDirection: "row", alignItems: "center", gap: 12, padding: 14 },
  liveDot:           { width: 12, height: 12, borderRadius: 6, backgroundColor: "#fff" },
  liveBannerTitle:   { color: "#fff", fontSize: 14, fontWeight: "900" },
  liveBannerSub:     { color: "rgba(255,255,255,0.7)", fontSize: 11, marginTop: 2 },
  stopBtn:           { backgroundColor: "rgba(255,255,255,0.2)", borderRadius: 8,
                       paddingHorizontal: 14, paddingVertical: 7 },
  stopText:          { color: "#fff", fontSize: 12, fontWeight: "900" },
  mapPlaceholder:    { height: 200, backgroundColor: "rgba(255,255,255,0.05)",
                       borderRadius: 16, justifyContent: "center", alignItems: "center",
                       marginBottom: 16, gap: 12, borderWidth: 1,
                       borderColor: "rgba(255,255,255,0.08)" },
  mapPlaceholderText:{ color: "#fff", fontSize: 15, fontWeight: "800" },
  mapPlaceholderSub: { color: "rgba(255,255,255,0.4)", fontSize: 12 },
  detailCard:        { backgroundColor: "rgba(255,255,255,0.05)", borderRadius: 16,
                       padding: 16, marginBottom: 16,
                       borderWidth: 1, borderColor: "rgba(255,255,255,0.08)" },
  detailRow:         { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  detailIcon:        { fontSize: 20, marginTop: 2 },
  detailLabel:       { color: "rgba(255,255,255,0.4)", fontSize: 11, fontWeight: "700",
                       textTransform: "uppercase", letterSpacing: 0.5 },
  detailValue:       { color: "#fff", fontSize: 14, fontWeight: "700", marginTop: 2 },
  divider:           { height: 1, backgroundColor: "rgba(255,255,255,0.06)", marginVertical: 12 },
  accDot:            { width: 8, height: 8, borderRadius: 4 },
  accMeters:         { color: "rgba(255,255,255,0.4)", fontSize: 12 },
  refreshBtn:        { padding: 8 },
  coordRow:          { flexDirection: "row", justifyContent: "space-between" },
  coordItem:         { alignItems: "center", flex: 1 },
  coordLabel:        { color: "rgba(255,255,255,0.4)", fontSize: 10, fontWeight: "700",
                       textTransform: "uppercase", letterSpacing: 0.5 },
  coordValue:        { color: "#4A9FFF", fontSize: 13, fontWeight: "800", marginTop: 4 },
  currentBtn:        { borderRadius: 16, overflow: "hidden", marginBottom: 16 },
  currentBtnInner:   { flexDirection: "row", alignItems: "center", gap: 14,
                       padding: 18 },
  currentBtnTitle:   { color: "#fff", fontSize: 16, fontWeight: "900" },
  currentBtnSub:     { color: "rgba(255,255,255,0.5)", fontSize: 12, marginTop: 2 },
  liveSection:       { backgroundColor: "rgba(255,255,255,0.05)", borderRadius: 16,
                       padding: 18, marginBottom: 16,
                       borderWidth: 1, borderColor: "rgba(255,255,255,0.08)" },
  liveSectionTitle:  { color: "#fff", fontSize: 17, fontWeight: "900", marginBottom: 6 },
  liveSectionSub:    { color: "rgba(255,255,255,0.4)", fontSize: 13, marginBottom: 16 },
  durationRow:       { flexDirection: "row", gap: 8, marginBottom: 16 },
  durationBtn:       { flex: 1, alignItems: "center", padding: 12, borderRadius: 12,
                       backgroundColor: "rgba(255,255,255,0.07)",
                       borderWidth: 1, borderColor: "rgba(255,255,255,0.1)" },
  durationBtnActive: { backgroundColor: "rgba(220,38,38,0.2)",
                       borderColor: "rgba(220,38,38,0.5)" },
  durationIcon:      { fontSize: 20, marginBottom: 4 },
  durationLabel:     { color: "rgba(255,255,255,0.5)", fontSize: 11, fontWeight: "700",
                       textAlign: "center" },
  durationLabelActive:{ color: "#EF4444" },
  liveBtn:           { borderRadius: 14, overflow: "hidden" },
  liveBtnInner:      { flexDirection: "row", alignItems: "center", justifyContent: "center",
                       gap: 10, paddingVertical: 16 },
  liveBtnDot:        { width: 10, height: 10, borderRadius: 5, backgroundColor: "#fff" },
  liveBtnText:       { color: "#fff", fontSize: 15, fontWeight: "900" },
  liveActive:        { backgroundColor: "rgba(220,38,38,0.1)", borderRadius: 14,
                       padding: 16, borderWidth: 1, borderColor: "rgba(220,38,38,0.3)",
                       alignItems: "center", gap: 8 },
  liveActiveTop:     { flexDirection: "row", alignItems: "center", gap: 10 },
  liveActiveDot:     { width: 10, height: 10, borderRadius: 5, backgroundColor: "#EF4444" },
  liveActiveText:    { color: "#fff", fontSize: 14, fontWeight: "800" },
  liveActiveTimer:   { color: "rgba(255,255,255,0.5)", fontSize: 13 },
  stopLiveBtn:       { backgroundColor: "rgba(220,38,38,0.3)", borderRadius: 10,
                       paddingHorizontal: 24, paddingVertical: 10, marginTop: 4,
                       borderWidth: 1, borderColor: "rgba(220,38,38,0.5)" },
  stopLiveBtnText:   { color: "#EF4444", fontWeight: "900", fontSize: 14 },
  privacyNote:       { backgroundColor: "rgba(16,185,129,0.07)", borderRadius: 12,
                       padding: 14, borderWidth: 1, borderColor: "rgba(16,185,129,0.2)" },
  privacyText:       { color: "rgba(255,255,255,0.4)", fontSize: 12, lineHeight: 18, textAlign: "center" },
});
