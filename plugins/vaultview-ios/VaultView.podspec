# VaultView.podspec — iOS pod for the VaultView screen guard + pixel modules.
# Pure Swift/ObjC, no vendored binaries: UIKit supplies capture detection and
# AVFoundation/CoreGraphics supply the pixel work.
#
# Wired into the app by withVaultView.js (ios mod), which copies these sources
# under ios/VaultView and adds `pod 'VaultView', :path => ...` to the Podfile.
Pod::Spec.new do |s|
  s.name         = "VaultView"
  s.version      = "0.1.0"
  s.summary      = "VaultView protected-media guard and tracking-ID codec for React Native iOS."
  s.homepage     = "https://vaultchat.app"
  s.license      = { :type => "Proprietary" }
  s.author       = { "VaultChat" => "srihari.balla152@gmail.com" }
  s.platforms    = { :ios => "13.4" }
  s.source       = { :path => "." }

  s.source_files = "*.{swift,m,h}"

  s.pod_target_xcconfig = {
    "DEFINES_MODULE" => "YES",
  }

  s.frameworks = "UIKit", "AVFoundation", "CoreGraphics"
  s.dependency "React-Core"
end
