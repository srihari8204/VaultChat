# VaultShield.podspec — iOS pod for the VaultShield device-integrity detectors.
# Pure Swift/ObjC, no vendored binaries. Wired into the app by withVaultShield.js
# (ios mod), which copies these sources under ios/VaultShield and adds
# `pod 'VaultShield', :path => ...` to the Podfile.
Pod::Spec.new do |s|
  s.name         = "VaultShield"
  s.version      = "0.1.0"
  s.summary      = "VaultShield device-integrity detectors for React Native iOS."
  s.homepage     = "https://vaultchat.app"
  s.license      = { :type => "Proprietary" }
  s.author       = { "VaultChat" => "srihari.balla152@gmail.com" }
  s.platforms    = { :ios => "13.4" }
  s.source       = { :path => "." }

  s.source_files = "*.{swift,m,h}"

  s.pod_target_xcconfig = {
    "DEFINES_MODULE" => "YES",
  }

  s.frameworks = "UIKit"
  s.dependency "React-Core"
end
