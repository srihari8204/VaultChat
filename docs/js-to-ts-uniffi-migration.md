# JS → TS + UniFFI migration inventory

Owner direction: the application should move to **React Native/TSX UI + TypeScript wrappers + UniFFI/Rust native cores** without breaking current behavior.

## Current state

- Mobile app runtime source under `app/`, `components/`, `lib/`, `services/`, `utils/`, `constants/`, `db/`, `hooks/`, `types/` and `shims/` is already TypeScript/TSX.
- The remaining root/mobile `.js` files are mostly Node entry points that Expo, Metro, Babel, config plugins, or npm scripts currently load directly.
- The old `vaultchat-backend/` package is JavaScript/CommonJS and has its own `package.json` scripts.
- Existing Rust/native cores already exist for crypto, transport, nav, vaultbeam and the UniFFI money core in `rust/vaultcore`, which is reached through the existing crypto Nitro bridge.

## Re-audit result, 2026-09-21

Working tree JS/JSX files, excluding `node_modules`, generated native projects, `dist` and `build`:

- `app/`, `components/`, `constants/`, `db/`, `hooks/`, `lib/`, `services/`, `shims/`, `types/` and `utils/`: 0 runtime JS/JSX files.
- Root config: 4 JS files, `babel.config.js`, `eslint.config.js`, `metro.config.js`, `react-native.config.js`.
- Expo config plugins: 18 JS files under `plugins/`.
- Root scripts: 14 JS files under `scripts/`.
- Node backend: 54 JS files under `vaultchat-backend/`.
- Go backend interop: `vaultchat-backend-go/internal/vault/interop_node.js`.

Total remaining JS/JSX outside generated folders: 91 files. The app runtime is clean. The remaining JS is build tooling, backend/server code, load tests, contracts and one explicit Go interop helper.

## Backend, DB and server status

- `vaultchat-backend/` is still a CommonJS Node server. `package.json` starts `server.js`, migrations run through `migrate.js`, PM2 uses `ecosystem.config.js`, and contracts/load tests call JS entry points directly.
- `vaultchat-backend/tsconfig.json` exists but is only an empty shell extending Expo config; it is not a backend TypeScript build yet.
- DB schema work is SQL by design. Migrations, RLS tests and partitioning scripts should stay `.sql`; there is no TypeScript or UniFFI migration to do for SQL files.
- UniFFI/Rust should not own DB handles, Express routes, Socket.IO/Kafka authority, RLS policy, migration application, or PM2 deployment. Those are server authority and operational surfaces, not pure deterministic helpers.
- Safe backend migration order is: add a backend TypeScript build (`src` to `dist`) while keeping `server.js` as the deployed entry, convert leaf utility modules, convert route modules, convert contract/loadtest scripts, then move `server.js` and `migrate.js` last after syntax checks, contract tests and migration status all pass.

## Safe order

1. Keep all visual UI in TSX. Glassmorphism, icons, layout, animations and accessibility stay in React Native.
2. Route native logic through TypeScript wrappers. Screens call wrappers, wrappers choose native Rust/UniFFI or TS fallback.
3. Preserve TypeScript fallback for every native helper until parity tests, release build and physical-device verification pass.
4. Convert mobile runtime JS only if it appears under app source. A guardrail now prevents new runtime `.js` files there.
5. Convert scripts one by one, updating `package.json` commands from `node file.js` to `tsx file.ts` only after each script is tested.
6. Keep Expo/Metro/Babel/config-plugin `.js` files until the build path is proven with `expo prebuild` and release APK.
7. Migrate `vaultchat-backend/` separately: add backend TypeScript config/build, convert leaf modules first, then routes, then `server.js`/`migrate.js`.
8. Move only pure deterministic helpers to UniFFI/Rust: codecs, math, layout/view-model helpers, crypto-adjacent helpers, file chunk helpers. Do not move UI, hooks, sockets, DB handles or server authority into Rust.

## JS files that should stay JS for now

- `babel.config.js`
- `eslint.config.js`
- `metro.config.js`
- `react-native.config.js`
- `plugins/*.js`
These are loaded by Node/Expo tooling as JavaScript today. Rename only after the toolchain supports the new entry point and a release build proves it.

## First implementation already added

- `lib/nativeCore.ts` provides the shared TypeScript gate for optional Rust/UniFFI cores.
- `services/crypto/index.ts` now uses that gate while preserving the default TypeScript fallback.
- `lib/jsToTsMigration.selftest.ts` prevents new mobile runtime `.js/.jsx` files under app source directories.
- `scripts/check-sdk-versions.js` migrated to `scripts/check-sdk-versions.ts`; `package.json` now invokes it with `tsx`.
- `scripts/check-native-libs.js` migrated to `scripts/check-native-libs.ts`; it remains a standalone APK artifact check.
- `shims/react-native-webrtc.js` migrated to `shims/react-native-webrtc.ts`; Metro's web-only alias now resolves the TypeScript shim.
- `scripts/check-migration-drift.js` migrated to `scripts/check-migration-drift.ts`; `package.json` now invokes it with `tsx`.
- `npm run check:ts-uniffi` now runs the JS runtime guard and native support guard together.
