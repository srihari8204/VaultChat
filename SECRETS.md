# Secrets audit

Checked with `git ls-files` against the working tree — not assumed from `.gitignore`.
Nothing here has been committed; the `.gitignore` edit and one `git rm --cached`
are **staged only**.

## What is actually tracked in git

> **RE-VERIFIED 2026-10-01 against the working tree. Three rows below were wrong.**
> This audit was written on a machine (or at a time) where the release key existed.
> It does not exist here, and the owner confirms **no release keystore has ever been
> created and the app has never been uploaded to Play**. Corrected inline.

| File | On disk | Tracked in git | Severity |
|---|---|---|---|
| `vaultchat-release.jks` | **NO — absent** (was recorded as "yes, 4.4 KB") | **no** — ignored at `.gitignore:80` | — |
| `keystore.properties` | **NO — absent** (was recorded as "yes, 187 B") | **no** — ignored at `.gitignore:81` | — |
| `.env` | **NO — absent.** `.env.local` (598 B) is what exists | **no** — ignored by `*.env` at `.gitignore:49` | — |
| `google-services.json` | yes (1.3 KB) | **WAS TRACKED** → now `git rm --cached`, staged | low |
| `vaultchat-backend/android/app/debug.keystore` | yes | tracked | none |
| `vaultchat-backend/.env.example` | yes | tracked | none (placeholders) |

**The upload keystore and its passwords were never in git** — and as of 2026-10-01
they do not exist at all. There is no `vaultchat-release.jks` and no
`keystore.properties` anywhere in this tree, so:

- Every release build is signed with the **debug** key. `apksigner verify
  --print-certs` on the current artifact reports `CN=Android Debug`. Google Play
  will not accept it.
- `plugins/withReleaseSigning.js` (wired at `app.json:191`) is the mechanism and
  it is **ready** — it injects a `vaultchatRelease` signingConfig and repoints
  `buildTypes.release` at it. It is a deliberate no-op while the credentials are
  missing (`:38`, `:44`), which is exactly the state we are in. Create
  `keystore.properties` with `VAULTCHAT_STORE_FILE`, `VAULTCHAT_STORE_PASSWORD`,
  `VAULTCHAT_KEY_ALIAS`, `VAULTCHAT_KEY_PASSWORD` plus the `.jks` it names, and
  the next prebuild signs properly with no code change.
- **Nothing needs rotating and no Play App Signing reset is warranted** — but for
  the opposite reason to the one originally recorded here. There is no key to
  rotate and no listing to reset, not a safe key correctly stored.
- When the key is created: back the `.jks` and `keystore.properties` up somewhere
  that is not this machine, and update this file. Note that upload-key loss is
  recoverable (Play App Signing is mandatory for new apps and Google holds the app
  signing key; the *upload* key is resettable via support) — so this is important,
  not catastrophic.

**`.env` does not exist here** (corrected 2026-10-01), so the
`GOLIVE_LIVEKIT_API_SECRET` originally described in this paragraph is not in this
tree — those LiveKit credentials live on the production box in
`docker-compose.box.yml` and `vaultchat-backend/.env`, neither of which is in any
repo. See the prod deployment notes.

What does exist is **`.env.local` (598 B)** — ignored at `.gitignore:51` and not
tracked, verified. It holds one genuinely sensitive value, `SENTRY_AUTH_TOKEN`,
plus `EXPO_PUBLIC_CRYPTO_BACKEND`, `EXPO_PUBLIC_SUPABASE_URL` and
`EXPO_PUBLIC_SUPABASE_ANON_KEY` — the `EXPO_PUBLIC_*` three ship inside the JS
bundle by design and are not secrets. No exposure, no rotation required; rotate
`SENTRY_AUTH_TOKEN` if this file is ever shared.

`vaultchat-backend/android/app/debug.keystore` is the standard Android debug
keystore — password `android`, identical on every machine, cannot sign a Play
release. Tracking it is harmless; leave it.

## `google-services.json` — what was exposed, and what to do

It was tracked. It contains:

- `project_id` / `project_number` — `vaultchatprod01` / `553821750020`
- an Android API key (`AIza…`)
- OAuth client IDs and the release signing-cert SHA-1 hash

**This is low severity and does not need rotating.** A Firebase Android API key
is not a secret: it is compiled into every APK you publish, and anyone can
extract it from the Play Store download in about a minute. Google protects it
with per-app restrictions (package name + signing certificate SHA-1), not with
secrecy. Same for the OAuth client IDs.

Two things are worth doing, neither urgent:

1. **Confirm the API key is restricted.** Google Cloud Console → APIs & Services
   → Credentials → the Android key → check that Application restrictions is set
   to *Android apps* with `com.vaultchat.app` + the release SHA-1, and that API
   restrictions lists only the APIs you actually call. An *unrestricted* key is
   the one real risk, and that risk exists whether or not it was in git.
2. **Provision the file in CI instead of committing it.** It is now ignored, so
   a fresh clone will not have it and a Gradle/EAS build will fail with
   `File google-services.json is missing`. Add it as an EAS secret file
   (`eas secret:create --type file --name GOOGLE_SERVICES_JSON`) or write it from
   a CI secret before the build step.

If you would rather keep it committed — a defensible choice, since it is public
by design and its absence breaks fresh-clone builds — undo the staged change:

```
git reset HEAD google-services.json
# and drop the google-services.json line from .gitignore
```

## Nothing was committed and no history was rewritten

The `.jks` and `keystore.properties` were never in history, so there is nothing
to purge. `google-services.json` *is* in history; given the analysis above, a
history rewrite is not worth the disruption for a value that ships in the APK.

## Contact-discovery hashing (related, not a git issue)

`users.phone_hash` is `HMAC-SHA256(VAULTCHAT_LOOKUP_PEPPER, sha256(digits))`
(column defined in `vaultchat-backend/migrations/001_init.sql:19`; the
migrations live under the legacy backend and are shared by both).

The pepper is a server-only env var and is **effectively un-rotatable**. Two
tables key off it, not one:

- `users.phone_hash` — contact discovery. Rotating makes every existing user
  undiscoverable until the column is recomputed from `users.phone`.
- `otp_codes.phone_hash` (`migrations/010_phone_otp.sql`) — **phone OTP login**.
  In-flight codes become unverifiable, so a rotation locks out anyone
  mid-signin, and this one cannot be backfilled: the rows are ephemeral.

So a rotation is a recompute of `users.phone_hash` in one transaction *plus* a
deliberate invalidation window for phone login. Back the pepper up with the same
care as the keystore; losing it is worse than losing the keystore, because the
keystore has a Play-side reset path and this does not.
