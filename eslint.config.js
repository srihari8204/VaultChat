// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
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
]);
