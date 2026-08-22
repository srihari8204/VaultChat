# Go-live smoke test

Twenty minutes on two phones. Every check here exists because it covers a change
that was verified **only in simulation** — the logic is proven, the integration
is not, and this project's own history is emphatic that reading the code
produces the wrong answer where devices are involved.

Do this **after** `scripts/deploy-auth-fix.sh` and **before** promoting the
Play release beyond internal testing.

Two phones, both on the same new build. Install it fresh — do not update over an
old one for step 1, because the thing being tested is a first-run path.

---

## 0. The deploy actually landed

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST https://api.corefinite.com/auth/mpin/set \
  -H 'Content-Type: application/json' \
  -d '{"userId":"00000000-0000-0000-0000-000000000000","mpin":"246813"}'
```

**401.** Anything else — especially 200 or 404 — means the old binary is still
running and the account takeover is live. Stop here if so.

```bash
curl -sI https://api.corefinite.com/privacy | head -1
curl -sI https://api.corefinite.com/delete-account | head -1
```

Both **200**. Google fetches these during review; a 404 fails the submission,
and they only work once the Caddy edits from the deploy script are applied.

---

## 1. Signup on a real device  ← the highest-risk change

The fix changed the signup contract: `/profile/init` now returns a setup ticket
and the next two calls require it. Existing accounts are unaffected, so a
mismatch here would ship looking completely healthy and break **only new users**.

- [ ] Fresh install, create a brand-new account end to end: email OTP → profile →
      5 security questions → MPIN → lands in Chats.
- [ ] Force-quit, reopen, unlock with the MPIN.

If signup dies at the security-questions or MPIN step, the app and server are
out of step — deploy them together.

## 2. Messaging, and the re-key loop

The symptom this replaces: both phones showing "unable to decrypt" while sending
kept working, resets alternating roughly every two minutes.

- [ ] Send messages both directions. All readable.
- [ ] Leave the chat open and idle **five minutes**, send again both ways.
- [ ] Force-quit both apps, reopen, send again both ways.
- [ ] Scroll up through old history — no wall of "unable to decrypt".

Watch for it: `adb logcat | grep -i "e2ee"`. Occasional resets are fine. Resets
**alternating between the two phones on a repeating cycle** are the old bug, and
mean the fix did not take.

## 3. Calls — the teardown fix

- [ ] A calls B. B answers. Talk both ways. Hang up from each side once.
- [ ] **The one that matters:** while A and B are on a call, have a third account
      (or the same account on another device) call B. Answer it. The first call
      ends — expected, there is no call waiting — and the **second call must stay
      connected for at least 30 seconds**. Before the fix it died within a second
      or two of connecting, because the first screen's teardown hung it up.
- [ ] Press back during a call → it goes to picture-in-picture, does not end.

## 4. Locked-screen ringing

- [ ] During onboarding, the amber **"Full-screen calls"** row appears. Tap
      *Allow ›*, grant it in Settings, come back — the row disappears on its own.
- [ ] Lock the phone. Call it. A **full call screen** appears, not a small banner.

If the row never appeared, the grant was already given (or the phone is Android
13 or older) — that is fine.

## 5. Policy links and deletion

- [ ] Settings → Privacy & Security → **Privacy Policy** opens the real page in
      a browser.
- [ ] On a **throwaway account**: Settings → Delete account, confirm twice.
- [ ] Try to log back into it. You cannot — and you should not be able to
      recover it with the security questions either.

⚠️ Deletion is irreversible now. Do not test it on your own account.

---

## If anything fails

Capture it before changing anything:

```bash
adb logcat -d > /tmp/vaultchat-$(date +%s).log     # -d, so adb is not killed
adb shell dumpsys notification --noredact          # run DURING a ring for call bugs
```

`dumpsys` during a live ring is what found six call defects that reading the
code did not.
