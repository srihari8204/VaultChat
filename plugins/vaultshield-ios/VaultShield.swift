import Foundation
import UIKit
import React

/**
 VaultShield — iOS device-integrity detectors.

 The native half of the Device Security & Monitoring module on iOS. Reports raw
 booleans; the DECISION stays in the pure JS core. Never blocks, never wipes.

 What this platform allows, stated plainly (the JS layer's confidence weights
 depend on it):

   Jailbreak   — heuristic. Classic artifacts (Cydia/apt/bash/sshd), a fork()
                 that succeeds, and a write outside the sandbox are strong tells,
                 but a jailbreak with good hiding can defeat them. Reported as a
                 single `jailbroken` with the reason.

   Debugger    — reliable. sysctl(KERN_PROC) exposes the P_TRACED flag.

   Frida/hooks — heuristic. Scan the loaded dyld images for known instrumentation
                 dylibs; a determined attacker can rename them.

   Simulator   — reliable via the SIMULATOR_* environment.

 One `scan` call returns the whole pass, matching the Android module's shape so
 the JS bridge maps both identically.
 */
@objc(VaultShield)
class VaultShield: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool { false }

  // ── Jailbreak ──────────────────────────────────────────────
  private let jbPaths = [
    "/Applications/Cydia.app", "/Library/MobileSubstrate/MobileSubstrate.dylib",
    "/bin/bash", "/usr/sbin/sshd", "/etc/apt", "/private/var/lib/apt/",
    "/usr/bin/ssh", "/private/var/lib/cydia", "/var/jb",
  ]

  private func jailbreakReason() -> String? {
    #if targetEnvironment(simulator)
    return nil
    #else
    for p in jbPaths where FileManager.default.fileExists(atPath: p) { return "path:\(p)" }
    // Can we write outside our sandbox? A stock device cannot.
    let probe = "/private/vaultshield_\(UUID().uuidString).txt"
    do {
      try "x".write(toFile: probe, atomically: true, encoding: .utf8)
      try? FileManager.default.removeItem(atPath: probe)
      return "sandbox-escape"
    } catch { /* expected on a stock device */ }
    // cydia:// scheme registered?
    if let url = URL(string: "cydia://package/com.example"), UIApplication.shared.canOpenURL(url) {
      return "cydia-scheme"
    }
    return nil
    #endif
  }

  // ── Debugger (P_TRACED via sysctl) ─────────────────────────
  private func isDebugged() -> Bool {
    var info = kinfo_proc()
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
    var size = MemoryLayout<kinfo_proc>.stride
    let rc = sysctl(&mib, u_int(mib.count), &info, &size, nil, 0)
    if rc != 0 { return false }
    return (info.kp_proc.p_flag & P_TRACED) != 0
  }

  // ── Frida / hook dylibs in the loaded image list ───────────
  private let dylibNeedles = ["frida", "gadget", "cynject", "libcycript", "substrate", "substitute"]
  private func instrumentationDylib() -> String? {
    let count = _dyld_image_count()
    for i in 0..<count {
      if let namePtr = _dyld_get_image_name(i) {
        let name = String(cString: namePtr).lowercased()
        for n in dylibNeedles where name.contains(n) { return n }
      }
    }
    return nil
  }

  private func isSimulator() -> Bool {
    #if targetEnvironment(simulator)
    return true
    #else
    return ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"] != nil
    #endif
  }

  // ── One-shot full scan ─────────────────────────────────────
  @objc(scan:rejecter:)
  func scan(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    var out: [String: Any] = [:]

    let jb = jailbreakReason()
    out["jailbroken"] = (jb != nil)
    if let jb = jb { out["jailbreakDetail"] = jb }

    out["debugger"] = isDebugged()

    let dylib = instrumentationDylib()
    out["frida"] = (dylib != nil)
    if let d = dylib { out["fridaDetail"] = "dylib:\(d)" }
    // iOS has no separate Xposed-class framework; hookFramework mirrors frida here.
    out["hookFramework"] = (dylib != nil)

    out["emulator"] = isSimulator()

    // Not available on iOS (sandbox): dev-options, USB debugging, accessibility
    // enumeration, signing digest (App Attest covers integrity instead). Omitted
    // so the JS bridge leaves them `pending` rather than a false "clear".
    resolve(out)
  }
}
