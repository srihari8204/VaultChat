# VaultChat Deploy Checklist

## 1. Backend Deploy (Render)
```bash
cd "C:\Users\ADMIN\Desktop\Vaultchat backup\vaultchat-backend"
git add .
git commit -m "Deploy backend with contact sync"
git push origin master
```
Render auto-deploys from GitHub. Check: https://vaultchat.onrender.com/health

## 2. Firestore Indexes
Option A: Firebase CLI (if installed)
```bash
npm install -g firebase-tools
firebase login
firebase deploy --only firestore:indexes
```

Option B: Manual (Firebase Console)
Go to: https://console.firebase.google.com → Firestore → Indexes
Create these composite indexes:

| Collection | Fields | Order |
|------------|--------|-------|
| channels | subscribers (Array), lastPostAt (DESC) | — |
| inviteLinks | chatId (ASC), createdBy (ASC), createdAt (DESC) | — |
| loginHistory | loginAt (DESC) | — |
| scheduledMessages | sent (ASC), sendAt (ASC) | — |
| vaultbeam | recipientUid (ASC), status (ASC) | — |
| messages | msgType (ASC), createdAt (DESC) | — |
| posts | createdAt (DESC) | — |
| securityEvents | timestamp (DESC) | — |
| alerts | read (ASC), createdAt (DESC) | — |

Note: Firestore will auto-create single-field indexes.
These composite indexes are needed for queries with WHERE + ORDER BY.

## 3. Firebase Security Rules
Ensure these collections are accessible:
- channels, inviteLinks, stickerPacks — read by authenticated users
- vaultbeam — read/write by chat participants
- loginHistory, securityEvents, alerts — read/write by document owner

## 4. Build
```bash
# EAS (when quota resets April 1)
eas build --platform android --profile production

# Local build (anytime)
npx expo prebuild --platform android
cd android
./gradlew assembleRelease
```
APK output: android/app/build/outputs/apk/release/app-release.apk

## 5. Version Bump (before Play Store)
In app.json:
- "version": "1.1.0"
- "versionCode": 2

## 6. Play Store
1. Go to https://play.google.com/console
2. Upload .aab file
3. Fill store listing, screenshots
4. Submit for review
