# VaultChat security — multi-indicator self-destruct (P0.2)

`threatEngine.ts` + `duressPin.ts` widen the self-destruct trigger from
"wipe on ANY single threat" to a **graded, multi-indicator** decision, wired
into `services/securityService.ts`. Pure + Node-tested
(`security.selftest.ts`, 21/21).

## How it decides

Each detected indicator becomes a `ThreatSignal` with a severity. The engine
sums severity weights and picks a proportional `level`:

| level | meaning | caller action |
|-------|---------|---------------|
| `clean` | no signals | proceed |
| `monitor` | one weak signal (e.g. ADB) | allow, flag |
| `restrict` | one strong signal or weak combo | route to `/blocked`, **no wipe** |
| `wipe` | any `critical`, or strong combination | `wipeAllKeys()` then `/blocked` |

Severities (default): root / Frida / hook framework / **repeated duress PIN** →
`critical` (instant wipe). test-keys / emulator / debugger / overlay / suspicious
IME → `high`. ADB → `medium`. Two `high` signals (or high+medium+…) cross the
wipe threshold, so *combinations* of weaker indicators self-destruct even when
none would alone — the "multi-indicator" widening.

## Behaviour change vs the old code

The old `runSecurityCheck` wiped all keys on **any** single threat, including a
lone emulator or ADB-enabled — destroying data on weak/false-positive signals.
Now lone emulator/ADB **restrict** (still blocked, no data loss); root/Frida and
strong combinations still wipe. Access denial on a threatened device is
unchanged (`report.clean` is still false → `/blocked`); only the *destructive*
wipe became proportional. New trigger added: consecutive failed/duress PIN
entries (≥3 → escalate, ≥5 → self-destruct), fed by `verifyPIN`.

## Remaining P0.2 detectors (need native modules / device)

Add as signal providers — push a `signal(type, detail)` into `runSecurityCheck`:
- **Keylogger** — enumerate enabled Android IMEs, flag non-AOSP → `SUSPICIOUS_IME`.
- **Overlay/tapjacking** — `filterTouchesWhenObscured` + overlay-package scan → `OVERLAY_DETECTED`.
- **Debugger** — native `Debug.isDebuggerConnected()` → `DEBUGGER_ATTACHED`.
- **Pegasus/IOC** — match a refreshed IOC list against installed packages / known indicators.
- **Network anomaly** — netinfo + suspicious-host list + cert pinning (native config).

Also TODO: `logThreatToFirestore` still uses `@react-native-firebase/*`, which
no-ops in prod — migrate security-event logging to a Postgres backend route.
