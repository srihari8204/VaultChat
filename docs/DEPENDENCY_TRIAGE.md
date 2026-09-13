# Dependency triage

Run: 2026-09-13, on the working tree at `hetzner-deploy` (`a57b388`).
Method: `npm audit --json` in both Node trees against their existing
`node_modules` (nothing installed, nothing upgraded), `npm ls <pkg> --all` for
every high/critical path, then source grep for whether the top-level package
that pulls it in is ever imported on a path that runs.

## The number that matters

**Four vulnerable packages are actually in the shipped app bundle. One of them
takes input the user does not control. Zero are in any process that runs in
production on the server.**

Raw totals, for the record: **59** advisories in the app tree (24 high, 3
critical) and **70** in the legacy Node tree (27 high, 3 critical). That is
higher than the 56/67 the September review quoted — nothing was added, the
advisory database moved. It will be a different number next week. The raw
count is not a health metric and should not be treated as one.

Of the 27 high/critical entries in the app tree, 23 are Metro, the Expo CLI,
eslint, jest or the SVG transformer. React Native ships only what Metro
bundles into `index.android.bundle`. A package that is only ever required by
`@expo/cli`, `metro`, `eslint` or a config plugin is not on the device at all —
it is not "unreachable code on the device", it is not present. Those 23 cannot
be exploited against a user under any circumstances, only against a developer's
laptop running `expo prebuild` on a hostile repo.

## App tree (repo root) — high and critical

| Package | Advisory | Pulled in by | In the bundle? | Do what |
|---|---|---|---|---|
| `socket.io-parser@4.2.5` | GHSA-677m-j7p3-52f9, GHSA-2m8v-j782-fhvr — unbounded binary attachments / zero-attachment memory exhaustion | `socket.io-client` → runtime, `lib/socket.ts` | **Yes** | Bump. `fixAvailable` is non-major — a lockfile change, no API surface. See risk note below. |
| `markdown-it@10.0.0` | GHSA-6vfc-qv3f-vr6c, GHSA-6v5v-wf23-fmfq — quadratic smartquotes / resource consumption | `react-native-markdown-display` | **Yes** | Nothing before launch. Only call site is `app/encrypted-notes.tsx:757`, rendering `edContent` — the user's own note, decrypted locally. The DoS input is the user's own typing. |
| `linkify-it@2.2.0` | GHSA-22p9-wv53-3rq4, GHSA-v245-v573-v5vm — quadratic scan loop | `react-native-markdown-display` → `markdown-it` | **Yes** | Same. `fixAvailable: false` — there is no fix for markdown-it 10; it would mean a major bump of `react-native-markdown-display`. Not worth it for self-inflicted lag in one screen. |
| `nanoid@3.3.11` | GHSA-28wg-ghj8-5hjv, GHSA-2v37-7h3g-55p8, GHSA-xwg4-73v4-xw9w — infinite loop / overflow on a bad `size` | `expo-router`, `@react-navigation/*` | **Yes** | Nothing. Every call site is `nanoid()` with no argument (`expo-router/build/fork/createMemoryHistory.js`, `layouts/StackClient.js`) — default size 21. All three advisories need an attacker-supplied `size`. Bundled, not triggerable. |
| `ws@8.18.3` (+ 6.x / 7.x copies) | GHSA-96hv-2xvq-fx4p — memory exhaustion from tiny fragments | `socket.io-client` → `engine.io-client`; also `ethers`, `metro`, `react-devtools-core` | **No** | Nothing. Two independent reasons: `engine.io-client`'s `browser` field maps `transports/websocket.node.js` → `transports/websocket.js`, and `ws` requires `net`, `tls`, `http`, `https` — Metro has no polyfill for any of them, so if `ws` were in the graph the release build would fail to resolve `net`, not ship. Release APKs build. RN uses the platform `WebSocket`. |
| `expo@54.0.33` | (no advisory of its own) | direct | Partly | **Do not act.** `expo` is marked HIGH purely by inheritance from `@expo/cli` and `@expo/metro`. The whole `expo-asset → expo-constants → @expo/config → @expo/config-plugins` chain is moderate and bottoms out at `@expo/plist` / `xcode` / `xml2js` — prebuild tooling. The offered fix is `expo@57`, a major SDK upgrade, for zero runtime benefit. This is the single most expensive wrong move available this week. |
| `xmldom@0.5.0` **CRITICAL** | GHSA-crh6-fp67-6883 — multiple root nodes in a DOM | `@react-native-voice/voice` → `@expo/config-plugins@2.0.4` → `@expo/plist` | **No** | Config plugin. Runs on the build machine during `prebuild`, parsing your own `Info.plist`. Note the stale pin: `@react-native-voice/voice` drags in a 2020-era `@expo/config-plugins`. Worth cleaning up sometime; not a device risk. |
| `tar@7.5.11` **CRITICAL** | GHSA-23hp-3jrh-7fpw — decompression DoS | `@expo/cli` | **No** | CLI only. |
| `shell-quote@1.8.3` **CRITICAL** | GHSA-w7jw-789q-3m8p — `quote()` does not escape newlines | `react-native` → `react-devtools-core` | **No** | Dev-menu tooling, stripped from release. |
| `node-forge@1.3.3` | 4× signature forgery / bypass | `expo-updates` → `@expo/code-signing-certificates`, `@expo/cli` | **No** | Only required from `expo-updates/cli/` (`configureCodeSigningAsync.js`, `generateCodeSigningAsync.js`). Not from `expo-updates/build/`, which is the part that gets bundled. |
| `fast-uri@3.1.0` | 7× host confusion / SSRF / traversal | `expo-dev-client` → `expo-dev-launcher` → `ajv` | **No** | Only required from `expo-dev-launcher/plugin/build/pluginConfig.js` — a config plugin, despite `expo-dev-client` sitting in `dependencies`. |
| `undici`, `postcss`, `image-size`, `metro`, `metro-config`, `metro-transform-worker`, `@expo/metro`, `@expo/metro-config`, `@expo/cli`, `browserslist`, `js-yaml`, `svgo`, `@xmldom/xmldom` | assorted | Metro / Expo CLI / `react-native-svg-transformer` | **No** | Bundler and CLI. Not present on a device. |
| `brace-expansion`, `picomatch`, `flatted` | ReDoS / prototype pollution | `eslint`, `jest-util`, `glob`, `micromatch` | **No** | Lint and test time. `flatted` is `eslint`'s cache file format. |

### The one worth a lockfile bump

`socket.io-parser`. It is genuinely in the bundle and it genuinely decodes
bytes the app did not write. The honest caveat is that those bytes come from
our own Socket.IO endpoint over TLS terminated at nginx — to exploit it you
must already be the server, or have broken TLS, at which point the parser is
not your problem. So: real reachability, low practical risk, and the fix is
free. Take the free fix, do not treat it as a launch blocker.

Worth noting that the *server* side of Socket.IO is now `zishang520/socket.io`
in Go, not this parser. Only the client half of this advisory applies to us at
all.

## Legacy Node tree (`vaultchat-backend/`) — high and critical

**Nothing in this tree runs in production.** `docker-compose.prod.yml` defines
five services: `caddy`, `go-api`, `postgres`, `redis`, `minio`. Both Node
services in the base compose file carry `profiles: ["legacy"]` (`api` at
docker-compose.yml:288, `fanout-worker` at :637), so `docker compose up` never
starts them. `nginx/sites/vaultchat.conf` proxies everything to Caddy, and
Caddy's terminal `handle` block is `reverse_proxy go-api:4000`. There is no
route to a Node process. All 30 high/critical entries here score **not
reachable at runtime**.

That is a statement about today, not a clean bill of health. The `api` service
is documented in its own comment as "the EMERGENCY ROLLBACK target". If an
incident this week ends with someone running `docker compose --profile legacy
up -d api`, every one of these goes live at the worst possible moment, on an
image built from an unpatched lockfile. **If you are keeping the rollback
option, patch this tree — that is the only reason to.**

### 17 of the 30 are pure packaging noise

`vaultchat-backend/package.json` lists `expo`, `react` and `react-native` as
*dependencies of a Node server*, along with `"android": "expo run:android"`
and `"ios": "expo run:ios"` scripts. Copy-paste from the app's manifest. They
drag in Metro, `@expo/cli`, babel and jest, which account for:

`@expo/cli`, `@expo/metro`, `@expo/metro-config`, `expo`, `metro`,
`metro-config`, `metro-transform-worker`, `image-size`, `postcss`, `nanoid`,
`browserslist`, `undici`, `@xmldom/xmldom`, `js-yaml`, `picomatch`,
`brace-expansion`, `shell-quote` — **17 of 30 high/critical entries, and a
large share of the 37 moderates.**

Deleting three lines from `package.json` removes more advisories than any
upgrade on this list, changes no behaviour, and is trivially verifiable
(`grep -rn "expo\|react-native" --include=*.js . --exclude-dir=node_modules`
returns nothing in server code). This is the cheapest real win in the whole
triage — but it is a change to a tree that is not deployed, so it is a
housekeeping task, not a launch task.

### The 13 that are real server dependencies

| Package | Advisory | Pulled in by | Reachable if the legacy profile is started | Notes |
|---|---|---|---|---|
| `multer@2.1.1` | GHSA-72gw-mp4g-v24j, GHSA-wc9g-mqfw-jrwm, GHSA-535w-7cp7-47q4 — three separate DoS via crafted multipart field names | direct | **Yes** — `routes/uploads.js` | The worst of the legacy set. Remote, pre-handler, three ways. `fixAvailable: true`, non-major. |
| `path-to-regexp@0.1.12` | GHSA-37ch-88jc-xwx2 — ReDoS via multiple route params | `express@4.22.1` | **Yes** | Needs a route with two params in one segment. Express's own dependency; fix is an express patch bump. |
| `engine.io@6.6.5` | GHSA-r635-g3xr-vw7x, GHSA-gr94-w7qr-f4j3 — polling connection exhaustion, WebTransport SID DoS | `socket.io@4.8.3` | Only if the legacy Socket.IO server is started | Go serves realtime now. |
| `ws@8.18.3` | GHSA-96hv-2xvq-fx4p | `engine.io`, `socket.io-adapter` | Same | |
| `socket.io-parser@4.2.5` | as above | `socket.io` | Same | Here it *is* the server side — attacker-controlled frames from any client. Would be the top item if this process were serving. |
| `protobufjs@7.5.4` **CRITICAL** | GHSA-xq3m-2v4x-88gg — arbitrary code execution | `firebase-admin` → `@google-cloud/firestore` → `google-gax` | **No, even under legacy** | `firebase-admin` is imported in exactly one file, `lib/callFcm.js`, and only for messaging. No `firestore()` / `getFirestore` / `.database()` call exists anywhere in the tree. firebase-admin lazy-loads those submodules, so the Firestore/gRPC stack is never required. |
| `@grpc/grpc-js@1.14.3` | GHSA-5375-pq7m-f5r2, GHSA-99f4-grh7-6pcq — malformed request crashes server | same Firestore chain | **No** | Same reason. And these are *server*-side crashes; we run no gRPC server. |
| `websocket-driver@0.7.4` **CRITICAL** | GHSA-xv26-6w52-cph6 — message corruption via protocol length headers | `firebase-admin` → `@firebase/database-compat` → `faye-websocket` | **No** | Realtime Database client. Never constructed. |
| `tar@6.2.1` **CRITICAL** | GHSA-23hp-3jrh-7fpw plus 11 others incl. path traversal | `bcrypt` → `@mapbox/node-pre-gyp` | **No** | `node-pre-gyp` runs at `npm install` to fetch a prebuilt `.node`, extracting an archive from bcrypt's own release host. Install-time, not request-time. Still worth fixing, because install-time compromise is how supply-chain attacks land — `bcrypt@6` drops `node-pre-gyp` entirely. |
| `@mapbox/node-pre-gyp@1.0.11`, `bcrypt@5.1.1` | via `tar` | direct | **No** | Same; one `bcrypt@6` bump clears all three. Major version, so it needs a hash-compat check before anyone does it casually. |
| `form-data@2.5.5` | GHSA-hmw2-7cc7-3qxx — CRLF injection | `firebase-admin` → `@google-cloud/storage` → `retry-request` → `@types/request` | **No** | Pulled in *by a `@types/` package*, which is npm packaging rot rather than a real edge. Not required by any executing code. |
| `nodemailer@8.0.2` | GHSA-p6gq-j5cr-w38f (file read / SSRF via `raw`), GHSA-2x7j-588g-ccc2 (quadratic addressparser) | direct | **No** | Listed in `package.json` and imported **nowhere**. Dead dependency — `grep -rln nodemailer --include=*.js --exclude-dir=node_modules` returns nothing. Delete it rather than upgrade it (the fix is a major bump to 10.x). |

## Go

`go.mod` declares `go 1.26` with no `toolchain` directive. The local toolchain
is `go1.26.5`, and CI resolves from `go-version-file: vaultchat-backend-go/go.mod`.

**The local 1.26.5 is not what ships.** `vaultchat-backend-go/Dockerfile` line
1 is `FROM golang:1.26-alpine AS build` — a floating minor tag. The production
binary is whatever 1.26.x the build host's Docker cache holds. The deploy
scripts (`scripts/deploy-auth-fix.sh:105`, `deploy-games.sh:134`,
`deploy-games-matches.sh:155`, `deploy-screenshot-policy.sh:51`) all run
`docker compose build go-api` **without `--pull`**, so a stale cached base
layer can pin prod to an old patch release indefinitely and silently. Nobody
would see it; there is no version assertion anywhere in the deploy path.

Fix, if you want the stdlib patches: `docker pull golang:1.26-alpine` on the
box before the next `build go-api`, or add `--pull` to those four scripts. No
code change, no `go.mod` change, no module upgrades. It costs one flag.

Module versions are not obviously stale: `golang-jwt/jwt/v5 v5.2.2` is at or
past the version that fixed its parse-memory advisory, and `pgx/v5 v5.7.4`,
`golang.org/x/crypto v0.51.0`, `golang.org/x/net v0.53.0` are all recent.

## What we could not determine

- **Which CVEs `go1.26.6` actually fixes.** `govulncheck` is not installed and
  we did not install it (out of scope for a read-only pass). Nothing here
  verified the Go dependency graph against a vulnerability database — the Go
  section above is a build-hygiene finding, not a vulnerability assessment.
  `cd vaultchat-backend-go && go run golang.org/x/vuln/cmd/govulncheck@latest ./...`
  is the one command that would close this, and it is worth running before
  launch precisely because we currently have *no* data on the Go side. The Go
  binary is the only thing serving users; it is also the only thing here we
  did not scan.
- **What is actually running on the Hetzner box right now.** Everything above
  is read from committed compose files, the Caddyfile and `nginx/sites/`. The
  nginx config carries its own warning that the live copy has drifted from the
  repo before. There is also a comment in docker-compose.yml (`"host 13000 —
  never clashes with the live pm2 app on :3000"`) implying a pm2-managed Node
  process may still exist on the host outside Docker. Nothing public routes to
  :3000 in any config we can see, but "we can see no route" is not "there is
  no process". `ssh <host> 'pm2 list; docker compose ps'` settles it in ten
  seconds and nobody has run it as part of this triage.
- **Whether Metro actually honours `engine.io-client`'s `browser` field** given
  `config.resolver.unstable_enablePackageExports = true` in `metro.config.js`.
  Metro's precedence between `exports` and `browser` subpath redirects is not
  something we verified from the resolver source. It does not change the
  conclusion — the `require('net')` argument is independent and decisive — but
  the first of the two reasons given for `ws` is asserted, not tested. A real
  test would be `npx expo export` and grepping the bundle for the ws sender.
- **Transitive advisories at moderate and below.** We triaged high and critical
  only, as asked. 31 moderates in the app tree and 37 in the legacy tree are
  untouched. Most will fall into the same Metro/CLI buckets, but that is an
  expectation, not a finding.
- **`react-native-markdown-display`'s own parser behaviour.** We established
  that its only call site renders the user's own note. We did not audit whether
  some other screen renders remote text through a markdown path by another
  route; the grep was for the package name, which would miss a re-export.
