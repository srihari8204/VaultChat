module.exports = function(api) {
  // Cache keyed on the env, NOT unconditionally: the `env.production` block
  // below changes the output, so a single cached config would leak dev output
  // into a release build (or the reverse) when one process builds both.
  api.cache.using(() => process.env.BABEL_ENV || process.env.NODE_ENV);

  return {
    presets: ['babel-preset-expo'],
    env: {
      production: {
        // 268 console.log calls ship today, ~15 of them guarded by __DEV__.
        // console.log is not free in a release build — every call crosses into
        // the runtime and stringifies its arguments, and the ones inside call
        // and scroll paths run per frame.
        //
        // warn/error are KEPT on purpose: they carry real diagnostics and are
        // what Sentry turns into breadcrumbs on a crash. Only the chatter goes.
        plugins: [['transform-remove-console', { exclude: ['warn', 'error'] }]],
      },
    },
  };
};
