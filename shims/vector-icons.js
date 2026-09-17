// shims/vector-icons.js — what '@expo/vector-icons' resolves to (metro.config.js).
//
// WHY: the package's entry point (build/IconsLazy.js) statically requires all
// 19 families, and every family module requires its own .ttf. Metro's graph is
// built from require() calls, not from what runs, so the "lazy" getters in that
// file do not stop it: importing ONE family drags all 19 fonts into the build.
// Measured in android/app/build/generated/res/.../raw: 19 .ttf, 4,076,840 bytes,
// of which 2,022,616 belong to families this app never renders.
//
// Re-exporting only the families that are actually used keeps the other 16 out
// of the module graph entirely, so Metro never emits their fonts.
//
// Verified before writing this: nothing in node_modules imports
// '@expo/vector-icons' (only `expo` mentions it, as a version pin in
// bundledNativeModules.json), so this alias cannot starve a library.
// 2026-09-18
const Ionicons = require('@expo/vector-icons/Ionicons').default;
const MaterialCommunityIcons = require('@expo/vector-icons/MaterialCommunityIcons').default;

const bundled = { Ionicons, MaterialCommunityIcons };

// TypeScript still types the barrel as having all 19 families, so `import
// { Feather } from '@expo/vector-icons'` compiles and would arrive here as
// `undefined` — which React reports far away from the cause as "element type is
// invalid". Name it at the import site instead.
module.exports = new Proxy(bundled, {
  get(target, key) {
    if (key in target) return target[key];
    if (typeof key === 'string' && /^[A-Z]/.test(key)) {
      throw new Error(
        `@expo/vector-icons: "${key}" is not bundled. Add it to shims/vector-icons.js ` +
          `— it costs that family's entire .ttf in the APK — or use an Ionicons glyph.`,
      );
    }
    return undefined;
  },
});
