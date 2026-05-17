# VaultChat Production Deploy Checklist

This doc is the single source of truth for releasing VaultChat. Follow it top-to-bottom.

---

## 0. One-time setup (only needed once per machine)

```bash
# Frontend
npm install -g eas-cli firebase-tools
cd "C:\Users\ADMIN\Desktop\Vaultchat backup"
npm ci
eas login         # uses the EAS account that owns project 144570a3-de88-48f0-b7e1-ecda63618199
firebase login    # for Firestore rules / indexes deploy

# Backend
cd vaultchat-backend
npm ci
```

Render must already be linked to this GitHub repo for backend auto-deploy.

---

## 1. Flip SERVER_URL to production

Edit [constants/server.ts](constants/server.ts):

```ts
// Comment the LOCAL DEV line, uncomment the PRODUCTION line.
// export const SERVER_URL = 'http://10.42.49.151:3002';
export const SERVER_URL = 'https://api.corefinite.com';
```

The pre-check script in step 3 will fail loudly if you forget this.

---

## 2. Bump version

Bump both [app.json](app.json) and [package.json](package.json) before every Play Store / TestFlight upload:

- `expo.version` (semver, user-visible)
- `expo.android.versionCode` (must increase monotonically)
- `version` in package.json (keep in sync with expo.version)

---

## 3. Run the production pre-check

```bash
npm run prod:precheck
```

Verifies:
- SERVER_URL is https and not a private IP
- app.json has version + versionCode + bundleIdentifier + EAS project id
- google-services.json exists
- backend serviceAccountKey.json and .env are NOT tracked by git
- Sentry plugin is wired up

Must exit 0 before continuing.

Optional: `npm run prod:check` also runs lint + tsc. Typecheck has pre-existing TS errors that don't block the Metro bundler — review the output but builds may proceed.

---

## 4. Deploy backend (Render)

```powershell
pwsh scripts/deploy-backend.ps1 -CommitMessage "Deploy backend X"
```

This script:
1. Syntax-checks `server.js`, `firebaseAdmin.js`, and every file in `routes/`.
2. Commits + pushes [vaultchat-backend/](vaultchat-backend/) to GitHub master.
3. Polls `https://api.corefinite.com/health` until it returns 200 (timeout 180 s).

Render env vars (set in Render dashboard, NOT in code):
- `PORT` (Render injects this)
- `EMAIL_USER`, `EMAIL_PASS` — Nodemailer SMTP
- `APP_URL` — `https://vaultchat.app`
- `GOOGLE_APPLICATION_CREDENTIALS` — path to the secret-file mount for `serviceAccountKey.json` (Render → Secret Files)

See [vaultchat-backend/.env.example](vaultchat-backend/.env.example).

---

## 5. Deploy Firestore rules + indexes

```bash
npm run deploy:firestore:rules
npm run deploy:firestore:indexes
```

Or manually in Firebase Console → Firestore → Rules / Indexes. Composite indexes needed:

| Collection | Fields |
|------------|--------|
| channels | subscribers (Array), lastPostAt (DESC) |
| inviteLinks | chatId (ASC), createdBy (ASC), createdAt (DESC) |
| loginHistory | loginAt (DESC) |
| scheduledMessages | sent (ASC), sendAt (ASC) |
| vaultbeam | recipientUid (ASC), status (ASC) |
| messages | msgType (ASC), createdAt (DESC) |
| posts | createdAt (DESC) |
| securityEvents | timestamp (DESC) |
| alerts | read (ASC), createdAt (DESC) |

---

## 6. Build the Android app

### Option A — EAS cloud build (recommended for store releases)

```powershell
pwsh scripts/deploy-android.ps1 -Mode eas
```

Output is an `.aab` you download from the EAS dashboard.

### Option B — Local APK (sideload / internal testing)

```powershell
pwsh scripts/deploy-android.ps1 -Mode local
```

Output: `android/app/build/outputs/apk/release/app-release.apk`

### Option C — Local AAB (Play Store upload, no EAS quota)

```powershell
pwsh scripts/deploy-android.ps1 -Mode aab
```

Output: `android/app/build/outputs/bundle/release/app-release.aab`

---

## 7. Submit to Play Store

```bash
npm run eas:submit:android
```

Or upload the `.aab` manually at https://play.google.com/console.

---

## 8. iOS (when ready)

```bash
npm run eas:build:ios:prod
npm run eas:submit:ios
```

---

## Available npm scripts

### Frontend (root)
| Script | Purpose |
|--------|---------|
| `npm run prod:precheck` | Pre-flight gate before any prod build |
| `npm run prod:check` | lint + typecheck (advisory) |
| `npm run typecheck` | TS-only check |
| `npm run prebuild:android` | Regenerate android/ from app.json |
| `npm run build:android:apk` | Local APK build |
| `npm run build:android:aab` | Local AAB build |
| `npm run eas:build:android:preview` | EAS preview channel build |
| `npm run eas:build:android:prod` | EAS production channel build |
| `npm run eas:build:ios:prod` | EAS iOS production build |
| `npm run eas:submit:android` | Submit latest EAS build to Play Store |
| `npm run eas:submit:ios` | Submit latest EAS build to App Store |
| `npm run deploy:firestore` | Deploy rules + indexes |

### Backend
| Script | Purpose |
|--------|---------|
| `npm start` | Run server (Render uses this) |
| `npm run start:prod` | Same with NODE_ENV=production explicit |
| `npm run dev` | nodemon, local dev |
| `npm run lint:syntax` | node --check every file |
| `npm run health` | curl /health on local instance |

---

## Known pre-existing issues (non-blocking)

- ~177 TypeScript errors across `app/`, `services/`, `utils/`. These do not block the Metro bundler (RN strips TS at bundle time). Track in [tsc-errors.txt](tsc-errors.txt).
- `services/faceRecognitionService.ts` imports `@tensorflow/tfjs` which is not in package.json. The file is not imported anywhere, so it does not affect the bundle. Either delete the file or add the dep + fix the imports.
- `services/doubleRatchetService.ts:190` has `const hmac = (hmac.digest()...)` (self-reference before declaration). File is orphaned (not imported), so harmless until used.
- Regex character-class warnings in `services/aiService.ts` are TS1517 false positives — they work at runtime under Hermes/V8 because the surrogate pairs form valid ranges.

If you start using any of those orphaned services, fix the bug first.
