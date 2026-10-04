# Verified links: `assetlinks.json` and `apple-app-site-association`

**Status: templates. Not deployed. Two values are missing from this repository**
and must come from the accounts that own them:

| Placeholder | Where to get it | Searched for in the repo (2026-10-04) |
|---|---|---|
| `REPLACE_WITH_PLAY_APP_SIGNING_KEY_SHA256` | Play Console → app → Test and release → App integrity → *App signing key certificate* → SHA-256 | not in `eas.json`, `app.json`, `caddy/public/`, `docs/` |
| `REPLACE_WITH_APPLE_TEAM_ID` | developer.apple.com → Membership → Team ID (10 characters) | not in `eas.json`, `app.json`, `docs/IOS_PARITY.md`; `eas.json` has an empty `submit.production` |

The one fingerprint that IS known is the upload key `vaultchat-release.jks`
(`5F:C1:…:1A:59`), already served for `api.corefinite.com` from
`caddy/public/assetlinks.json`. Under Play App Signing an installed Play build is
signed with Google's key instead, so both fingerprints are listed (see
`caddy/public/README.md`).

## What each link needs

| Link | Host | Android | iOS |
|---|---|---|---|
| `https://api.corefinite.com/live/join/<code>` | Caddy (this repo) | `assetlinks.json` already served; add the Play SHA-256 to `caddy/public/assetlinks.json` | AASA not served; no `associatedDomains` in `app.json` |
| `https://vaultchat.app/add/<id>`, `/join/<code>` | **not hosted by anything in this repo** | `autoVerify: false` in `app.json`; needs `assetlinks.json` on `vaultchat.app` | same as above |

## Steps

1. Fill both placeholders in the files here.
2. **vaultchat.app** (whoever hosts that domain): serve
   - `https://vaultchat.app/.well-known/assetlinks.json` ← `assetlinks.vaultchat.app.json`
   - `https://vaultchat.app/.well-known/apple-app-site-association` ← `apple-app-site-association`
     (drop the `/live/join/*` component there; it belongs to api.corefinite.com)

   Both over HTTPS, status 200, **no redirect**, `Content-Type: application/json`.
   If vaultchat.app is pointed at this server's Caddy instead, add next to the
   existing `@assetlinks` block in `caddy/Caddyfile`:

   ```caddyfile
   @aasa path /.well-known/apple-app-site-association
   handle @aasa {
   	root * /srv/public
   	rewrite * /apple-app-site-association
   	header Content-Type application/json
   	file_server
   }
   ```

   and copy the AASA file into `caddy/public/`. For api.corefinite.com that same
   block (with the `/add/*` and `/join/*` components removed) adds iOS support for
   `/live/join`.
3. App changes (app owners, not this package):
   - `app.json` android `intentFilters[1].autoVerify` → `true` (only after step 2 is live,
     or Android marks the domain unverified and still shows the chooser).
   - `app.json` ios: `"associatedDomains": ["applinks:vaultchat.app", "applinks:api.corefinite.com"]`,
     then a new iOS build (entitlement change).
4. Verify:

   ```bash
   curl -sI https://vaultchat.app/.well-known/assetlinks.json | head -3
   curl -s  https://vaultchat.app/.well-known/apple-app-site-association | python3 -m json.tool
   adb shell pm verify-app-links --re-verify com.vaultchat.app
   adb shell pm get-app-links com.vaultchat.app        # expect vaultchat.app: verified
   ```

   iOS: install the build, long-press a `https://vaultchat.app/add/…` link in Notes →
   "Open in crazzychat". Apple's CDN caches AASA; changes can take up to a day.
