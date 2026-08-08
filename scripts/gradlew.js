#!/usr/bin/env node
/**
 * scripts/gradlew.js — invoke the Gradle wrapper, from any platform's npm.
 *
 * WHY THIS EXISTS
 * ---------------
 * The build scripts used `cd android && ./gradlew assembleRelease`. npm runs
 * scripts through cmd.exe on Windows, where `./gradlew` is a syntax error:
 *
 *     '.' is not recognized as an internal or external command
 *
 * cmd needs `gradlew.bat`, POSIX shells need `./gradlew`, and no single string
 * works in both — hence a tiny runner instead of a clever one-liner.
 *
 * It also fixes the second thing that stops this build cold: Gradle reads
 * JAVA_HOME, and a JAVA_HOME left pointing at an uninstalled JDK (every JDK
 * patch upgrade does this) fails before compiling anything. If JAVA_HOME is
 * missing or stale we derive the real JDK from the `java` on PATH and pass it
 * as -Dorg.gradle.java.home, so the build works without editing machine-wide
 * environment variables.
 *
 * Usage:  node scripts/gradlew.js assembleRelease [...gradle args]
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ANDROID = path.join(__dirname, '..', 'android');

if (!fs.existsSync(ANDROID)) {
  console.error('\n  android/ does not exist — run `npx expo prebuild --platform android` first.\n');
  process.exit(1);
}

const isWin = process.platform === 'win32';
const wrapper = path.join(ANDROID, isWin ? 'gradlew.bat' : 'gradlew');
if (!fs.existsSync(wrapper)) {
  console.error(`\n  Gradle wrapper missing at ${wrapper} — re-run prebuild.\n`);
  process.exit(1);
}

/** A JDK home is usable if it actually contains a compiler. */
function usable(home) {
  if (!home) return false;
  const javac = path.join(home, 'bin', isWin ? 'javac.exe' : 'javac');
  return fs.existsSync(javac);
}

/** Ask the `java` on PATH where it lives — `java.home` is the JDK root.
 *  -XshowSettings writes the properties to stderr, so read both streams. */
function javaHomeFromPath() {
  const r = spawnSync('java', ['-XshowSettings:properties', '-version'], { encoding: 'utf8' });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const m = text.match(/java\.home\s*=\s*(.+)/);
  return m ? m[1].trim() : null;
}

const args = process.argv.slice(2);
const env = { ...process.env };

// android/sentry.properties carries no org/project — it falls back to SENTRY_ORG
// / SENTRY_PROJECT / SENTRY_AUTH_TOKEN, which aren't set locally, so the
// source-map upload task fails the whole build with:
//     error: An organization ID or slug is required (provide with --org)
// eas.json already sets this for the cloud production profile; local Gradle
// never reads eas.json, so mirror it here. Set it to "false" yourself (with the
// SENTRY_* vars populated) when you do want maps uploaded.
if (env.SENTRY_DISABLE_AUTO_UPLOAD === undefined) env.SENTRY_DISABLE_AUTO_UPLOAD = 'true';

if (!usable(env.JAVA_HOME)) {
  const stale = env.JAVA_HOME;
  const detected = javaHomeFromPath();
  if (usable(detected)) {
    console.log(stale
      ? `\n  JAVA_HOME points at a JDK that is not installed:\n    ${stale}\n  Using the JDK on PATH instead: ${detected}\n  (fix it permanently: setx JAVA_HOME "${detected}" /M)\n`
      : `\n  JAVA_HOME is not set — using the JDK on PATH: ${detected}\n`);
    // Override JAVA_HOME for the child rather than passing
    // -Dorg.gradle.java.home: the wrapper is a .bat, which Node can only spawn
    // through a shell, and a JDK path containing a space ("C:\Program Files\…")
    // is word-split into an invalid value by that shell. An env var carries the
    // space intact and Gradle reads it the same way.
    env.JAVA_HOME = detected;
  } else {
    console.error('\n  No usable JDK found. Install JDK 17 and set JAVA_HOME, then retry.\n');
    process.exit(1);
  }
}

const r = spawnSync(wrapper, args, { cwd: ANDROID, stdio: 'inherit', env, shell: isWin });
process.exit(r.status ?? 1);
