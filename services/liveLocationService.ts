// services/liveLocationService.ts
// Mutual Live Location — both users see each other on the same map
// Stores location in Firestore under liveLocations/{sessionId}
// Calculates distance between users in real-time

import firestore from '@react-native-firebase/firestore';
import auth from '@react-native-firebase/auth';
import * as Location from 'expo-location';

export interface LiveLocationData {
  uid: string;
  latitude: number;
  longitude: number;
  altitude?: number | null;
  accuracy?: number | null;
  heading?: number | null;
  speed?: number | null;
  timestamp: number;
  name?: string;
}

// Start sharing live location to a session
export async function startLiveLocationSession(chatId: string, peerUid: string): Promise<string> {
  const uid = auth().currentUser?.uid;
  if (!uid) throw new Error('Not authenticated');

  // Session ID is deterministic — both users share the same session
  const sessionId = [uid, peerUid].sort().join('_');

  await firestore().collection('liveLocations').doc(sessionId).set({
    participants: [uid, peerUid],
    chatId,
    startedAt: firestore.FieldValue.serverTimestamp(),
    active: true,
  }, { merge: true });

  return sessionId;
}

// Update my location in the session
export async function updateMyLocation(
  sessionId: string,
  location: Location.LocationObject,
  name?: string,
): Promise<void> {
  const uid = auth().currentUser?.uid;
  if (!uid) return;

  await firestore().collection('liveLocations').doc(sessionId)
    .collection('positions').doc(uid).set({
      uid,
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      altitude: location.coords.altitude,
      accuracy: location.coords.accuracy,
      heading: location.coords.heading,
      speed: location.coords.speed,
      timestamp: Date.now(),
      name: name ?? '',
    });
}

// Listen to peer's location updates
export function onPeerLocationUpdate(
  sessionId: string,
  peerUid: string,
  callback: (data: LiveLocationData | null) => void,
): () => void {
  return firestore().collection('liveLocations').doc(sessionId)
    .collection('positions').doc(peerUid)
    .onSnapshot(snap => {
      if (snap.exists) {
        callback(snap.data() as LiveLocationData);
      } else {
        callback(null);
      }
    });
}

// Stop live location session
export async function stopLiveLocationSession(sessionId: string): Promise<void> {
  const uid = auth().currentUser?.uid;
  if (!uid) return;

  // Remove my position
  await firestore().collection('liveLocations').doc(sessionId)
    .collection('positions').doc(uid).delete().catch(() => {});

  // Check if both positions are gone, then delete session
  const positions = await firestore().collection('liveLocations').doc(sessionId)
    .collection('positions').get();

  if (positions.empty) {
    await firestore().collection('liveLocations').doc(sessionId).delete().catch(() => {});
  } else {
    // Mark as inactive for this user
    await firestore().collection('liveLocations').doc(sessionId).update({
      active: false,
    }).catch(() => {});
  }
}

// Calculate distance between two coordinates (Haversine formula)
export function calculateDistance(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): { km: number; mi: number; meters: number } {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const km = R * c;
  return {
    km: Math.round(km * 100) / 100,
    mi: Math.round(km * 0.621371 * 100) / 100,
    meters: Math.round(km * 1000),
  };
}

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}

// Format distance for display
export function formatDistance(meters: number): string {
  if (meters < 100) return `${meters}m away`;
  if (meters < 1000) return `${Math.round(meters / 10) * 10}m away`;
  const km = meters / 1000;
  if (km < 10) return `${km.toFixed(1)}km away`;
  return `${Math.round(km)}km away`;
}

// Estimate travel time
export function estimateETA(meters: number, mode: 'walking' | 'driving' | 'transit'): string {
  const speeds: Record<string, number> = { walking: 5, driving: 40, transit: 25 }; // km/h
  const km = meters / 1000;
  const hours = km / speeds[mode];
  const mins = Math.round(hours * 60);
  if (mins < 1) return '< 1 min';
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
