## 1. Architecture Contract

- [x] 1.1 Review existing Rust/UniFFI/JNI modules and list which ones stay as-is versus which ones need wrapper cleanup.
- [x] 1.2 Add a shared TypeScript native-wrapper convention for self-check, fallback, telemetry and feature flags.
- [x] 1.3 Document the app-wide boundary: TSX renders UI, TypeScript wrappers select implementation, Rust/UniFFI runs pure helpers.

## 1A. JS to TS Migration

- [x] 1A.1 Inventory remaining JavaScript files and separate mobile runtime source from config/plugins/scripts/backend code.
- [x] 1A.2 Add a guardrail that fails when new mobile runtime JavaScript files appear under app source directories.
- [x] 1A.2a Add a guardrail that fails when UI files call native modules directly instead of TypeScript facades.
- [ ] 1A.3 Convert root scripts from JavaScript to TypeScript one at a time, updating package scripts and validating each command. Started with `scripts/check-sdk-versions.ts`.
- [ ] 1A.4 Convert the legacy Node backend to TypeScript in a separate backend build path, starting with leaf modules and tests.
- [ ] 1A.5 Keep Expo/Metro/Babel/config-plugin JavaScript entry points until prebuild and release APK prove TypeScript entry points work.

## 2. First Module Migration

- [ ] 2.1 Complete `games-uniffi-core` first, starting with Rummy layout parity.
- [ ] 2.2 Build release APK after the first migrated helper is wired behind fallback.
- [ ] 2.3 Install on physical Android devices and verify the migrated screen in portrait and landscape.

## 3. Broader Module Rollout

- [ ] 3.1 Migrate money/math helpers only after parity fixtures cover current TypeScript behavior.
- [ ] 3.2 Migrate protobuf encode/decode helpers only after the current protobuf migration is stable.
- [ ] 3.3 Migrate local DB transform helpers only when the function is pure and fixture-testable.
- [ ] 3.4 Migrate route/map math only when it does not replace Valhalla road-distance authority.
- [ ] 3.5 Migrate file-transfer chunk helpers only with vector tests and rollback fallback.

## 4. Validation and Delivery

- [ ] 4.1 Run focused TypeScript selftests and Rust unit tests for each migrated module.
- [ ] 4.2 Run release APK build after each native module is wired.
- [ ] 4.3 Device-verify each migrated module before marking it shipped.
- [ ] 4.4 Run Ponytail review of each affected diff to remove unnecessary bridge abstractions.
- [ ] 4.5 Keep backend deploy and DB migration tasks separate; this architecture change has no DB migration by itself.
