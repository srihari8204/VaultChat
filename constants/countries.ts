// Curated country dial-code list for the phone-login picker. Kept small and
// dependency-free (no react-native-country-picker-modal). Add more as needed.
export interface Country { name: string; dial: string; iso: string; flag: string }

export const COUNTRIES: Country[] = [
  { name: 'India',          dial: '+91',  iso: 'IN', flag: '🇮🇳' },
  { name: 'United States',  dial: '+1',   iso: 'US', flag: '🇺🇸' },
  { name: 'United Kingdom', dial: '+44',  iso: 'GB', flag: '🇬🇧' },
  { name: 'Canada',         dial: '+1',   iso: 'CA', flag: '🇨🇦' },
  { name: 'Australia',      dial: '+61',  iso: 'AU', flag: '🇦🇺' },
  { name: 'United Arab Emirates', dial: '+971', iso: 'AE', flag: '🇦🇪' },
  { name: 'Singapore',      dial: '+65',  iso: 'SG', flag: '🇸🇬' },
  { name: 'Germany',        dial: '+49',  iso: 'DE', flag: '🇩🇪' },
  { name: 'France',         dial: '+33',  iso: 'FR', flag: '🇫🇷' },
  { name: 'Spain',          dial: '+34',  iso: 'ES', flag: '🇪🇸' },
  { name: 'Italy',          dial: '+39',  iso: 'IT', flag: '🇮🇹' },
  { name: 'Netherlands',    dial: '+31',  iso: 'NL', flag: '🇳🇱' },
  { name: 'Saudi Arabia',   dial: '+966', iso: 'SA', flag: '🇸🇦' },
  { name: 'Pakistan',       dial: '+92',  iso: 'PK', flag: '🇵🇰' },
  { name: 'Bangladesh',     dial: '+880', iso: 'BD', flag: '🇧🇩' },
  { name: 'Sri Lanka',      dial: '+94',  iso: 'LK', flag: '🇱🇰' },
  { name: 'Nepal',          dial: '+977', iso: 'NP', flag: '🇳🇵' },
  { name: 'Indonesia',      dial: '+62',  iso: 'ID', flag: '🇮🇩' },
  { name: 'Malaysia',       dial: '+60',  iso: 'MY', flag: '🇲🇾' },
  { name: 'Philippines',    dial: '+63',  iso: 'PH', flag: '🇵🇭' },
  { name: 'Japan',          dial: '+81',  iso: 'JP', flag: '🇯🇵' },
  { name: 'China',          dial: '+86',  iso: 'CN', flag: '🇨🇳' },
  { name: 'South Korea',    dial: '+82',  iso: 'KR', flag: '🇰🇷' },
  { name: 'Brazil',         dial: '+55',  iso: 'BR', flag: '🇧🇷' },
  { name: 'Mexico',         dial: '+52',  iso: 'MX', flag: '🇲🇽' },
  { name: 'South Africa',   dial: '+27',  iso: 'ZA', flag: '🇿🇦' },
  { name: 'Nigeria',        dial: '+234', iso: 'NG', flag: '🇳🇬' },
  { name: 'Kenya',          dial: '+254', iso: 'KE', flag: '🇰🇪' },
  { name: 'Russia',         dial: '+7',   iso: 'RU', flag: '🇷🇺' },
  { name: 'Turkey',         dial: '+90',  iso: 'TR', flag: '🇹🇷' },
  { name: 'Qatar',          dial: '+974', iso: 'QA', flag: '🇶🇦' },
];

export const DEFAULT_COUNTRY: Country = COUNTRIES[0]; // India +91

export default COUNTRIES;
