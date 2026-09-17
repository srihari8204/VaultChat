# Harden the 2026-09-17 audit findings

## Why

Four parallel architecture audits of VaultChat found 16 defects that survive today's
build. They fall into four clusters, and the first two are live on real handsets:

1. **Account data outlives its account.** The forced sign-out path clears tokens and
   nothing else, and the E2EE identity is in no purge list at all — so the next person
   to sign in on the same phone inherits the previous user's messages, media, PIN
   record and *cryptographic identity*.
2. **Three security controls are decorative.** Brute-force detection has no reachable
   caller, `wipeAllKeys()` deletes keys nothing writes any more, and a chat locked with
   "PIN **and** biometric" opens on either one alone.
3. **Money is parsed inconsistently.** A shopkeeper typing `1,200` stores ₹0 at seven
   unguarded writes, and NaN walks through `<=` guards into a rendered amortisation
   schedule and an exported PDF.
4. **Dead code with side effects.** A module that replaces the global notification
   handler at import time, a layering inversion, and 19 copies of one hook.

## What changes

- Extract one `purgeAccountData()` and call it from BOTH sign-out paths; add the
  E2EE identity and the per-user keys to it.
- Move `pinAttempts` into `pinStore.verifyPin`, the one function every live PIN path
  already routes through, and make `wipeAllKeys()` call the real purge.
- Require both factors when `lockMethod === 'both'`; stop `verifyBiometric` returning
  `true` on web.
- Gate the permission check BEFORE the network read in `family-member` and
  `group-insights`.
- Give shop-book the same thousands-separator rule finance already has, and gate the
  seven unguarded money writes with `isNum`.
- Flip two `<=` guards that NaN walks through; bound the interest duration; fix the
  CSV round-trip.
- Delete `breachCheck.ts` and `utils/notifications.ts`; remove the `lib → app` import;
  extract `useAuthHeader()`.

## Non-goals

- **No screen deletions.** There is no git in this repo, so deletion is unrecoverable
  and stays an explicit owner decision.
- No change to the wire protocol, the CC-Wire auth model, or the call engine.
- No iOS CallKit, no `quality.ts` wiring, no `peer_muted` — all three need a device.

## Success

`tsc` clean, every existing selftest still passing, a new guard per fixed class that is
demonstrated to FAIL when the fix is reverted, and a release APK that installs and runs.
