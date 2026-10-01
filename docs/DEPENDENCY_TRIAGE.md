# Dependency vulnerability triage

Measured 2026-10-02. **The deliverable here is the triage, not a bulk upgrade** — see
*Recommendation* for why nothing was bumped.

`docs/reviews/2026-09-08-full-stack-audit.md:178-180` instructs: "Determine actual
runtime/build exposure before assigning remediation priority." This is that
determination.

## Headline: none of the 3 criticals reach a user

| | Count |
|---|---|
| `npm audit --omit=dev` total | **45** (was 56 in the September audit) |
| critical | 3 |
| high | 14 |
| moderate | 27 |
| low | 1 |

Severity is assigned by the advisory, not by this app's usage. The decisive question is
whether the package is in the **shipped JS bundle**, which the release sourcemap answers
exactly: `android/app/build/generated/sourcemaps/react/release/index.android.bundle.map`
lists all 3,696 modules that went in.

Of the 17 critical + high findings, **3 packages ship**:

| Package | Severity | Ships? | Reachability in this app |
|---|---|---|---|
| `shell-quote` | critical | **no** | Build tooling only |
| `tar` | critical | **no** | Build tooling only |
| `xmldom` | critical | **no** | Via `@expo/plist` (iOS plist generation, build-time). Fixing it needs `--force` and a **breaking** `@react-native-voice/voice@3.1.5` |
| `markdown-it@10.0.0` | high | **YES** | Only `app/encrypted-notes.tsx:760`, rendering the user's **own** note in Preview. **No fix exists** |
| `linkify-it` | high | **YES** | Transitive under `markdown-it`; same single call path. **No fix exists** |
| `nanoid@3.3.11` | high | **YES** | `@react-navigation/*` + `expo-router` route keys. The advisory is "negative size loops indefinitely"; sizes are library-internal constants, never input → **unreachable** |
| `@xmldom/xmldom`, `brace-expansion`, `browserslist`, `fast-uri`, `image-size`, `js-yaml`, `node-forge`, `picomatch`, `postcss`, `undici`, `ws` | high | **no** | All build/dev tooling. Notably `ws` and `undici` are Node-side: React Native uses the platform WebSocket and `fetch`, not these |

## The two that genuinely ship and cannot be fixed

`markdown-it@10.0.0` (uncontrolled resource consumption) and `linkify-it` (quadratic scan
loop) are both algorithmic-complexity DoS on **input**. The exposure analysis:

- The only render site is `app/encrypted-notes.tsx:760`,
  `<Markdown>{edContent}</Markdown>` — the note the user is currently editing, behind a
  Preview toggle.
- Encrypted notes are **local-only**. They leave the device solely through
  `Sharing.shareAsync` (the OS share sheet) and are never received from another user over
  the network.
- Therefore the worst case is a user pasting a pathological markdown string into their own
  note and hanging their own UI. **There is no remote vector**: no other account can feed
  this parser.

Why it cannot be fixed: `react-native-markdown-display@7.0.2` is the **latest published
version** and still depends on `markdown-it@^10.0.0`, while markdown-it is at 15.0.2. There
is no patched release in the `^10` range. The options are:

1. **Accept, documented** (current choice). The reachability argument above is the whole
   justification, and it is strong: self-inflicted only.
2. A `package.json` `overrides` forcing `markdown-it@15` — markdown-it 10 → 15 spans five
   majors of API change and the wrapper is unmaintained, so this risks breaking a working
   feature to fix a vulnerability nobody can exploit against the user.
3. Drop the dependency and render notes as plain text, losing Markdown Preview (#142).

Revisit if note content ever becomes shareable *into* the app from another user — that
single change would turn this from self-DoS into a remote DoS, and option 2 or 3 would
become mandatory.

## Go backend

`govulncheck` is **not installed** on this host and the September audit's 11 symbol-level
findings could not be re-verified. The Go toolchain here is go1.26.5 while production runs
**go1.26.8** (`GET /build`), because `scripts/deploy.sh` always builds with `--pull`. So
the production binary is on a newer stdlib than this host can test against; re-run
`govulncheck` in CI against the deployed toolchain rather than locally.

## Recommendation: do not bulk-upgrade now

1. **Nothing reachable is fixable, and nothing fixable is reachable.** Every package with
   an available fix is build-time only; the two that ship have no fix; the third that ships
   has an unreachable advisory. A bulk `npm audit fix` would therefore churn the lockfile
   of a tree that already requires `--legacy-peer-deps` and has a fragile Windows native
   build, to remove zero user-facing risk.
2. **Never `npm audit fix --force` here.** It installs a breaking
   `@react-native-voice/voice@3.1.5` to fix a build-time XML parser.
3. **This is not a blocker for the crypto-verification phase.** That phase's rationale was
   "bump first so the ratchet is verified once", which assumed overlap. There is none:
   `services/crypto` imports `@noble/ciphers`, `@noble/curves` and `@noble/hashes`, and
   **no `@noble/*` package appears in the 45 findings**. The sets are disjoint, so a later
   bump cannot invalidate crypto verification.
4. **When it is done**, do it in a window with budget to re-verify a full APK build
   (~30 min) plus `npm test`, not alongside other work — and do the non-breaking
   `npm audit fix --legacy-peer-deps` only.
5. **Build-tooling vulnerabilities are not zero risk**, just not user-facing: `tar` and
   `shell-quote` matter if build inputs can be influenced. That is a supply-chain concern
   for CI, and the argument for doing the non-breaking fix eventually rather than never.

## How to reproduce this triage

```
npm audit --omit=dev                     # counts by severity
```

Then for any package, the reachability test that actually decides it — is it in the
shipped bundle? Search the release sourcemap (plain text, lists every bundled module) for
`node_modules/<package>/`. Do **not** grep the APK: its Hermes bytecode deduplicates the
string table and reports present strings as missing.
