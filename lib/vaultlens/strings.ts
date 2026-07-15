// lib/vaultlens/strings.ts — VaultLens copy in English / Telugu / Hindi.
// Deliverable 6: plain-language consent (no legalese wall) + core UI labels.
// getStrings() picks by the device locale, falling back to English.

import { NativeModules, Platform } from 'react-native';

export interface VLStrings {
  title: string;
  tagline: string;
  addPhoto: string;
  retakePhoto: string;
  quotaLeft: (n: number) => string;
  quotaResets: string;
  generating: string;
  almostThere: string;      // shown after ~20s
  didntWork: string;        // failed card
  tapRetry: string;
  setDp: string;
  saveGallery: string;
  share: string;
  regenerate: string;
  tryAnother: string;
  dpUpdated: string;        // toast
  savedGallery: string;     // toast
  quotaReached: string;
  offlineQueued: string;
  tabCreate: string;
  tabHistory: string;
  emptyHistory: string;
  deletePhotoData: string;
  deleteConfirm: string;
  deleted: string;
  // Consent
  consentTitle: string;
  consentBody: string;
  consentBullets: string[];
  consentAgree: string;
  consentDeleteNote: string;
}

const en: VLStrings = {
  title: 'VaultLens',
  tagline: 'Your face, reimagined',
  addPhoto: 'Add your photo',
  retakePhoto: 'Retake photo',
  quotaLeft: (n) => `${n} left today`,
  quotaResets: 'Resets at midnight',
  generating: 'Creating your look…',
  almostThere: 'Almost there…',
  didntWork: "Didn't work",
  tapRetry: 'Tap to retry',
  setDp: 'Set as Profile Picture',
  saveGallery: 'Save to Gallery',
  share: 'Share',
  regenerate: 'Regenerate',
  tryAnother: 'Try another style',
  dpUpdated: 'Profile picture updated',
  savedGallery: 'Saved to gallery',
  quotaReached: "You've used all your free looks today",
  offlineQueued: "You're offline — we'll create it when you're back",
  tabCreate: 'Create',
  tabHistory: 'History',
  emptyHistory: 'Your creations will appear here',
  deletePhotoData: 'Delete my photo data',
  deleteConfirm: 'This removes your saved photo and every image VaultLens made. This cannot be undone.',
  deleted: 'Your photo data was deleted',
  consentTitle: 'One quick thing',
  consentBody: 'To create your avatars, VaultLens needs to use your selfie. Your photo is stored securely and used only to generate the looks you pick.',
  consentBullets: [
    'Your face is never shared or sold',
    'Nothing is used to train AI models',
    'You can delete your photo data anytime, in one tap',
  ],
  consentAgree: 'I agree',
  consentDeleteNote: 'Delete anytime in Settings',
};

const te: VLStrings = {
  title: 'VaultLens',
  tagline: 'మీ ముఖం, కొత్తగా',
  addPhoto: 'మీ ఫోటో జోడించండి',
  retakePhoto: 'ఫోటో మళ్లీ తీయండి',
  quotaLeft: (n) => `ఈరోజు ${n} మిగిలి ఉన్నాయి`,
  quotaResets: 'అర్ధరాత్రికి రీసెట్ అవుతుంది',
  generating: 'మీ లుక్‌ను సృష్టిస్తోంది…',
  almostThere: 'దాదాపు పూర్తయింది…',
  didntWork: 'పని చేయలేదు',
  tapRetry: 'మళ్లీ ప్రయత్నించడానికి నొక్కండి',
  setDp: 'ప్రొఫైల్ ఫోటోగా సెట్ చేయండి',
  saveGallery: 'గ్యాలరీకి సేవ్ చేయండి',
  share: 'షేర్ చేయండి',
  regenerate: 'మళ్లీ సృష్టించండి',
  tryAnother: 'మరో స్టైల్ ప్రయత్నించండి',
  dpUpdated: 'ప్రొఫైల్ ఫోటో అప్‌డేట్ అయింది',
  savedGallery: 'గ్యాలరీకి సేవ్ అయింది',
  quotaReached: 'ఈరోజు మీ ఉచిత లుక్స్ అయిపోయాయి',
  offlineQueued: 'మీరు ఆఫ్‌లైన్‌లో ఉన్నారు — తిరిగి వచ్చాక సృష్టిస్తాము',
  tabCreate: 'సృష్టించు',
  tabHistory: 'చరిత్ర',
  emptyHistory: 'మీ సృష్టులు ఇక్కడ కనిపిస్తాయి',
  deletePhotoData: 'నా ఫోటో డేటా తొలగించండి',
  deleteConfirm: 'ఇది మీ సేవ్ చేసిన ఫోటో మరియు VaultLens రూపొందించిన ప్రతి చిత్రాన్ని తొలగిస్తుంది. దీన్ని రద్దు చేయలేరు.',
  deleted: 'మీ ఫోటో డేటా తొలగించబడింది',
  consentTitle: 'ఒక చిన్న విషయం',
  consentBody: 'మీ అవతార్‌లను సృష్టించడానికి, VaultLens మీ సెల్ఫీని ఉపయోగించాలి. మీ ఫోటో సురక్షితంగా నిల్వ చేయబడుతుంది మరియు మీరు ఎంచుకున్న లుక్‌లను రూపొందించడానికి మాత్రమే ఉపయోగించబడుతుంది.',
  consentBullets: [
    'మీ ముఖం ఎప్పుడూ షేర్ చేయబడదు లేదా అమ్మబడదు',
    'AI మోడల్‌లకు శిక్షణ ఇవ్వడానికి ఏదీ ఉపయోగించబడదు',
    'మీ ఫోటో డేటాను ఎప్పుడైనా ఒక్క నొక్కుతో తొలగించవచ్చు',
  ],
  consentAgree: 'నేను అంగీకరిస్తున్నాను',
  consentDeleteNote: 'సెట్టింగ్‌లలో ఎప్పుడైనా తొలగించండి',
};

const hi: VLStrings = {
  title: 'VaultLens',
  tagline: 'आपका चेहरा, नए अंदाज़ में',
  addPhoto: 'अपनी फ़ोटो जोड़ें',
  retakePhoto: 'फ़ोटो दोबारा लें',
  quotaLeft: (n) => `आज ${n} बचे हैं`,
  quotaResets: 'आधी रात को रीसेट होगा',
  generating: 'आपका लुक बना रहे हैं…',
  almostThere: 'बस थोड़ा और…',
  didntWork: 'काम नहीं हुआ',
  tapRetry: 'दोबारा कोशिश के लिए टैप करें',
  setDp: 'प्रोफ़ाइल फ़ोटो सेट करें',
  saveGallery: 'गैलरी में सेव करें',
  share: 'शेयर करें',
  regenerate: 'फिर से बनाएँ',
  tryAnother: 'दूसरा स्टाइल आज़माएँ',
  dpUpdated: 'प्रोफ़ाइल फ़ोटो अपडेट हुई',
  savedGallery: 'गैलरी में सेव हुआ',
  quotaReached: 'आज के आपके मुफ़्त लुक ख़त्म हो गए',
  offlineQueued: 'आप ऑफ़लाइन हैं — वापस आने पर बना देंगे',
  tabCreate: 'बनाएँ',
  tabHistory: 'इतिहास',
  emptyHistory: 'आपकी कृतियाँ यहाँ दिखेंगी',
  deletePhotoData: 'मेरा फ़ोटो डेटा हटाएँ',
  deleteConfirm: 'यह आपकी सेव की गई फ़ोटो और VaultLens द्वारा बनाई हर छवि हटा देगा। इसे पूर्ववत नहीं किया जा सकता।',
  deleted: 'आपका फ़ोटो डेटा हटा दिया गया',
  consentTitle: 'एक छोटी सी बात',
  consentBody: 'आपके अवतार बनाने के लिए, VaultLens को आपकी सेल्फ़ी चाहिए। आपकी फ़ोटो सुरक्षित रूप से रखी जाती है और सिर्फ़ आपके चुने लुक बनाने के लिए इस्तेमाल होती है।',
  consentBullets: [
    'आपका चेहरा कभी शेयर या बेचा नहीं जाता',
    'किसी AI मॉडल को ट्रेन करने में कुछ भी इस्तेमाल नहीं होता',
    'अपना फ़ोटो डेटा कभी भी एक टैप में हटाएँ',
  ],
  consentAgree: 'मैं सहमत हूँ',
  consentDeleteNote: 'सेटिंग्स में कभी भी हटाएँ',
};

const TABLE: Record<string, VLStrings> = { en, te, hi };

// No-dep device language (2-letter). iOS reads SettingsManager; Android reads
// I18nManager.localeIdentifier (e.g. "te_IN" / "hi_IN" / "en_US").
function deviceLang(): string {
  try {
    const raw = Platform.OS === 'ios'
      ? (NativeModules.SettingsManager?.settings?.AppleLocale
         || NativeModules.SettingsManager?.settings?.AppleLanguages?.[0])
      : NativeModules.I18nManager?.localeIdentifier;
    return String(raw || 'en').slice(0, 2).toLowerCase();
  } catch { return 'en'; }
}

export function getStrings(): VLStrings {
  return TABLE[deviceLang()] ?? en;
}
