# TS + UniFFI re-audit

Date: 2026-09-21

## Result

- Mobile frontend runtime source is TypeScript/TSX. Guardrail: `lib/jsToTsMigration.selftest.ts`.
- UI files under `app/` and `components/` do not call native modules directly. Guardrail: `lib/nativeBoundary.selftest.ts`.
- Native/Rust calls are still present in app-facing wrapper modules, which is the intended boundary.
- Existing Rust/native cores are artifact-present in the latest release APK: `libtransportnative.so`, `libvaultcrypto.so`, `libvaultbeamnative.so`.
- OpenSpec architecture changes validate: `app-uniffi-core-architecture` and `games-uniffi-core`.
- DB migration files are locally present through version 137. Offline latest check passed.

## Remaining JavaScript

The remaining JavaScript is not mobile UI/runtime source. It is:

- Tool config: `babel.config.js`, `metro.config.js`, `eslint.config.js`, `react-native.config.js`
- Expo config plugins: `plugins/*.js`
- Node/tool scripts under `scripts/`
- Legacy Node backend under `vaultchat-backend/`
- Go interop helper: `vaultchat-backend-go/internal/vault/interop_node.js`

These should migrate in stages. Config/plugin files remain JavaScript until `expo prebuild` and release APK prove the TypeScript loader path. The backend migration is separate from mobile UI/native migration.

## Verified commands

```text
npm run check:sdk
npx tsx scripts/check-native-libs.ts
npx tsx lib/jsToTsMigration.selftest.ts
npx tsx lib/nativeBoundary.selftest.ts
npx tsx lib/nativeDeviceSupport.selftest.ts
npm run check:migrations -- --expect 137
openspec validate app-uniffi-core-architecture --strict
openspec validate games-uniffi-core --strict
```

## Not verified

- Live DB `schema_migrations` was not checked in this shell because DB credentials are not available; the command reports `client password must be a string` without `DB_PASS`/`DB_PASSWORD`.
- The remaining JS backend was not converted in this audit. It needs its own TypeScript build/start path.
- Games UniFFI runtime is planned, not complete. The next safe task is Rummy layout parity behind a TypeScript fallback.
