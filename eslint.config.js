// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    // GENERATED OUTPUT IS NOT SOURCE. `android/` and `ios/` are produced by
    // `expo prebuild`, and `android/app/build/` additionally holds the bundled
    // JS that gradle emits — thousands of lines of transpiled `var` that
    // reported ~700 `no-var` errors against code nobody writes and every build
    // regenerates. Linting them is noise that buries real findings, which is
    // exactly what it did: 776 total errors, of which 698 came from here.
    ignores: ['**/dist/**', 'android/**', 'ios/**', '**/node_modules/**'],
  },
  {
    // scripts/ and the Expo config plugins are Node CLI code, not React Native.
    // eslint-config-expo assumes the RN runtime, so Node globals (__dirname,
    // require, module, process) read as undefined and every use reports a false
    // `no-undef`. Declaring the environment fixes the cause rather than
    // sprinkling eslint-disable comments at each call site.
    files: ['scripts/**/*.js', 'plugins/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
  {
    // Two scripts under scripts/ are ES MODULES, not CommonJS: they are entry
    // points bundled by esbuild (build-routing-asset.js), which resolves ESM
    // natively. The blanket `sourceType: 'commonjs'` above made eslint report
    // their `import` lines as a hard PARSE ERROR — the file was never linted at
    // all, so nothing else in it could ever be checked. Narrower override, so
    // the rest of scripts/ stays CommonJS.
    files: ['scripts/routing-entry.js', 'scripts/maplibre-shim.js', 'scripts/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        window: 'readonly',
        require: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
      },
    },
  },
  {
    // The legacy Node backend (prod runs vaultchat-backend-go; this tree is
    // kept for its migrations and history). Same root cause as scripts/: Node
    // globals judged against an RN config. Declaring the environment turns ~70
    // false `no-undef` into nothing without editing a line of runtime code.
    // vaultchat-backend-go/internal/vault/interop_node.js is included here for
    // the same reason: it is a Node helper the Go vault shells out to, not Go
    // and not RN.
    files: ['vaultchat-backend/**/*.js', 'vaultchat-backend-go/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        URL: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
        fetch: 'readonly',
      },
    },
  },
  {
    // k6 load-test scripts. `k6`, `k6/http` and `k6/metrics` are resolved by
    // the k6 binary at run time and are deliberately NOT npm dependencies, so
    // import/no-unresolved can never be satisfied here; `__ENV` is k6's own
    // global. Neither is a defect — this file is not part of the app build.
    files: ['vaultchat-backend/loadtest/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { __ENV: 'readonly', console: 'readonly', __dirname: 'readonly', require: 'readonly' },
    },
    rules: { 'import/no-unresolved': 'off' },
  },
  {
    // A stray React Native screen sitting in the backend tree. Its two native
    // deps (vision-camera face detector, worklets-core) are not installed in
    // this workspace, so the unresolved imports are a fact about where the file
    // lives, not a bug in it. Flagged here rather than silently ignored so the
    // misplacement stays visible.
    files: ['vaultchat-backend/app/**/*.tsx'],
    rules: { 'import/no-unresolved': 'off' },
  },
]);
