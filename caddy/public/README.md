# caddy/public — files served straight from the edge

Bind-mounted read-only into Caddy at `/srv/public` (see `docker-compose.yml`).
Because it is a bind mount and Caddy's `file_server` reads per request, editing a
file here takes effect **immediately** — no rebuild, no restart, no reload.

| File | Served at | Why it must exist |
|---|---|---|
| `privacy.html` | `/privacy` | Play will not publish without a reachable privacy policy |
| `delete-account.html` | `/delete-account` | Play requires a web deletion path for account-holding apps |
| `assetlinks.json` | `/.well-known/assetlinks.json` | Android App Links — makes `/live/join/<code>` open the app |

## ⚠️ assetlinks.json — ONE REQUIRED EDIT AFTER YOUR FIRST PLAY UPLOAD

The fingerprint currently listed is `vaultchat-release.jks`. Under **Play App
Signing** that is only the *upload* key: Google re-signs the app with its own
app-signing key before delivering it, so an installed Play build presents a
**different** certificate, the verifier finds no match, and every Private Live
invitation link silently falls back to opening a browser tab. Nothing errors —
the feature just stops working for everyone who installed it the normal way.
Play App Signing is mandatory for new apps shipping an AAB, so this is a
certainty, not a risk.

**The fix (additive — keep BOTH entries so local test builds keep verifying):**

1. Play Console → your app → Test and release → App integrity →
   *App signing key certificate* → copy the **SHA-256**.
2. Add it to the `sha256_cert_fingerprints` array below the existing one.
3. That's the whole change — the bind mount picks it up instantly. Confirm with:

   ```bash
   curl -s https://api.corefinite.com/.well-known/assetlinks.json
   adb shell pm verify-app-links --re-verify com.vaultchat.app
   adb shell pm get-app-links com.vaultchat.app     # expect "verified"
   ```

This file used to be a `respond` string inlined in the Caddyfile, which meant the
fix above required editing server config and restarting Caddy. It is a file now
precisely so that step-2 edit is a one-line change to a JSON file.
