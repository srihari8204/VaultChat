# Secrets audit

Checked with `git ls-files` against the working tree — not assumed from `.gitignore`.
Nothing here has been committed; the `.gitignore` edit and one `git rm --cached`
are **staged only**.

## What is actually tracked in git

| File | On disk | Tracked in git | Severity |
|---|---|---|---|
| `vaultchat-release.jks` | yes (4.4 KB) | **no** — ignored at `.gitignore:80` | — |
| `keystore.properties` | yes (187 B) | **no** — ignored at `.gitignore:81` | — |
| `.env` | yes (3.9 KB) | **no** — ignored by `*.env` at `.gitignore:49` | — |
| `google-services.json` | yes (1.3 KB) | **WAS TRACKED** → now `git rm --cached`, staged | low |
| `vaultchat-backend/android/app/debug.keystore` | yes | tracked | none |
| `vaultchat-backend/.env.example` | yes | tracked | none (placeholders) |

**The upload keystore and its passwords were never in git.** The release signing
key (`vaultchat-release.jks`) and `keystore.properties` (which holds
`VAULTCHAT_STORE_PASSWORD` and `VAULTCHAT_KEY_PASSWORD`) are present on disk only
and are correctly ignored. No rotation is required for them, and no Play App
Signing key reset is warranted.

`.env` is likewise untracked. It contains one genuinely sensitive value
(`GOLIVE_LIVEKIT_API_SECRET`, alongside `GOLIVE_LIVEKIT_KEYS` /
`GOLIVE_LIVEKIT_API_KEY`); the rest are public endpoints and `EXPO_PUBLIC_*`
flags that ship in the bundle anyway. No exposure, no rotation required.

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
