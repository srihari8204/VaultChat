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
    const envInputs = [
      '// VaultChat CC-Wire release inputs: invalidate Hermes when rollout values change.',
      'tasks.matching { it.name.startsWith("createBundle") && it.name.endsWith("JsAndAssets") }.configureEach {',
      '    inputs.file(rootProject.file("../.env.production"))',
      '    inputs.property("vaultchatTransportRustPct", providers.environmentVariable("EXPO_PUBLIC_FLAG_TRANSPORT_RUST_PCT").orElse(""))',
      '    inputs.property("vaultchatWebTransportUrl", providers.environmentVariable("EXPO_PUBLIC_CCWIRE_WEBTRANSPORT_URL").orElse(""))',
      '}',
      '',
    ].join('\n');
    if (!cfg.modResults.contents.includes('vaultchatTransportRustPct')) cfg.modResults.contents += `\n${envInputs}`;
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
