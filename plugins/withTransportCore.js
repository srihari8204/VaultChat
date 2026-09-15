// Optional Rust socket carrier; no toolchain means the existing RN socket remains available.
const { withDangerousMod, withSettingsGradle, withAppBuildGradle, withMainApplication } = require('@expo/config-plugins');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

module.exports = function withTransportCore(config) {
  try { execSync('cargo ndk --version', { stdio: 'ignore' }); } catch {
    console.warn('[withTransportCore] cargo-ndk unavailable; Rust transport omitted.');
    return config;
  }
  config = withDangerousMod(config, ['android', (cfg) => {
    fs.cpSync(path.join(cfg.modRequest.projectRoot, 'plugins/transport-core-android'),
      path.join(cfg.modRequest.platformProjectRoot, 'transport-core'), { recursive: true });
    return cfg;
  }]);
  config = withSettingsGradle(config, (cfg) => {
    const line = "include ':transport-core'";
    if (!cfg.modResults.contents.includes(line)) cfg.modResults.contents += `\n${line}\n`;
    return cfg;
  });
  config = withAppBuildGradle(config, (cfg) => {
    const line = "implementation project(':transport-core')";
    if (!cfg.modResults.contents.includes(line)) {
      if (!/dependencies\s*\{/.test(cfg.modResults.contents)) throw new Error('TransportCore: app dependencies block missing');
      cfg.modResults.contents = cfg.modResults.contents.replace(/dependencies\s*\{/, (match) => `${match}\n    ${line}`);
    }
    return cfg;
  });
  return withMainApplication(config, (cfg) => {
    const line = 'add(com.vaultchat.transportcore.TransportCorePackage())';
    if (!cfg.modResults.contents.includes(line)) {
      if (!cfg.modResults.contents.includes('.packages.apply {')) throw new Error('TransportCore: Kotlin package registration point missing');
      cfg.modResults.contents = cfg.modResults.contents.replace('.packages.apply {', `.packages.apply {\n              ${line}`);
    }
    return cfg;
  });
};
