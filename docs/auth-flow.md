# VaultChat — Login & Onboarding (encrypted PII)

Adapted to the real stack: **Express + JS** backend (`vaultchat-backend/routes/auth.js`),
**Expo Router** frontend (`app/onboard*.tsx`), the existing **Postgres** `users` table
(extended by migration `042`, not recreated). No secrets in this doc.

## Sequence

```
Landing (app/onboard.tsx)
  • mobile (PhoneField → E.164) + email (Google account picker, editable)
  • POST /auth/lookup { email, phone }            → exists iff BOTH match one row
        exists  ─────────────────────────────► MPIN Entry (app/mpin-entry.tsx)
        new     ─► email OTP                        • POST /auth/mpin/verify {userId,mpin}
                                                     •   Redis 5-try / 15-min lockout → 423
Email OTP (app/email-verify.tsx)                     •   success → access+refresh JWT → Chats
  • POST /auth/onboard/send-otp  { email }
  • POST /auth/onboard/verify-otp{ email,code } → emailTicket (HMAC, 15 min, bound to email)
Profile (app/onboard-profile.tsx)
  • email/mobile disabled; DOB (age≥13); first/last (from Google, editable); status ≤139
Security (app/onboard-security.tsx)
  • pick 5 of 12 distinct questions + answers (held in RAM)
MPIN set+confirm (app/onboard-mpin.tsx) — weak + DOB-year rejected, on match commit:
  • POST /auth/profile/init { email,phone,emailTicket,firstName,lastName,dob,status }
        requires a valid emailTicket → encrypts PII, writes the row → userId
  • POST /auth/security-questions/save { userId, answers[5] }   (argon2id)
  • POST /auth/mpin/set { userId, mpin }            (argon2id; onboarding_complete=true)
Success (app/onboard-success.tsx)
  • POST /auth/mpin/verify → JWT (logs in)
  • optional MFA: expo-local-authentication enroll → 256-bit token in SecureStore
    (`vc.mfa.token`) + POST /auth/mfa/configure { mfaEnabled:true }
  • clear the in-memory onboarding store → Chats
```

## Key handling (`vaultchat-backend/lib/vault.js`)

| Data | Primitive | Why |
|---|---|---|
| email, phone, first/last name, DOB, status | **AES-256-GCM** (two-way) | must render back to the user. Per-record HKDF-SHA256 key from `VAULTCHAT_MASTER_KEY` + random salt. Envelope `0x01‖salt16‖iv12‖ct‖tag16` (base64). |
| MPIN, security answers | **Argon2id** (one-way, 64 MB/3/4) | verification secrets — never decryptable. `@node-rs/argon2`. |
| email/phone lookup | **HMAC-SHA256** (`VAULTCHAT_LOOKUP_PEPPER`) | deterministic index → match without decrypting rows. |
| email-ownership proof | **HMAC ticket** (15-min, bound to email lookup) | stateless; gates `profile/init`. |

- `VAULTCHAT_MASTER_KEY` (32 bytes) + `VAULTCHAT_LOOKUP_PEPPER`: env only, loaded at boot,
  **never logged, never rotated** (rotation orphans all ciphertext/lookups).
- Plaintext MPIN/answers live only in the RAM onboarding store and are wiped on success.
- Identity uniqueness: one email ↔ one phone (`uq_users_email_lookup` / `uq_users_phone_lookup`);
  a phone can't re-register under a different email.

## Status / remaining

- Built + committed: crypto (`lib/vault.js`, 26/26 tests), migration `042`, the 8 endpoints,
  all screens/components. **Not yet deployed.**
- **Stage 4 (pending):** existing readers of plaintext `email/phone/name` (profile display,
  chat peer-names, contacts, search) must move to cipher+lookup before the plaintext columns
  are dropped; until then a new cipher-only user logs in but their name won't render app-wide.
- **Deploy:** set `VAULTCHAT_MASTER_KEY`, `VAULTCHAT_LOOKUP_PEPPER`, working SMTP; apply
  migration 042; rebuild APK.
