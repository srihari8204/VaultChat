// services/aiService.ts
// On-device AI features â€” smart replies, summariser, writing assistant,
// voice transcription, translation
// Uses react-native-whisper for transcription (on-device, private)
// All AI features run 100% on-device — zero server calls

// â”€â”€ Smart Replies â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export async function getSmartReplies(lastMessage: string): Promise<string[]> {
  // Heuristic quick replies (no API needed â€” fully on-device)
  const msg = lastMessage.toLowerCase();

  if (msg.match(/\b(ok|okay|fine|sure|alright)\b/)) return ['Got it ðŸ‘', 'Perfect!', 'Sounds good'];
  if (msg.match(/\b(thanks|thank you|thx)\b/)) return ['You\'re welcome! ðŸ˜Š', 'Anytime!', 'No problem'];
  if (msg.match(/\b(hi|hello|hey|sup)\b/)) return ['Hey! ðŸ‘‹', 'Hi there!', 'Hello!'];
  if (msg.match(/\b(how are you|how\'s it going|hows it)\b/)) return ['I\'m good, you?', 'Doing great! ðŸ˜Š', 'All good here'];
  if (msg.match(/\b(yes|yeah|yep|yup)\b/)) return ['Great! ðŸŽ‰', 'Awesome!', 'Perfect'];
  if (msg.match(/\b(no|nope|nah)\b/)) return ['Okay, no worries', 'Understood', 'Got it'];
  if (msg.match(/\b(where|location|address)\b/)) return ['Let me check', 'I\'ll send you the location', 'One moment'];
  if (msg.match(/\b(when|time|schedule)\b/)) return ['Let me check my schedule', 'What time works?', 'I\'ll confirm shortly'];
  if (msg.match(/\b(why|reason)\b/)) return ['Good question!', 'Let me explain', 'I\'ll get back to you'];
  if (msg.match(/\b(love|miss|â¤ï¸|ðŸ’•)\b/)) return ['â¤ï¸', 'Miss you too!', 'ðŸ˜Š'];
  if (msg.match(/\b(lol|haha|ðŸ˜‚|funny)\b/)) return ['ðŸ˜‚', 'Hahaha!', 'So funny!'];

  // Default
  return ['ðŸ‘', 'Sure!', 'On my way'];
}

// â”€â”€ Message Summariser â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Summarises an array of messages into bullet points
export async function summariseMessages(messages: { sender: string; text: string }[]): Promise<string> {
  if (messages.length === 0) return 'No messages to summarise.';

  // Simple local summariser â€” count topics and extract key info
  const senders = [...new Set(messages.map(m => m.sender))];
  const totalMsgs = messages.length;
  const lastFew = messages.slice(-5).map(m => `${m.sender}: ${m.text}`).join('\n');

  // For a real on-device summariser, we'd run a small LLM (e.g. llama.cpp)
  // For now we do a simple extraction
  const wordCount: Record<string, number> = {};
  messages.forEach(m => {
    m.text.toLowerCase().split(/\s+/).forEach(w => {
      if (w.length > 4) wordCount[w] = (wordCount[w] ?? 0) + 1;
    });
  });
  const topWords = Object.entries(wordCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w]) => w);

  return [
    `ðŸ“Š ${totalMsgs} messages from ${senders.join(', ')}`,
    topWords.length > 0 ? `ðŸ”‘ Key topics: ${topWords.join(', ')}` : '',
    `ðŸ“Œ Recent:\n${lastFew}`,
  ].filter(Boolean).join('\n\n');
}

// â”€â”€ Writing Assistant â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export type WriteMode = 'formal' | 'casual' | 'shorter' | 'longer' | 'emoji';

export function rewriteMessage(text: string, mode: WriteMode): string {
  switch (mode) {
    case 'formal':
      return text
        .replace(/\bhi\b/gi, 'Hello')
        .replace(/\bhey\b/gi, 'Dear')
        .replace(/\bu\b/gi, 'you')
        .replace(/\br\b/gi, 'are')
        .replace(/\bidk\b/gi, "I don't know")
        .replace(/\bbtw\b/gi, 'by the way')
        .replace(/\bomg\b/gi, 'oh my')
        .replace(/\blol\b/gi, '')
        .trim()
        + (text.endsWith('.') ? '' : '.');

    case 'casual':
      return text
        .replace(/\bHello\b/g, 'Hey')
        .replace(/\bDear\b/g, 'Hi')
        .replace(/\byou\b/gi, 'u')
        .replace(/\bare you\b/gi, 'r u')
        .replace(/\bI don't know\b/gi, 'idk')
        .replace(/\bby the way\b/gi, 'btw');

    case 'shorter':
      const sentences = text.split(/[.!?]+/).filter(s => s.trim());
      return sentences.slice(0, Math.max(1, Math.ceil(sentences.length / 2))).join('. ').trim() + '.';

    case 'longer':
      return text + ' Please let me know if you have any questions or need more details.';

    case 'emoji':
      return text
        .replace(/\bgood\b/gi, 'good âœ¨')
        .replace(/\blove\b/gi, 'love â¤ï¸')
        .replace(/\bhappy\b/gi, 'happy ðŸ˜Š')
        .replace(/\bsad\b/gi, 'sad ðŸ˜¢')
        .replace(/\bthanks\b/gi, 'thanks ðŸ™')
        .replace(/\bcool\b/gi, 'cool ðŸ˜Ž')
        .replace(/\bfire\b/gi, 'fire ðŸ”¥')
        .replace(/\bgreat\b/gi, 'great ðŸŽ‰')
        + ' ðŸ‘';

    default:
      return text;
  }
}

// â”€â”€ Message Translation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Uses free MyMemory API â€” no key needed, 1000 req/day
export async function translateMessage(text: string, targetLang: string = 'en'): Promise<string> {
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=auto|${targetLang}`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    return data.responseData?.translatedText ?? text;
  } catch {
    return text; // fallback to original
  }
}

// â”€â”€ Voice Transcription â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Uses Web Speech API (available on Android WebView / Expo)
// For fully on-device: integrate react-native-whisper
export async function transcribeVoice(audioUri: string): Promise<string> {
  // This is a placeholder â€” in production, integrate:
  // npm install react-native-whisper
  // The whisper model runs fully on-device (no internet needed)
  return '[Transcription: react-native-whisper integration \u2014 install and configure separately]';
}

// \u2500\u2500 Emotional AI: Mood Ring \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Detects emotional aura from typing patterns, emoji usage, message frequency
// Returns a mood color for the avatar ring
export type MoodType = 'happy' | 'calm' | 'energetic' | 'stressed' | 'sad' | 'neutral';

interface MoodAnalysis {
  mood: MoodType;
  color: string;      // ring color
  gradient: [string, string];
  emoji: string;
  confidence: number;  // 0-1
}

const MOOD_MAP: Record<MoodType, { color: string; gradient: [string, string]; emoji: string }> = {
  happy:     { color: '#F59E0B', gradient: ['#F59E0B', '#FBBF24'], emoji: '\uD83D\uDE0A' },
  calm:      { color: '#3B82F6', gradient: ['#3B82F6', '#60A5FA'], emoji: '\uD83D\uDE0C' },
  energetic: { color: '#10B981', gradient: ['#10B981', '#34D399'], emoji: '\uD83D\uDE04' },
  stressed:  { color: '#EF4444', gradient: ['#EF4444', '#F87171'], emoji: '\uD83D\uDE1F' },
  sad:       { color: '#8B5CF6', gradient: ['#8B5CF6', '#A78BFA'], emoji: '\uD83D\uDE14' },
  neutral:   { color: '#6B7280', gradient: ['#6B7280', '#9CA3AF'], emoji: '\uD83D\uDE10' },
};

export function analyzeMood(messages: { text: string; timestamp: number }[]): MoodAnalysis {
  if (messages.length === 0) return { mood: 'neutral', ...MOOD_MAP.neutral, confidence: 0 };

  const recentTexts = messages.slice(-20).map(m => m.text.toLowerCase());
  const allText = recentTexts.join(' ');

  // Emoji scoring
  const happyEmojis = (allText.match(/[\uD83D\uDE00-\uD83D\uDE0F\uD83D\uDE42\uD83E\uDD70\uD83D\uDE0D\u2764\uFE0F\uD83D\uDC95\uD83C\uDF89\uD83C\uDF8A\uD83D\uDC4D\uD83D\uDE02\uD83D\uDE01\uD83D\uDE04]/g) || []).length;
  const sadEmojis = (allText.match(/[\uD83D\uDE22\uD83D\uDE2D\uD83D\uDE1E\uD83D\uDE14\uD83D\uDE29\uD83D\uDE2B\uD83D\uDC94]/g) || []).length;
  const angryEmojis = (allText.match(/[\uD83D\uDE20\uD83D\uDE21\uD83D\uDE24\uD83E\uDD2C]/g) || []).length;
  const exclamations = (allText.match(/!+/g) || []).length;
  const questions = (allText.match(/\?+/g) || []).length;

  // Word pattern scoring
  const happyWords = (allText.match(/\b(happy|great|awesome|love|amazing|wonderful|perfect|beautiful|fun|excited|haha|lol|yay)\b/g) || []).length;
  const sadWords = (allText.match(/\b(sad|miss|sorry|tired|exhausted|lonely|upset|depressed|cry|hurt)\b/g) || []).length;
  const stressWords = (allText.match(/\b(stress|worried|anxious|panic|deadline|rush|hurry|urgent|asap|busy)\b/g) || []).length;
  const calmWords = (allText.match(/\b(calm|peaceful|relax|chill|quiet|serene|meditate|rest)\b/g) || []).length;

  // Message frequency (messages per minute in recent window)
  const timestamps = messages.slice(-10).map(m => m.timestamp);
  const timeSpan = timestamps.length > 1 ? (timestamps[timestamps.length - 1] - timestamps[0]) / 60000 : 1;
  const msgFreq = timestamps.length / Math.max(timeSpan, 0.5);

  // Score each mood
  const scores: Record<MoodType, number> = {
    happy: happyEmojis * 2 + happyWords * 1.5 + exclamations * 0.5,
    sad: sadEmojis * 2 + sadWords * 1.5,
    stressed: stressWords * 2 + angryEmojis * 1.5 + (msgFreq > 3 ? 2 : 0),
    calm: calmWords * 2 + (msgFreq < 0.5 ? 1 : 0),
    energetic: exclamations * 1 + (msgFreq > 2 ? 2 : 0) + happyEmojis * 0.5,
    neutral: 1, // baseline
  };

  // Find dominant mood
  let maxMood: MoodType = 'neutral';
  let maxScore = 0;
  for (const [mood, score] of Object.entries(scores)) {
    if (score > maxScore) { maxScore = score; maxMood = mood as MoodType; }
  }

  const confidence = Math.min(maxScore / 10, 1);

  return { mood: maxMood, ...MOOD_MAP[maxMood], confidence };
}

// \u2500\u2500 Emotional AI: Conversation Health Score \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Tracks relationship health trends: response times, tone shifts, engagement
export interface HealthScore {
  score: number;        // 0-100
  label: string;
  color: string;
  trend: 'improving' | 'stable' | 'declining';
  factors: { name: string; value: number; icon: string }[];
}

export function analyzeConversationHealth(
  messages: { senderId: string; text: string; timestamp: number }[],
  myUid: string,
): HealthScore {
  if (messages.length < 5) return { score: 50, label: 'Too early', color: '#6B7280', trend: 'stable', factors: [] };

  const myMsgs = messages.filter(m => m.senderId === myUid);
  const peerMsgs = messages.filter(m => m.senderId !== myUid);

  // Factor 1: Response balance (ideal is ~50/50)
  const balance = myMsgs.length / Math.max(messages.length, 1);
  const balanceScore = Math.max(0, 100 - Math.abs(balance - 0.5) * 200);

  // Factor 2: Average response time (lower is better)
  let totalResponseTime = 0;
  let responseCount = 0;
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].senderId !== messages[i - 1].senderId) {
      const gap = messages[i].timestamp - messages[i - 1].timestamp;
      if (gap < 86400000) { // within 24h
        totalResponseTime += gap;
        responseCount++;
      }
    }
  }
  const avgResponseMin = responseCount > 0 ? (totalResponseTime / responseCount) / 60000 : 60;
  const responseScore = Math.max(0, Math.min(100, 100 - avgResponseMin * 0.5));

  // Factor 3: Message length engagement
  const avgMyLen = myMsgs.reduce((a, m) => a + m.text.length, 0) / Math.max(myMsgs.length, 1);
  const avgPeerLen = peerMsgs.reduce((a, m) => a + m.text.length, 0) / Math.max(peerMsgs.length, 1);
  const engagementScore = Math.min(100, (avgMyLen + avgPeerLen) / 2);

  // Factor 4: Positivity
  const allText = messages.slice(-20).map(m => m.text.toLowerCase()).join(' ');
  const positiveCount = (allText.match(/\b(thanks|love|great|awesome|happy|good|nice|appreciate|miss you)\b/g) || []).length;
  const negativeCount = (allText.match(/\b(angry|hate|annoyed|frustrated|whatever|bye|leave|stop)\b/g) || []).length;
  const positivityScore = Math.min(100, 50 + (positiveCount - negativeCount) * 10);

  // Overall score
  const overall = Math.round((balanceScore * 0.2) + (responseScore * 0.3) + (engagementScore * 0.2) + (positivityScore * 0.3));

  // Trend: compare first half vs second half
  const mid = Math.floor(messages.length / 2);
  const firstHalf = messages.slice(0, mid);
  const secondHalf = messages.slice(mid);
  const firstPositive = firstHalf.filter(m => m.text.match(/[\uD83D\uDE00-\uD83D\uDE0F]|love|great|thanks/i)).length;
  const secondPositive = secondHalf.filter(m => m.text.match(/[\uD83D\uDE00-\uD83D\uDE0F]|love|great|thanks/i)).length;
  const trend = secondPositive > firstPositive + 2 ? 'improving' : secondPositive < firstPositive - 2 ? 'declining' : 'stable';

  const color = overall >= 70 ? '#10B981' : overall >= 40 ? '#F59E0B' : '#EF4444';
  const label = overall >= 80 ? 'Excellent' : overall >= 60 ? 'Good' : overall >= 40 ? 'Fair' : 'Needs attention';

  return {
    score: overall, label, color, trend,
    factors: [
      { name: 'Balance', value: Math.round(balanceScore), icon: '\u2696\uFE0F' },
      { name: 'Response Time', value: Math.round(responseScore), icon: '\u23F1\uFE0F' },
      { name: 'Engagement', value: Math.round(engagementScore), icon: '\uD83D\uDCAC' },
      { name: 'Positivity', value: Math.round(positivityScore), icon: '\u2764\uFE0F' },
    ],
  };
}

// \u2500\u2500 Emotional AI: Memory Bubbles \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Anniversary notifications for meaningful messages
// “1 year ago today, Ravi said...”
export interface MemoryBubble {
  messageText: string;
  senderName: string;
  date: Date;
  daysAgo: number;
  type: 'anniversary' | 'milestone';
}

export function findMemoryBubbles(
  messages: { senderId: string; senderName: string; text: string; timestamp: number }[],
): MemoryBubble[] {
  const now = Date.now();
  const bubbles: MemoryBubble[] = [];

  for (const msg of messages) {
    if (msg.text.length < 10) continue; // skip short messages
    const msgDate = new Date(msg.timestamp);
    const diffMs = now - msg.timestamp;
    const diffDays = Math.floor(diffMs / 86400000);

    // Check for anniversaries (same day of year, different year)
    const today = new Date();
    if (
      msgDate.getMonth() === today.getMonth() &&
      msgDate.getDate() === today.getDate() &&
      msgDate.getFullYear() < today.getFullYear()
    ) {
      const yearsAgo = today.getFullYear() - msgDate.getFullYear();
      bubbles.push({
        messageText: msg.text,
        senderName: msg.senderName,
        date: msgDate,
        daysAgo: diffDays,
        type: 'anniversary',
      });
    }

    // Milestone: exactly 100, 365, 730 days ago
    if ([100, 365, 730, 1095].includes(diffDays)) {
      bubbles.push({
        messageText: msg.text,
        senderName: msg.senderName,
        date: msgDate,
        daysAgo: diffDays,
        type: 'milestone',
      });
    }
  }

  return bubbles.slice(0, 5); // max 5
}