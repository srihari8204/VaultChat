// lib/shopbookI18n.ts — dependency-free i18n for the SHOP BOOK mini-app
// (openspec: shop-book-upgrade / localization). Six launch languages,
// device-locale default, persisted override, English fallback for any
// missing key. Money/date formatting is NOT here — that comes from the
// shop's country config (tax engine), which always wins on invoices.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules, Platform } from 'react-native';
import { useSyncExternalStore } from 'react';

export type SBLang = 'en' | 'hi' | 'te' | 'ta' | 'gu' | 'kn';

export const SB_LANGUAGES: { id: SBLang; label: string; native: string }[] = [
  { id: 'en', label: 'English', native: 'English' },
  { id: 'hi', label: 'Hindi', native: 'हिन्दी' },
  { id: 'te', label: 'Telugu', native: 'తెలుగు' },
  { id: 'ta', label: 'Tamil', native: 'தமிழ்' },
  { id: 'gu', label: 'Gujarati', native: 'ગુજરાતી' },
  { id: 'kn', label: 'Kannada', native: 'ಕನ್ನಡ' },
];

const STORE_KEY = 'shopbook.lang';

type Catalog = Record<string, string>;

// English is the reference catalog — every key exists here; other languages
// fall back to it per-key, so a partial translation never renders blanks.
const en: Catalog = {
  // tabs
  'tab.shops': 'Shops',
  'tab.orders': 'Orders',
  'tab.profile': 'Profile',
  'tab.dashboard': 'Dashboard',
  'tab.products': 'Products',
  'tab.khata': 'Khata',
  // common
  'common.back': 'Back',
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.search': 'Search',
  'common.loading': 'Loading…',
  'common.total': 'Total',
  'common.pending': 'Pending',
  'common.paid': 'Paid',
  'common.notes': 'Notes',
  'common.qty': 'Qty',
  'common.price': 'Price',
  'common.brand': 'Brand',
  'common.unit': 'Unit',
  // customer
  'shops.nearby': 'Nearby shops',
  'shops.searchPlaceholder': 'Search shops or products',
  'shops.compare': 'Compare prices',
  'shops.viewCatalog': 'View catalog',
  'cart.title': 'Cart',
  'cart.placeOrder': 'Place order',
  'cart.addToCart': 'Add to cart',
  'orders.my': 'My orders',
  'orders.track': 'Order tracking',
  'orders.cancel': 'Cancel order',
  'orders.cancelReason': 'Why are you cancelling?',
  'orders.cancelledByYou': 'Cancelled by you',
  'orders.cancelledByShop': 'Cancelled by the shop',
  'orders.rejectedByShop': 'Rejected by the shop',
  'orders.acceptAlt': 'Accept',
  'orders.rejectAlt': 'Remove item',
  'orders.altSuggested': 'Alternative suggested',
  'orders.invoice': 'Receipt',
  'orders.confirmCollected': "I've collected my order",
  'orders.confirmCollectedMsg': 'Confirm you have collected this order? It completes the order and records it in your khata.',
  'orders.confirmCollectedYes': 'Yes, collected',
  'orders.collectedByYou': 'Collection confirmed by you',
  // retail receipt (B2C)
  'receipt.title': 'Receipt',
  'receipt.orderId': 'Order',
  'receipt.date': 'Date',
  'receipt.billedTo': 'Billed to',
  'receipt.address': 'Address',
  'receipt.items': 'Items',
  'receipt.item': 'Item',
  'receipt.amount': 'Amount',
  'receipt.savings': 'You saved',
  'receipt.total': 'Total paid',
  'receipt.inclusiveTax': 'Inclusive of all taxes',
  'receipt.paidInFull': 'Paid in full',
  'receipt.amountDue': 'Amount due at shop',
  'receipt.thanks': 'Thank you for shopping with us!',
  'receipt.share': 'Share receipt',
  'ledger.title': 'Khata (ledger)',
  'ledger.totalPending': 'Total pending',
  'profile.favorites': 'Favorite shops',
  'profile.pendingAcross': 'Pending across shops',
  // owner
  'owner.newOrder': 'New order',
  'owner.accept': 'Accept',
  'owner.reject': 'Reject',
  'owner.rejectReason': 'Rejection reason',
  'owner.markAvailable': 'Available',
  'owner.markUnavailable': 'Out of stock',
  'owner.suggestAlt': 'Suggest alternative',
  'owner.altName': 'Alternative product',
  'owner.altPrice': 'Alternative price',
  'owner.reviewFirst': 'Review every item before accepting',
  'owner.markCollected': 'Mark collected',
  'owner.settings': 'Shop settings',
  'owner.country': 'Country',
  'owner.taxDetails': 'Tax details (optional)',
  'owner.taxNote': 'All tax fields are optional. Invoices include tax only when you fill these in.',
  'owner.status.open': 'Open',
  'owner.status.busy': 'Busy',
  'owner.status.closed': 'Closed',
  'owner.status.holiday': 'Holiday',
  'owner.status.vacation': 'Vacation',
  'owner.starterCatalog': 'Load starter catalog',
  'owner.starterLoaded': 'Starter catalog added — set your prices',
  'owner.reports': 'Reports',
  'owner.reports.basic': 'Sales',
  'owner.reports.advanced': 'Advanced',
  'owner.reports.pendingPayments': 'Pending payments',
  'owner.reports.topProducts': 'Best sellers',
  'owner.reports.topCustomers': 'Top customers',
  'owner.reports.taxReport': 'Tax report',
  'owner.reports.upgrade': 'Upgrade to Pro for advanced reports',
  'owner.pendingApproval': 'Your shop is awaiting approval — customers will see it once approved',
  // notifications
  'notif.title': 'Notifications',
  'notif.markAllRead': 'Mark all as read',
  'notif.empty': 'No notifications yet',
  // order statuses (customer-facing)
  'status.pending': 'Order placed',
  'status.accepted': 'Accepted',
  'status.preparing': 'Preparing',
  'status.packing': 'Packing',
  'status.ready': 'Ready to collect',
  'status.collected': 'Collected',
  'status.completed': 'Completed',
  'status.rejected': 'Rejected',
  'status.cancelled': 'Cancelled',
  // language picker
  'lang.title': 'Language',
};

const hi: Catalog = {
  'tab.shops': 'दुकानें', 'tab.orders': 'ऑर्डर', 'tab.profile': 'प्रोफ़ाइल',
  'tab.dashboard': 'डैशबोर्ड', 'tab.products': 'उत्पाद', 'tab.khata': 'खाता',
  'common.back': 'वापस', 'common.save': 'सहेजें', 'common.cancel': 'रद्द करें',
  'common.search': 'खोजें', 'common.loading': 'लोड हो रहा है…', 'common.total': 'कुल',
  'common.pending': 'बकाया', 'common.paid': 'भुगतान', 'common.notes': 'नोट्स',
  'common.qty': 'मात्रा', 'common.price': 'कीमत', 'common.brand': 'ब्रांड', 'common.unit': 'इकाई',
  'shops.nearby': 'आस-पास की दुकानें', 'shops.searchPlaceholder': 'दुकान या उत्पाद खोजें',
  'shops.compare': 'कीमतें तुलना करें', 'shops.viewCatalog': 'कैटलॉग देखें',
  'cart.title': 'कार्ट', 'cart.placeOrder': 'ऑर्डर करें', 'cart.addToCart': 'कार्ट में डालें',
  'orders.my': 'मेरे ऑर्डर', 'orders.track': 'ऑर्डर ट्रैकिंग', 'orders.cancel': 'ऑर्डर रद्द करें',
  'orders.cancelReason': 'रद्द करने का कारण?', 'orders.cancelledByYou': 'आपने रद्द किया',
  'orders.cancelledByShop': 'दुकान ने रद्द किया', 'orders.rejectedByShop': 'दुकान ने अस्वीकार किया',
  'orders.acceptAlt': 'स्वीकारें', 'orders.rejectAlt': 'आइटम हटाएँ',
  'orders.altSuggested': 'विकल्प सुझाया गया', 'orders.invoice': 'रसीद',
  'orders.confirmCollected': 'मैंने ऑर्डर ले लिया',
  'orders.confirmCollectedMsg': 'पुष्टि करें कि आपने यह ऑर्डर ले लिया है? इससे ऑर्डर पूरा होगा और आपके खाते में दर्ज होगा।',
  'orders.confirmCollectedYes': 'हाँ, ले लिया', 'orders.collectedByYou': 'आपने प्राप्ति की पुष्टि की',
  'receipt.title': 'रसीद', 'receipt.orderId': 'ऑर्डर', 'receipt.date': 'दिनांक',
  'receipt.billedTo': 'ग्राहक', 'receipt.address': 'पता', 'receipt.items': 'सामान',
  'receipt.item': 'वस्तु', 'receipt.amount': 'राशि', 'receipt.savings': 'आपकी बचत',
  'receipt.total': 'कुल भुगतान', 'receipt.inclusiveTax': 'सभी करों सहित',
  'receipt.paidInFull': 'पूरा भुगतान हुआ', 'receipt.amountDue': 'दुकान पर बकाया',
  'receipt.thanks': 'खरीदारी के लिए धन्यवाद!', 'receipt.share': 'रसीद साझा करें',
  'ledger.title': 'खाता', 'ledger.totalPending': 'कुल बकाया',
  'profile.favorites': 'पसंदीदा दुकानें', 'profile.pendingAcross': 'सभी दुकानों में बकाया',
  'owner.newOrder': 'नया ऑर्डर', 'owner.accept': 'स्वीकारें', 'owner.reject': 'अस्वीकारें',
  'owner.rejectReason': 'अस्वीकृति का कारण', 'owner.markAvailable': 'उपलब्ध',
  'owner.markUnavailable': 'स्टॉक ख़त्म', 'owner.suggestAlt': 'विकल्प सुझाएँ',
  'owner.altName': 'वैकल्पिक उत्पाद', 'owner.altPrice': 'वैकल्पिक कीमत',
  'owner.reviewFirst': 'स्वीकारने से पहले हर आइटम जाँचें', 'owner.markCollected': 'संग्रह हुआ',
  'owner.settings': 'दुकान सेटिंग्स', 'owner.country': 'देश',
  'owner.taxDetails': 'कर विवरण (वैकल्पिक)',
  'owner.taxNote': 'सभी कर फ़ील्ड वैकल्पिक हैं। भरने पर ही बिल में कर दिखेगा।',
  'owner.status.open': 'खुला', 'owner.status.busy': 'व्यस्त', 'owner.status.closed': 'बंद',
  'owner.status.holiday': 'छुट्टी', 'owner.status.vacation': 'अवकाश',
  'owner.starterCatalog': 'स्टार्टर कैटलॉग जोड़ें',
  'owner.starterLoaded': 'स्टार्टर कैटलॉग जुड़ गया — कीमतें सेट करें',
  'owner.reports': 'रिपोर्ट', 'owner.reports.basic': 'बिक्री', 'owner.reports.advanced': 'उन्नत',
  'owner.reports.pendingPayments': 'बकाया भुगतान', 'owner.reports.topProducts': 'सबसे ज़्यादा बिकने वाले',
  'owner.reports.topCustomers': 'शीर्ष ग्राहक', 'owner.reports.taxReport': 'कर रिपोर्ट',
  'owner.reports.upgrade': 'उन्नत रिपोर्ट के लिए Pro लें',
  'owner.pendingApproval': 'आपकी दुकान स्वीकृति की प्रतीक्षा में है — स्वीकृति के बाद ग्राहक देखेंगे',
  'notif.title': 'सूचनाएँ', 'notif.markAllRead': 'सभी पढ़ी हुई करें', 'notif.empty': 'कोई सूचना नहीं',
  'status.pending': 'ऑर्डर हुआ', 'status.accepted': 'स्वीकृत', 'status.preparing': 'तैयारी में',
  'status.packing': 'पैकिंग', 'status.ready': 'लेने के लिए तैयार', 'status.collected': 'संग्रह हुआ',
  'status.completed': 'पूर्ण', 'status.rejected': 'अस्वीकृत', 'status.cancelled': 'रद्द',
  'lang.title': 'भाषा',
};

const te: Catalog = {
  'tab.shops': 'దుకాణాలు', 'tab.orders': 'ఆర్డర్లు', 'tab.profile': 'ప్రొఫైల్',
  'tab.dashboard': 'డాష్‌బోర్డ్', 'tab.products': 'ఉత్పత్తులు', 'tab.khata': 'ఖాతా',
  'common.back': 'వెనుకకు', 'common.save': 'సేవ్', 'common.cancel': 'రద్దు',
  'common.search': 'వెతకండి', 'common.loading': 'లోడ్ అవుతోంది…', 'common.total': 'మొత్తం',
  'common.pending': 'బాకీ', 'common.paid': 'చెల్లించింది', 'common.notes': 'గమనికలు',
  'common.qty': 'పరిమాణం', 'common.price': 'ధర', 'common.brand': 'బ్రాండ్', 'common.unit': 'యూనిట్',
  'shops.nearby': 'సమీప దుకాణాలు', 'shops.searchPlaceholder': 'దుకాణం లేదా ఉత్పత్తి వెతకండి',
  'shops.compare': 'ధరలు పోల్చండి', 'shops.viewCatalog': 'కేటలాగ్ చూడండి',
  'cart.title': 'కార్ట్', 'cart.placeOrder': 'ఆర్డర్ చేయండి', 'cart.addToCart': 'కార్ట్‌లో వేయండి',
  'orders.my': 'నా ఆర్డర్లు', 'orders.track': 'ఆర్డర్ ట్రాకింగ్', 'orders.cancel': 'ఆర్డర్ రద్దు',
  'orders.cancelReason': 'రద్దుకు కారణం?', 'orders.cancelledByYou': 'మీరు రద్దు చేశారు',
  'orders.cancelledByShop': 'దుకాణం రద్దు చేసింది', 'orders.rejectedByShop': 'దుకాణం తిరస్కరించింది',
  'orders.acceptAlt': 'అంగీకరించు', 'orders.rejectAlt': 'తీసివేయి',
  'orders.altSuggested': 'ప్రత్యామ్నాయం సూచించారు', 'orders.invoice': 'రసీదు',
  'orders.confirmCollected': 'నేను ఆర్డర్ తీసుకున్నాను',
  'orders.confirmCollectedMsg': 'ఈ ఆర్డర్ తీసుకున్నట్టు నిర్ధారించాలా? ఆర్డర్ పూర్తవుతుంది మరియు మీ ఖాతాలో నమోదవుతుంది.',
  'orders.confirmCollectedYes': 'అవును, తీసుకున్నాను', 'orders.collectedByYou': 'మీరు తీసుకున్నట్టు నిర్ధారించారు',
  'receipt.title': 'రసీదు', 'receipt.orderId': 'ఆర్డర్', 'receipt.date': 'తేదీ',
  'receipt.billedTo': 'కస్టమర్', 'receipt.address': 'చిరునామా', 'receipt.items': 'వస్తువులు',
  'receipt.item': 'వస్తువు', 'receipt.amount': 'మొత్తం', 'receipt.savings': 'మీరు ఆదా చేసింది',
  'receipt.total': 'చెల్లించిన మొత్తం', 'receipt.inclusiveTax': 'అన్ని పన్నులతో కలిపి',
  'receipt.paidInFull': 'పూర్తిగా చెల్లించారు', 'receipt.amountDue': 'దుకాణంలో బాకీ',
  'receipt.thanks': 'కొనుగోలుకు ధన్యవాదాలు!', 'receipt.share': 'రసీదు పంచుకోండి',
  'ledger.title': 'ఖాతా', 'ledger.totalPending': 'మొత్తం బాకీ',
  'profile.favorites': 'ఇష్టమైన దుకాణాలు', 'profile.pendingAcross': 'అన్ని దుకాణాల్లో బాకీ',
  'owner.newOrder': 'కొత్త ఆర్డర్', 'owner.accept': 'అంగీకరించు', 'owner.reject': 'తిరస్కరించు',
  'owner.rejectReason': 'తిరస్కరణ కారణం', 'owner.markAvailable': 'అందుబాటులో ఉంది',
  'owner.markUnavailable': 'స్టాక్ లేదు', 'owner.suggestAlt': 'ప్రత్యామ్నాయం సూచించు',
  'owner.altName': 'ప్రత్యామ్నాయ ఉత్పత్తి', 'owner.altPrice': 'ప్రత్యామ్నాయ ధర',
  'owner.reviewFirst': 'అంగీకరించే ముందు ప్రతి వస్తువును సమీక్షించండి', 'owner.markCollected': 'తీసుకున్నారు',
  'owner.settings': 'దుకాణ సెట్టింగ్స్', 'owner.country': 'దేశం',
  'owner.taxDetails': 'పన్ను వివరాలు (ఐచ్ఛికం)',
  'owner.taxNote': 'అన్ని పన్ను ఫీల్డ్‌లు ఐచ్ఛికం. నింపితేనే బిల్లులో పన్ను కనిపిస్తుంది.',
  'owner.status.open': 'తెరిచి ఉంది', 'owner.status.busy': 'బిజీ', 'owner.status.closed': 'మూసివేయబడింది',
  'owner.status.holiday': 'సెలవు', 'owner.status.vacation': 'విరామం',
  'owner.starterCatalog': 'స్టార్టర్ కేటలాగ్ జోడించు',
  'owner.starterLoaded': 'స్టార్టర్ కేటలాగ్ జోడించబడింది — ధరలు సెట్ చేయండి',
  'owner.reports': 'నివేదికలు', 'owner.reports.basic': 'అమ్మకాలు', 'owner.reports.advanced': 'అధునాతన',
  'owner.reports.pendingPayments': 'బాకీ చెల్లింపులు', 'owner.reports.topProducts': 'ఎక్కువగా అమ్ముడైనవి',
  'owner.reports.topCustomers': 'ముఖ్య కస్టమర్లు', 'owner.reports.taxReport': 'పన్ను నివేదిక',
  'owner.reports.upgrade': 'అధునాతన నివేదికలకు Pro తీసుకోండి',
  'owner.pendingApproval': 'మీ దుకాణం ఆమోదం కోసం వేచి ఉంది — ఆమోదం తర్వాత కస్టమర్లకు కనిపిస్తుంది',
  'notif.title': 'నోటిఫికేషన్లు', 'notif.markAllRead': 'అన్నీ చదివినట్లు గుర్తించు', 'notif.empty': 'నోటిఫికేషన్లు లేవు',
  'status.pending': 'ఆర్డర్ చేయబడింది', 'status.accepted': 'అంగీకరించబడింది', 'status.preparing': 'సిద్ధం చేస్తున్నారు',
  'status.packing': 'ప్యాకింగ్', 'status.ready': 'తీసుకోవడానికి సిద్ధం', 'status.collected': 'తీసుకున్నారు',
  'status.completed': 'పూర్తయింది', 'status.rejected': 'తిరస్కరించబడింది', 'status.cancelled': 'రద్దయింది',
  'lang.title': 'భాష',
};

const ta: Catalog = {
  'tab.shops': 'கடைகள்', 'tab.orders': 'ஆர்டர்கள்', 'tab.profile': 'சுயவிவரம்',
  'tab.dashboard': 'டாஷ்போர்டு', 'tab.products': 'பொருட்கள்', 'tab.khata': 'கணக்கு',
  'common.back': 'பின்', 'common.save': 'சேமி', 'common.cancel': 'ரத்து',
  'common.search': 'தேடு', 'common.loading': 'ஏற்றுகிறது…', 'common.total': 'மொத்தம்',
  'common.pending': 'நிலுவை', 'common.paid': 'செலுத்தியது', 'common.notes': 'குறிப்புகள்',
  'common.qty': 'அளவு', 'common.price': 'விலை', 'common.brand': 'பிராண்டு', 'common.unit': 'அலகு',
  'shops.nearby': 'அருகிலுள்ள கடைகள்', 'shops.searchPlaceholder': 'கடை அல்லது பொருள் தேடு',
  'shops.compare': 'விலைகளை ஒப்பிடு', 'shops.viewCatalog': 'பட்டியலைப் பார்',
  'cart.title': 'கார்ட்', 'cart.placeOrder': 'ஆர்டர் செய்', 'cart.addToCart': 'கார்ட்டில் சேர்',
  'orders.my': 'என் ஆர்டர்கள்', 'orders.track': 'ஆர்டர் நிலை', 'orders.cancel': 'ஆர்டரை ரத்து செய்',
  'orders.cancelReason': 'ரத்து செய்யக் காரணம்?', 'orders.cancelledByYou': 'நீங்கள் ரத்து செய்தீர்கள்',
  'orders.cancelledByShop': 'கடை ரத்து செய்தது', 'orders.rejectedByShop': 'கடை நிராகரித்தது',
  'orders.acceptAlt': 'ஏற்று', 'orders.rejectAlt': 'நீக்கு',
  'orders.altSuggested': 'மாற்று பரிந்துரைக்கப்பட்டது', 'orders.invoice': 'ரசீது',
  'orders.confirmCollected': 'ஆர்டரைப் பெற்றுவிட்டேன்',
  'orders.confirmCollectedMsg': 'இந்த ஆர்டரைப் பெற்றதை உறுதிப்படுத்தவா? ஆர்டர் முடிவடைந்து உங்கள் கணக்கில் பதிவாகும்.',
  'orders.confirmCollectedYes': 'ஆம், பெற்றேன்', 'orders.collectedByYou': 'நீங்கள் பெற்றதை உறுதிப்படுத்தினீர்கள்',
  'receipt.title': 'ரசீது', 'receipt.orderId': 'ஆர்டர்', 'receipt.date': 'தேதி',
  'receipt.billedTo': 'வாடிக்கையாளர்', 'receipt.address': 'முகவரி', 'receipt.items': 'பொருட்கள்',
  'receipt.item': 'பொருள்', 'receipt.amount': 'தொகை', 'receipt.savings': 'நீங்கள் மிச்சப்படுத்தியது',
  'receipt.total': 'செலுத்திய தொகை', 'receipt.inclusiveTax': 'அனைத்து வரிகளும் உள்ளடங்கும்',
  'receipt.paidInFull': 'முழுமையாக செலுத்தப்பட்டது', 'receipt.amountDue': 'கடையில் நிலுவை',
  'receipt.thanks': 'வாங்கியதற்கு நன்றி!', 'receipt.share': 'ரசீதைப் பகிர',
  'ledger.title': 'கணக்கு', 'ledger.totalPending': 'மொத்த நிலுவை',
  'profile.favorites': 'விருப்பக் கடைகள்', 'profile.pendingAcross': 'எல்லா கடைகளிலும் நிலுவை',
  'owner.newOrder': 'புதிய ஆர்டர்', 'owner.accept': 'ஏற்று', 'owner.reject': 'நிராகரி',
  'owner.rejectReason': 'நிராகரிப்புக் காரணம்', 'owner.markAvailable': 'கிடைக்கிறது',
  'owner.markUnavailable': 'இருப்பு இல்லை', 'owner.suggestAlt': 'மாற்று பரிந்துரை',
  'owner.altName': 'மாற்றுப் பொருள்', 'owner.altPrice': 'மாற்று விலை',
  'owner.reviewFirst': 'ஏற்கும் முன் ஒவ்வொரு பொருளையும் சரிபார்க்கவும்', 'owner.markCollected': 'பெறப்பட்டது',
  'owner.settings': 'கடை அமைப்புகள்', 'owner.country': 'நாடு',
  'owner.taxDetails': 'வரி விவரங்கள் (விருப்பம்)',
  'owner.taxNote': 'எல்லா வரி புலங்களும் விருப்பம். நிரப்பினால் மட்டுமே பில்லில் வரி வரும்.',
  'owner.status.open': 'திறந்துள்ளது', 'owner.status.busy': 'பிஸி', 'owner.status.closed': 'மூடப்பட்டது',
  'owner.status.holiday': 'விடுமுறை', 'owner.status.vacation': 'விடுப்பு',
  'owner.starterCatalog': 'தொடக்கப் பட்டியலைச் சேர்',
  'owner.starterLoaded': 'தொடக்கப் பட்டியல் சேர்க்கப்பட்டது — விலைகளை அமைக்கவும்',
  'owner.reports': 'அறிக்கைகள்', 'owner.reports.basic': 'விற்பனை', 'owner.reports.advanced': 'மேம்பட்ட',
  'owner.reports.pendingPayments': 'நிலுவைப் பணம்', 'owner.reports.topProducts': 'அதிகம் விற்பவை',
  'owner.reports.topCustomers': 'முக்கிய வாடிக்கையாளர்கள்', 'owner.reports.taxReport': 'வரி அறிக்கை',
  'owner.reports.upgrade': 'மேம்பட்ட அறிக்கைகளுக்கு Pro பெறவும்',
  'owner.pendingApproval': 'உங்கள் கடை ஒப்புதலுக்காக காத்திருக்கிறது — ஒப்புதலுக்குப் பின் வாடிக்கையாளர்களுக்குத் தெரியும்',
  'notif.title': 'அறிவிப்புகள்', 'notif.markAllRead': 'எல்லாம் படித்ததாகக் குறி', 'notif.empty': 'அறிவிப்புகள் இல்லை',
  'status.pending': 'ஆர்டர் செய்யப்பட்டது', 'status.accepted': 'ஏற்கப்பட்டது', 'status.preparing': 'தயாராகிறது',
  'status.packing': 'பேக்கிங்', 'status.ready': 'பெற தயார்', 'status.collected': 'பெறப்பட்டது',
  'status.completed': 'முடிந்தது', 'status.rejected': 'நிராகரிக்கப்பட்டது', 'status.cancelled': 'ரத்தானது',
  'lang.title': 'மொழி',
};

const gu: Catalog = {
  'tab.shops': 'દુકાનો', 'tab.orders': 'ઓર્ડર', 'tab.profile': 'પ્રોફાઇલ',
  'tab.dashboard': 'ડેશબોર્ડ', 'tab.products': 'ઉત્પાદનો', 'tab.khata': 'ખાતું',
  'common.back': 'પાછળ', 'common.save': 'સાચવો', 'common.cancel': 'રદ કરો',
  'common.search': 'શોધો', 'common.loading': 'લોડ થાય છે…', 'common.total': 'કુલ',
  'common.pending': 'બાકી', 'common.paid': 'ચૂકવેલ', 'common.notes': 'નોંધ',
  'common.qty': 'જથ્થો', 'common.price': 'કિંમત', 'common.brand': 'બ્રાન્ડ', 'common.unit': 'એકમ',
  'shops.nearby': 'નજીકની દુકાનો', 'shops.searchPlaceholder': 'દુકાન કે ઉત્પાદન શોધો',
  'shops.compare': 'કિંમતોની સરખામણી', 'shops.viewCatalog': 'કેટલોગ જુઓ',
  'cart.title': 'કાર્ટ', 'cart.placeOrder': 'ઓર્ડર કરો', 'cart.addToCart': 'કાર્ટમાં ઉમેરો',
  'orders.my': 'મારા ઓર્ડર', 'orders.track': 'ઓર્ડર ટ્રેકિંગ', 'orders.cancel': 'ઓર્ડર રદ કરો',
  'orders.cancelReason': 'રદ કરવાનું કારણ?', 'orders.cancelledByYou': 'તમે રદ કર્યો',
  'orders.cancelledByShop': 'દુકાને રદ કર્યો', 'orders.rejectedByShop': 'દુકાને નકાર્યો',
  'orders.acceptAlt': 'સ્વીકારો', 'orders.rejectAlt': 'કાઢી નાખો',
  'orders.altSuggested': 'વિકલ્પ સૂચવાયો', 'orders.invoice': 'રસીદ',
  'orders.confirmCollected': 'મેં ઓર્ડર લઈ લીધો',
  'orders.confirmCollectedMsg': 'ખાતરી કરો કે તમે આ ઓર્ડર લઈ લીધો છે? ઓર્ડર પૂર્ણ થશે અને તમારા ખાતામાં નોંધાશે.',
  'orders.confirmCollectedYes': 'હા, લઈ લીધો', 'orders.collectedByYou': 'તમે લીધાની ખાતરી કરી',
  'receipt.title': 'રસીદ', 'receipt.orderId': 'ઓર્ડર', 'receipt.date': 'તારીખ',
  'receipt.billedTo': 'ગ્રાહક', 'receipt.address': 'સરનામું', 'receipt.items': 'વસ્તુઓ',
  'receipt.item': 'વસ્તુ', 'receipt.amount': 'રકમ', 'receipt.savings': 'તમારી બચત',
  'receipt.total': 'કુલ ચુકવણી', 'receipt.inclusiveTax': 'બધા કર સહિત',
  'receipt.paidInFull': 'પૂરેપૂરું ચૂકવાયું', 'receipt.amountDue': 'દુકાને બાકી',
  'receipt.thanks': 'ખરીદી માટે આભાર!', 'receipt.share': 'રસીદ શેર કરો',
  'ledger.title': 'ખાતું', 'ledger.totalPending': 'કુલ બાકી',
  'profile.favorites': 'મનપસંદ દુકાનો', 'profile.pendingAcross': 'બધી દુકાનોમાં બાકી',
  'owner.newOrder': 'નવો ઓર્ડર', 'owner.accept': 'સ્વીકારો', 'owner.reject': 'નકારો',
  'owner.rejectReason': 'નકારવાનું કારણ', 'owner.markAvailable': 'ઉપલબ્ધ',
  'owner.markUnavailable': 'સ્ટોક નથી', 'owner.suggestAlt': 'વિકલ્પ સૂચવો',
  'owner.altName': 'વૈકલ્પિક ઉત્પાદન', 'owner.altPrice': 'વૈકલ્પિક કિંમત',
  'owner.reviewFirst': 'સ્વીકારતા પહેલા દરેક વસ્તુ તપાસો', 'owner.markCollected': 'લેવાયું',
  'owner.settings': 'દુકાન સેટિંગ્સ', 'owner.country': 'દેશ',
  'owner.taxDetails': 'કર વિગતો (વૈકલ્પિક)',
  'owner.taxNote': 'બધા કર ફીલ્ડ વૈકલ્પિક છે. ભરો તો જ બિલમાં કર દેખાશે.',
  'owner.status.open': 'ખુલ્લું', 'owner.status.busy': 'વ્યસ્ત', 'owner.status.closed': 'બંધ',
  'owner.status.holiday': 'રજા', 'owner.status.vacation': 'વેકેશન',
  'owner.starterCatalog': 'સ્ટાર્ટર કેટલોગ ઉમેરો',
  'owner.starterLoaded': 'સ્ટાર્ટર કેટલોગ ઉમેરાયો — કિંમતો સેટ કરો',
  'owner.reports': 'રિપોર્ટ', 'owner.reports.basic': 'વેચાણ', 'owner.reports.advanced': 'એડવાન્સ',
  'owner.reports.pendingPayments': 'બાકી ચુકવણી', 'owner.reports.topProducts': 'સૌથી વધુ વેચાતા',
  'owner.reports.topCustomers': 'મુખ્ય ગ્રાહકો', 'owner.reports.taxReport': 'કર રિપોર્ટ',
  'owner.reports.upgrade': 'એડવાન્સ રિપોર્ટ માટે Pro લો',
  'owner.pendingApproval': 'તમારી દુકાન મંજૂરીની રાહમાં છે — મંજૂરી પછી ગ્રાહકો જોશે',
  'notif.title': 'સૂચનાઓ', 'notif.markAllRead': 'બધી વાંચેલી કરો', 'notif.empty': 'કોઈ સૂચના નથી',
  'status.pending': 'ઓર્ડર થયો', 'status.accepted': 'સ્વીકૃત', 'status.preparing': 'તૈયારીમાં',
  'status.packing': 'પેકિંગ', 'status.ready': 'લેવા તૈયાર', 'status.collected': 'લેવાયું',
  'status.completed': 'પૂર્ણ', 'status.rejected': 'નકારાયું', 'status.cancelled': 'રદ',
  'lang.title': 'ભાષા',
};

const kn: Catalog = {
  'tab.shops': 'ಅಂಗಡಿಗಳು', 'tab.orders': 'ಆರ್ಡರ್‌ಗಳು', 'tab.profile': 'ಪ್ರೊಫೈಲ್',
  'tab.dashboard': 'ಡ್ಯಾಶ್‌ಬೋರ್ಡ್', 'tab.products': 'ಉತ್ಪನ್ನಗಳು', 'tab.khata': 'ಖಾತೆ',
  'common.back': 'ಹಿಂದೆ', 'common.save': 'ಉಳಿಸಿ', 'common.cancel': 'ರದ್ದುಮಾಡಿ',
  'common.search': 'ಹುಡುಕಿ', 'common.loading': 'ಲೋಡ್ ಆಗುತ್ತಿದೆ…', 'common.total': 'ಒಟ್ಟು',
  'common.pending': 'ಬಾಕಿ', 'common.paid': 'ಪಾವತಿಸಿದೆ', 'common.notes': 'ಟಿಪ್ಪಣಿಗಳು',
  'common.qty': 'ಪ್ರಮಾಣ', 'common.price': 'ಬೆಲೆ', 'common.brand': 'ಬ್ರ್ಯಾಂಡ್', 'common.unit': 'ಘಟಕ',
  'shops.nearby': 'ಹತ್ತಿರದ ಅಂಗಡಿಗಳು', 'shops.searchPlaceholder': 'ಅಂಗಡಿ ಅಥವಾ ಉತ್ಪನ್ನ ಹುಡುಕಿ',
  'shops.compare': 'ಬೆಲೆ ಹೋಲಿಸಿ', 'shops.viewCatalog': 'ಕ್ಯಾಟಲಾಗ್ ನೋಡಿ',
  'cart.title': 'ಕಾರ್ಟ್', 'cart.placeOrder': 'ಆರ್ಡರ್ ಮಾಡಿ', 'cart.addToCart': 'ಕಾರ್ಟ್‌ಗೆ ಸೇರಿಸಿ',
  'orders.my': 'ನನ್ನ ಆರ್ಡರ್‌ಗಳು', 'orders.track': 'ಆರ್ಡರ್ ಟ್ರ್ಯಾಕಿಂಗ್', 'orders.cancel': 'ಆರ್ಡರ್ ರದ್ದುಮಾಡಿ',
  'orders.cancelReason': 'ರದ್ದತಿಗೆ ಕಾರಣ?', 'orders.cancelledByYou': 'ನೀವು ರದ್ದುಮಾಡಿದ್ದೀರಿ',
  'orders.cancelledByShop': 'ಅಂಗಡಿ ರದ್ದುಮಾಡಿದೆ', 'orders.rejectedByShop': 'ಅಂಗಡಿ ತಿರಸ್ಕರಿಸಿದೆ',
  'orders.acceptAlt': 'ಒಪ್ಪಿಕೊಳ್ಳಿ', 'orders.rejectAlt': 'ತೆಗೆದುಹಾಕಿ',
  'orders.altSuggested': 'ಪರ್ಯಾಯ ಸೂಚಿಸಲಾಗಿದೆ', 'orders.invoice': 'ರಸೀದಿ',
  'orders.confirmCollected': 'ನಾನು ಆರ್ಡರ್ ಪಡೆದಿದ್ದೇನೆ',
  'orders.confirmCollectedMsg': 'ಈ ಆರ್ಡರ್ ಪಡೆದಿರುವುದನ್ನು ಖಚಿತಪಡಿಸುವಿರಾ? ಆರ್ಡರ್ ಪೂರ್ಣಗೊಂಡು ನಿಮ್ಮ ಖಾತೆಯಲ್ಲಿ ದಾಖಲಾಗುತ್ತದೆ.',
  'orders.confirmCollectedYes': 'ಹೌದು, ಪಡೆದಿದ್ದೇನೆ', 'orders.collectedByYou': 'ನೀವು ಪಡೆದಿರುವುದನ್ನು ಖಚಿತಪಡಿಸಿದ್ದೀರಿ',
  'receipt.title': 'ರಸೀದಿ', 'receipt.orderId': 'ಆರ್ಡರ್', 'receipt.date': 'ದಿನಾಂಕ',
  'receipt.billedTo': 'ಗ್ರಾಹಕ', 'receipt.address': 'ವಿಳಾಸ', 'receipt.items': 'ವಸ್ತುಗಳು',
  'receipt.item': 'ವಸ್ತು', 'receipt.amount': 'ಮೊತ್ತ', 'receipt.savings': 'ನೀವು ಉಳಿಸಿದ್ದು',
  'receipt.total': 'ಪಾವತಿಸಿದ ಒಟ್ಟು', 'receipt.inclusiveTax': 'ಎಲ್ಲಾ ತೆರಿಗೆಗಳನ್ನು ಒಳಗೊಂಡಂತೆ',
  'receipt.paidInFull': 'ಪೂರ್ಣ ಪಾವತಿಯಾಗಿದೆ', 'receipt.amountDue': 'ಅಂಗಡಿಯಲ್ಲಿ ಬಾಕಿ',
  'receipt.thanks': 'ಖರೀದಿಗೆ ಧನ್ಯವಾದಗಳು!', 'receipt.share': 'ರಸೀದಿ ಹಂಚಿಕೊಳ್ಳಿ',
  'ledger.title': 'ಖಾತೆ', 'ledger.totalPending': 'ಒಟ್ಟು ಬಾಕಿ',
  'profile.favorites': 'ಮೆಚ್ಚಿನ ಅಂಗಡಿಗಳು', 'profile.pendingAcross': 'ಎಲ್ಲಾ ಅಂಗಡಿಗಳಲ್ಲಿ ಬಾಕಿ',
  'owner.newOrder': 'ಹೊಸ ಆರ್ಡರ್', 'owner.accept': 'ಒಪ್ಪಿಕೊಳ್ಳಿ', 'owner.reject': 'ತಿರಸ್ಕರಿಸಿ',
  'owner.rejectReason': 'ತಿರಸ್ಕಾರದ ಕಾರಣ', 'owner.markAvailable': 'ಲಭ್ಯವಿದೆ',
  'owner.markUnavailable': 'ಸ್ಟಾಕ್ ಇಲ್ಲ', 'owner.suggestAlt': 'ಪರ್ಯಾಯ ಸೂಚಿಸಿ',
  'owner.altName': 'ಪರ್ಯಾಯ ಉತ್ಪನ್ನ', 'owner.altPrice': 'ಪರ್ಯಾಯ ಬೆಲೆ',
  'owner.reviewFirst': 'ಒಪ್ಪುವ ಮೊದಲು ಪ್ರತಿ ವಸ್ತುವನ್ನು ಪರಿಶೀಲಿಸಿ', 'owner.markCollected': 'ಪಡೆದಿದ್ದಾರೆ',
  'owner.settings': 'ಅಂಗಡಿ ಸೆಟ್ಟಿಂಗ್ಸ್', 'owner.country': 'ದೇಶ',
  'owner.taxDetails': 'ತೆರಿಗೆ ವಿವರಗಳು (ಐಚ್ಛಿಕ)',
  'owner.taxNote': 'ಎಲ್ಲಾ ತೆರಿಗೆ ಕ್ಷೇತ್ರಗಳು ಐಚ್ಛಿಕ. ಭರ್ತಿ ಮಾಡಿದರೆ ಮಾತ್ರ ಬಿಲ್‌ನಲ್ಲಿ ತೆರಿಗೆ ಕಾಣುತ್ತದೆ.',
  'owner.status.open': 'ತೆರೆದಿದೆ', 'owner.status.busy': 'ಬ್ಯುಸಿ', 'owner.status.closed': 'ಮುಚ್ಚಿದೆ',
  'owner.status.holiday': 'ರಜೆ', 'owner.status.vacation': 'ವಿರಾಮ',
  'owner.starterCatalog': 'ಸ್ಟಾರ್ಟರ್ ಕ್ಯಾಟಲಾಗ್ ಸೇರಿಸಿ',
  'owner.starterLoaded': 'ಸ್ಟಾರ್ಟರ್ ಕ್ಯಾಟಲಾಗ್ ಸೇರಿಸಲಾಗಿದೆ — ಬೆಲೆಗಳನ್ನು ಹೊಂದಿಸಿ',
  'owner.reports': 'ವರದಿಗಳು', 'owner.reports.basic': 'ಮಾರಾಟ', 'owner.reports.advanced': 'ಸುಧಾರಿತ',
  'owner.reports.pendingPayments': 'ಬಾಕಿ ಪಾವತಿಗಳು', 'owner.reports.topProducts': 'ಹೆಚ್ಚು ಮಾರಾಟವಾದವು',
  'owner.reports.topCustomers': 'ಪ್ರಮುಖ ಗ್ರಾಹಕರು', 'owner.reports.taxReport': 'ತೆರಿಗೆ ವರದಿ',
  'owner.reports.upgrade': 'ಸುಧಾರಿತ ವರದಿಗಳಿಗೆ Pro ಪಡೆಯಿರಿ',
  'owner.pendingApproval': 'ನಿಮ್ಮ ಅಂಗಡಿ ಅನುಮೋದನೆಗೆ ಕಾಯುತ್ತಿದೆ — ಅನುಮೋದನೆಯ ನಂತರ ಗ್ರಾಹಕರಿಗೆ ಕಾಣುತ್ತದೆ',
  'notif.title': 'ಅಧಿಸೂಚನೆಗಳು', 'notif.markAllRead': 'ಎಲ್ಲಾ ಓದಿದಂತೆ ಗುರುತಿಸಿ', 'notif.empty': 'ಅಧಿಸೂಚನೆಗಳಿಲ್ಲ',
  'status.pending': 'ಆರ್ಡರ್ ಆಗಿದೆ', 'status.accepted': 'ಒಪ್ಪಿಗೆಯಾಗಿದೆ', 'status.preparing': 'ತಯಾರಿಯಲ್ಲಿ',
  'status.packing': 'ಪ್ಯಾಕಿಂಗ್', 'status.ready': 'ಪಡೆಯಲು ಸಿದ್ಧ', 'status.collected': 'ಪಡೆದಿದ್ದಾರೆ',
  'status.completed': 'ಪೂರ್ಣಗೊಂಡಿದೆ', 'status.rejected': 'ತಿರಸ್ಕರಿಸಲಾಗಿದೆ', 'status.cancelled': 'ರದ್ದಾಗಿದೆ',
  'lang.title': 'ಭಾಷೆ',
};

const CATALOGS: Record<SBLang, Catalog> = { en, hi, te, ta, gu, kn };

// ── state + subscription (tiny external store, no context needed) ──
let current: SBLang = 'en';
const listeners = new Set<() => void>();

function deviceLang(): SBLang {
  try {
    const tag: string =
      Platform.OS === 'ios'
        ? NativeModules.SettingsManager?.settings?.AppleLocale ??
          NativeModules.SettingsManager?.settings?.AppleLanguages?.[0] ?? 'en'
        : NativeModules.I18nManager?.localeIdentifier ?? 'en';
    const code = tag.slice(0, 2).toLowerCase();
    return (CATALOGS as Record<string, Catalog>)[code] ? (code as SBLang) : 'en';
  } catch {
    return 'en';
  }
}

// Load the persisted choice (or device default) once at import time.
let loaded = false;
export async function initShopBookLang(): Promise<SBLang> {
  if (loaded) return current;
  loaded = true;
  try {
    const saved = await AsyncStorage.getItem(STORE_KEY);
    current = saved && (CATALOGS as Record<string, Catalog>)[saved] ? (saved as SBLang) : deviceLang();
  } catch {
    current = deviceLang();
  }
  listeners.forEach((l) => l());
  return current;
}

export function getShopBookLang(): SBLang {
  return current;
}

export async function setShopBookLang(lang: SBLang) {
  current = lang;
  listeners.forEach((l) => l());
  try {
    await AsyncStorage.setItem(STORE_KEY, lang);
  } catch {
    // persistence is best-effort; the in-memory choice still applies
  }
}

export function t(key: string): string {
  return CATALOGS[current][key] ?? en[key] ?? key;
}

// Re-renders the component whenever the language changes.
export function useShopBookLang(): SBLang {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
