# VaultBeamCore.podspec — the iOS pod for the Rust-backed VaultBeam module.
# Vendors VaultBeamCore.xcframework (the Rust staticlib, built by
# services/vaultbeam/rust/build-ios-xcframework.sh) and compiles the Swift +
# ObjC bridge sources. React-Core provides RCTEventEmitter / RCTBridgeModule.
#
# Wired into the app by withVaultBeamRust.js (ios mod), which copies these
# sources under ios/VaultBeamCore and adds `pod 'VaultBeamCore', :path => ...`.
Pod::Spec.new do |s|
  s.name         = "VaultBeamCore"
  s.version      = "0.1.0"
  s.summary      = "Rust-backed VaultBeam streaming core (Design A′) for React Native iOS."
  s.homepage     = "https://vaultchat.app"
  s.license      = { :type => "Proprietary" }
  s.author       = { "VaultChat" => "srihari.balla152@gmail.com" }
  s.platforms    = { :ios => "13.4" }
  s.source       = { :path => "." }

  # Swift + ObjC RCT bridge sources.
  s.source_files = "*.{swift,m,h}"

  # The Rust staticlib packaged as an xcframework (built before `pod install`).
  s.vendored_frameworks = "VaultBeamCore.xcframework"

  # Swift finds the C ABI through the bridging header; the header lives here.
  s.pod_target_xcconfig = {
    "SWIFT_OBJC_BRIDGING_HEADER" => "$(PODS_TARGET_SRCROOT)/VaultBeamStreamRust-Bridging-Header.h",
    "HEADER_SEARCH_PATHS"        => "$(PODS_TARGET_SRCROOT)/include",
    "DEFINES_MODULE"             => "YES",
  }

  s.dependency "React-Core"
end
