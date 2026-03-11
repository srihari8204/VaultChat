import AsyncStorage from '@react-native-async-storage/async-storage';

export interface TypingPattern {
  avgSpeed: number;
  rhythm: number[];
  pausePattern: number[];
  errorRate: number;
  sessionCount: number;
}

export interface BehaviorAlert {
  id: string;
  type: 'imposter' | 'unusual' | 'safe';
  confidence: number;
  message: string;
  timestamp: number;
}

const PATTERN_KEY = 'vaultchat_typing_pattern';
const ALERTS_KEY = 'vaultchat_behavior_alerts';
const keyTimings: number[] = [];
let lastKeyTime = 0;

export const recordKeystroke = (): void => {
  const now = Date.now();
  if (lastKeyTime > 0) {
    const gap = now - lastKeyTime;
    if (gap > 0 && gap < 5000) {
      keyTimings.push(gap);
      if (keyTimings.length > 100) keyTimings.shift();
    }
  }
  lastKeyTime = now;
};

export const analyzeTypingPattern = async (): Promise<BehaviorAlert> => {
  if (keyTimings.length < 5) {
    return { id: Date.now().toString(), type: 'safe', confidence: 50, message: 'Learning your typing pattern...', timestamp: Date.now() };
  }
  const avg = keyTimings.reduce((a, b) => a + b, 0) / keyTimings.length;
  const stored = await loadTypingPattern();
  if (!stored) {
    const pattern: TypingPattern = { avgSpeed: avg, rhythm: keyTimings.slice(-20), pausePattern: keyTimings.filter(t => t > 500), errorRate: 0, sessionCount: 1 };
    await saveTypingPattern(pattern);
    return { id: Date.now().toString(), type: 'safe', confidence: 80, message: 'Baseline typing pattern established', timestamp: Date.now() };
  }
  const speedDiff = Math.abs(avg - stored.avgSpeed) / stored.avgSpeed;
  const rhythmScore = speedDiff * 100;
  let alertType: 'imposter' | 'unusual' | 'safe' = 'safe';
  let confidence = 0;
  let message = '';
  if (rhythmScore > 60) {
    alertType = 'imposter';
    confidence = Math.min(95, rhythmScore);
    message = 'WARNING: Typing pattern does not match your profile!';
  } else if (rhythmScore > 30) {
    alertType = 'unusual';
    confidence = rhythmScore;
    message = 'Unusual typing pattern detected.';
  } else {
    alertType = 'safe';
    confidence = 100 - rhythmScore;
    message = 'Typing pattern matches your profile.';
  }
  const alert: BehaviorAlert = { id: Date.now().toString(), type: alertType, confidence: Math.floor(confidence), message, timestamp: Date.now() };
  await saveAlert(alert);
  const updatedPattern: TypingPattern = { avgSpeed: (stored.avgSpeed * stored.sessionCount + avg) / (stored.sessionCount + 1), rhythm: keyTimings.slice(-20), pausePattern: keyTimings.filter(t => t > 500), errorRate: stored.errorRate, sessionCount: stored.sessionCount + 1 };
  await saveTypingPattern(updatedPattern);
  return alert;
};

export const loadTypingPattern = async (): Promise<TypingPattern | null> => {
  try { const data = await AsyncStorage.getItem(PATTERN_KEY); return data ? JSON.parse(data) : null; } catch (e) { return null; }
};

export const saveTypingPattern = async (pattern: TypingPattern): Promise<void> => {
  await AsyncStorage.setItem(PATTERN_KEY, JSON.stringify(pattern));
};

export const saveAlert = async (alert: BehaviorAlert): Promise<void> => {
  try {
    const data = await AsyncStorage.getItem(ALERTS_KEY);
    const alerts = data ? JSON.parse(data) : [];
    alerts.unshift(alert);
    await AsyncStorage.setItem(ALERTS_KEY, JSON.stringify(alerts.slice(0, 20)));
  } catch (e) {}
};

export const loadAlerts = async (): Promise<BehaviorAlert[]> => {
  try { const data = await AsyncStorage.getItem(ALERTS_KEY); return data ? JSON.parse(data) : []; } catch (e) { return []; }
};

export const resetPattern = async (): Promise<void> => {
  await AsyncStorage.removeItem(PATTERN_KEY);
  await AsyncStorage.removeItem(ALERTS_KEY);
  keyTimings.length = 0;
  lastKeyTime = 0;
};

export const getAlertColor = (type: string): string => {
  switch (type) {
    case 'imposter': return '#EF4444';
    case 'unusual': return '#F59E0B';
    case 'safe': return '#10B981';
    default: return '#6B7280';
  }
};

export const getAlertIcon = (type: string): string => {
  switch (type) {
    case 'imposter': return 'IMPOSTER ALERT';
    case 'unusual': return 'UNUSUAL PATTERN';
    case 'safe': return 'IDENTITY VERIFIED';
    default: return 'ANALYZING';
  }
};
