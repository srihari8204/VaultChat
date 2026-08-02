import Foundation
import UIKit
import React

/**
 VaultView screen guard — iOS.

 What this platform actually allows, stated plainly because the JS layer's
 promises depend on it:

   Blocking      — NOT possible. Apple provides no equivalent of Android's
                   FLAG_SECURE. `setSecure` therefore resolves false rather
                   than pretending; JS reads `blockingSupported` and switches
                   to the detect-and-revoke posture instead of claiming a
                   protection the OS will not deliver.

   isCaptured    — real and the strongest signal on this platform.
                   `UIScreen.main.isCaptured` is true while the screen is being
                   recorded OR AirPlay-mirrored, and `capturedDidChangeNotification`
                   fires on every transition. This is what lets VaultView refuse
                   to decrypt while a recording is running.

   Screenshots   — detectable AFTER the fact only, via
                   `userDidTakeScreenshotNotification`. The bytes are already
                   captured by the time it fires; the response is to hide, alert
                   the sender, and revoke.

   External      — `UIScreen.screens.count > 1` covers HDMI adapters and
                   non-mirroring AirPlay displays.

 Emits `vaultview_state` with { captured, external, blockingSupported } on every
 transition, and `vaultview_screenshot` when a screenshot is taken.
 */
@objc(VaultViewGuard)
class VaultViewGuard: RCTEventEmitter {

  private var observers: [NSObjectProtocol] = []

  override static func requiresMainQueueSetup() -> Bool { true }

  override func supportedEvents() -> [String]! {
    return ["vaultview_state", "vaultview_screenshot"]
  }

  private func currentState() -> [String: Any] {
    return [
      "captured": UIScreen.main.isCaptured,
      "external": UIScreen.screens.count > 1,
      // iOS cannot block capture — see the class note. JS must not offer a
      // "screenshots blocked" promise on this platform.
      "blockingSupported": false,
    ]
  }

  private func emitState() {
    sendEvent(withName: "vaultview_state", body: currentState())
  }

  // ── JS surface ─────────────────────────────────────────────

  @objc(getState:rejecter:)
  func getState(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    resolve(currentState())
  }

  /// Always resolves false. Kept so the JS guard has one cross-platform call
  /// site; the return value is the honest answer, not a failure.
  @objc(setSecure:resolver:rejecter:)
  func setSecure(_ enabled: Bool, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    resolve(false)
  }

  @objc(startWatch)
  func startWatch() {
    guard observers.isEmpty else { return }
    let nc = NotificationCenter.default
    let main = OperationQueue.main

    observers.append(nc.addObserver(forName: UIScreen.capturedDidChangeNotification, object: nil, queue: main) { [weak self] _ in
      self?.emitState()
    })
    observers.append(nc.addObserver(forName: UIScreen.didConnectNotification, object: nil, queue: main) { [weak self] _ in
      self?.emitState()
    })
    observers.append(nc.addObserver(forName: UIScreen.didDisconnectNotification, object: nil, queue: main) { [weak self] _ in
      self?.emitState()
    })
    observers.append(nc.addObserver(forName: UIApplication.userDidTakeScreenshotNotification, object: nil, queue: main) { [weak self] _ in
      self?.sendEvent(withName: "vaultview_screenshot", body: [:])
    })
  }

  @objc(stopWatch)
  func stopWatch() {
    let nc = NotificationCenter.default
    for o in observers { nc.removeObserver(o) }
    observers.removeAll()
  }

  override func invalidate() {
    stopWatch()
    super.invalidate()
  }
}
