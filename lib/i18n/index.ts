// lib/i18n/index.ts — the app-wide string catalog.
//
// AUDIT F8. The product is India-first — the VaultLens consent copy was already
// written in Telugu and Hindi — and every string outside Shop Book is
// hard-coded English across 195 screens. This is the layer new screens are
// written against, so the count stops growing.
//
// THE CATALOG STARTS SMALL ON PURPOSE. Extracting 195 screens in one change
// would be an unreviewable diff in files that have nothing to do with
// localisation, and it would land the day before launch. What has to happen now
// is the DECISION — a layer that exists, is wired, and is used by something
// real, so the next screen has somewhere to put its strings. Extraction is
// gradual by design; the audit said as much.
//
// Seeded with the strings that are genuinely shared: common actions, and the
// two full-screen gates, which are the first thing a new user sees and the
// worst place to be speaking the wrong language.
//
// Engine and catalogs are separate (lib/i18n/engine.ts). Shop Book keeps its
// own domain catalog on the same engine — a shop's "Khata" and a messenger's
// "Forwarded" have nothing to say to each other, and merging them would produce
// one catalog nobody can review.

import { createI18n, type Catalog, type LanguageMeta } from './engine';

export type AppLang = 'en' | 'hi' | 'te';

// Launch languages. All LTR — `dir` is declared anyway so that when an RTL
// locale is added the layout question is answerable from code instead of
// discovered in a screenshot.
export const APP_LANGUAGES: LanguageMeta[] = [
  { id: 'en', label: 'English', native: 'English', dir: 'ltr' },
  { id: 'hi', label: 'Hindi', native: 'हिन्दी', dir: 'ltr' },
  { id: 'te', label: 'Telugu', native: 'తెలుగు', dir: 'ltr' },
];

// English is the reference catalog: every key exists here, and the others fall
// back to it per key, so a partial translation renders English rather than a
// blank or a raw key.
const en: Catalog = {
  // common actions
  'common.ok': 'OK',
  'common.cancel': 'Cancel',
  'common.retry': 'Try again',
  'common.close': 'Close',
  'common.continue': 'Continue',
  'common.delete': 'Delete',
  'common.save': 'Save',

  // update gate
  'update.blocked.title': 'Update VaultChat to continue',
  'update.blocked.body': 'This version can no longer talk to the server safely. Update to carry on.',
  'update.button': 'Update now',
  'update.advise.body': 'A newer version of VaultChat is available.',

  // terms gate
  'terms.first.title': 'Before you start',
  'terms.first.body': 'VaultChat is covered by our Terms of Service and Privacy Policy. Please read them before you continue.',
  'terms.update.title': 'Our terms have changed',
  'terms.update.body': 'We have published an updated version of our Terms of Service. Please read them and accept to carry on using VaultChat.',
  'terms.read.terms': 'Read the Terms of Service',
  'terms.read.privacy': 'Read the Privacy Policy',
  'terms.agree': 'I agree',
  'terms.agree.foot': 'Tapping “I agree” records that you accepted these terms.',
  'terms.error': 'Could not record your acceptance. Check your connection and try again.',

  // forwarding (audit F10)
  'forward.label': '↪ Forwarded',
  'forward.label.many': '↪↪ Forwarded many times',
  'forward.notice.many': 'This has been forwarded many times. It can be sent to one chat at a time.',

  // notification actions (audit F6)
  'notif.reply': 'Reply',
  'notif.reply.send': 'Send',
  'notif.reply.placeholder': 'Message',
  'notif.markRead': 'Mark as read',
  'notif.newMessage': 'New message',

  // session
  'session.ended': 'Your session ended. Please sign in again.',
  'net.unavailable': 'Network unavailable — check your connection and try again.',

  // language picker
  'lang.title': 'Language',
};

const hi: Catalog = {
  'common.ok': 'ठीक है',
  'common.cancel': 'रद्द करें',
  'common.retry': 'फिर कोशिश करें',
  'common.close': 'बंद करें',
  'common.continue': 'जारी रखें',
  'common.delete': 'हटाएँ',
  'common.save': 'सहेजें',

  'update.blocked.title': 'जारी रखने के लिए VaultChat अपडेट करें',
  'update.blocked.body': 'यह संस्करण अब सर्वर से सुरक्षित रूप से बात नहीं कर सकता। जारी रखने के लिए अपडेट करें।',
  'update.button': 'अभी अपडेट करें',
  'update.advise.body': 'VaultChat का नया संस्करण उपलब्ध है।',

  'terms.first.title': 'शुरू करने से पहले',
  'terms.first.body': 'VaultChat हमारी सेवा शर्तों और गोपनीयता नीति के अंतर्गत आता है। जारी रखने से पहले उन्हें पढ़ें।',
  'terms.update.title': 'हमारी शर्तें बदल गई हैं',
  'terms.update.body': 'हमने सेवा शर्तों का एक नया संस्करण प्रकाशित किया है। VaultChat का उपयोग जारी रखने के लिए उन्हें पढ़कर स्वीकार करें।',
  'terms.read.terms': 'सेवा शर्तें पढ़ें',
  'terms.read.privacy': 'गोपनीयता नीति पढ़ें',
  'terms.agree': 'मैं सहमत हूँ',
  'terms.agree.foot': '“मैं सहमत हूँ” दबाने पर दर्ज होता है कि आपने ये शर्तें स्वीकार कीं।',
  'terms.error': 'आपकी स्वीकृति दर्ज नहीं हो सकी। कनेक्शन जाँचकर फिर कोशिश करें।',

  'forward.label': '↪ अग्रेषित',
  'forward.label.many': '↪↪ कई बार अग्रेषित',
  'forward.notice.many': 'इसे कई बार अग्रेषित किया गया है। एक बार में एक ही चैट को भेजा जा सकता है।',

  'notif.reply': 'उत्तर दें',
  'notif.reply.send': 'भेजें',
  'notif.reply.placeholder': 'संदेश',
  'notif.markRead': 'पढ़ा हुआ चिह्नित करें',
  'notif.newMessage': 'नया संदेश',

  'session.ended': 'आपका सत्र समाप्त हो गया। कृपया फिर साइन इन करें।',
  'net.unavailable': 'नेटवर्क उपलब्ध नहीं — कनेक्शन जाँचकर फिर कोशिश करें।',

  'lang.title': 'भाषा',
};

const te: Catalog = {
  'common.ok': 'సరే',
  'common.cancel': 'రద్దు చేయి',
  'common.retry': 'మళ్ళీ ప్రయత్నించండి',
  'common.close': 'మూసివేయి',
  'common.continue': 'కొనసాగించు',
  'common.delete': 'తొలగించు',
  'common.save': 'భద్రపరచు',

  'update.blocked.title': 'కొనసాగించడానికి VaultChat నవీకరించండి',
  'update.blocked.body': 'ఈ వెర్షన్ ఇక సర్వర్‌తో సురక్షితంగా మాట్లాడలేదు. కొనసాగించడానికి నవీకరించండి.',
  'update.button': 'ఇప్పుడే నవీకరించు',
  'update.advise.body': 'VaultChat యొక్క కొత్త వెర్షన్ అందుబాటులో ఉంది.',

  'terms.first.title': 'ప్రారంభించే ముందు',
  'terms.first.body': 'VaultChat మా సేవా నిబంధనలు మరియు గోప్యతా విధానానికి లోబడి ఉంటుంది. కొనసాగించే ముందు వాటిని చదవండి.',
  'terms.update.title': 'మా నిబంధనలు మారాయి',
  'terms.update.body': 'మేము సేవా నిబంధనల కొత్త వెర్షన్‌ను ప్రచురించాం. VaultChat వాడకం కొనసాగించడానికి వాటిని చదివి అంగీకరించండి.',
  'terms.read.terms': 'సేవా నిబంధనలు చదవండి',
  'terms.read.privacy': 'గోప్యతా విధానం చదవండి',
  'terms.agree': 'నేను అంగీకరిస్తున్నాను',
  'terms.agree.foot': '“నేను అంగీకరిస్తున్నాను” నొక్కితే మీరు ఈ నిబంధనలను అంగీకరించినట్టు నమోదవుతుంది.',
  'terms.error': 'మీ అంగీకారం నమోదు కాలేదు. కనెక్షన్ చూసి మళ్ళీ ప్రయత్నించండి.',

  'forward.label': '↪ ఫార్వర్డ్ చేయబడింది',
  'forward.label.many': '↪↪ చాలాసార్లు ఫార్వర్డ్ చేయబడింది',
  'forward.notice.many': 'ఇది చాలాసార్లు ఫార్వర్డ్ అయ్యింది. ఒకసారికి ఒక చాట్‌కు మాత్రమే పంపవచ్చు.',

  'notif.reply': 'సమాధానం',
  'notif.reply.send': 'పంపు',
  'notif.reply.placeholder': 'సందేశం',
  'notif.markRead': 'చదివినట్టు గుర్తించు',
  'notif.newMessage': 'కొత్త సందేశం',

  'session.ended': 'మీ సెషన్ ముగిసింది. దయచేసి మళ్ళీ సైన్ ఇన్ చేయండి.',
  'net.unavailable': 'నెట్‌వర్క్ అందుబాటులో లేదు — కనెక్షన్ చూసి మళ్ళీ ప్రయత్నించండి.',

  'lang.title': 'భాష',
};

const i18n = createI18n<AppLang>({
  catalogs: { en, hi, te },
  fallback: 'en',
  storeKey: 'vaultchat.lang',
  languages: APP_LANGUAGES,
});

/** Translate a key. An unknown key returns the key — never a blank. */
export const t = i18n.t;
export const getLang = i18n.getLang;
export const setLang = i18n.setLang;
export const useLang = i18n.useLang;
export const initLang = i18n.init;
export const textDirection = i18n.dir;

/** Every key in the reference catalog — used by the coverage guard. */
export const REFERENCE_KEYS = Object.keys(en);
/** The catalogs, for the coverage guard. Not for rendering — use t(). */
export const CATALOGS_FOR_TESTS: Record<AppLang, Catalog> = { en, hi, te };

export default i18n;
