// VaultBeamStreamRust.swift — iOS twin of the classic VaultBeamStream module,
// backed by the shared vaultbeam-core Rust staticlib (VaultBeamCore.xcframework).
// First iOS VaultBeam. Same method surface + same wire format as the Android
// (Kotlin + Rust) modules, so an iOS peer interops with any tier.
//
// Design A′: seal/open + layout + file IO + LAN sockets live in shared Rust
// (called via the C ABI in the bridging header); only the thin marshaling shim
// and the block HTTP (URLSession, mirroring the Android HttpURLConnection
// semantics) are per-platform here.
//
// The C functions (vb_call / vb_lan_serve / vb_lan_connect / vb_free) come from
// VaultBeamCore.h via VaultBeamStreamRust-Bridging-Header.h.

import Foundation
import React

@objc(VaultBeamStreamRust)
class VaultBeamStreamRust: RCTEventEmitter {

  // Off the JS thread; the blocking LAN ops and file/HTTP work run here.
  private let workQueue = DispatchQueue(label: "com.vaultchat.vaultbeamcore", qos: .userInitiated, attributes: .concurrent)

  override static func requiresMainQueueSetup() -> Bool { false }
  override func supportedEvents() -> [String]! { ["vbLanBound", "vbLanProgress"] }

  // ── JSON marshaling ────────────────────────────────────────────────

  // NSDictionary → JSON string. Whole-number NSNumbers are emitted as integers
  // so the Rust serde_json `as_u64` accepts them (a "512.0" would fail), matching
  // the Android toJson() normalization.
  private func jsonArgs(_ opts: [String: Any], extra: [String: Any] = [:]) -> String {
    var m = opts
    for (k, v) in extra { m[k] = v }
    var out: [String: Any] = [:]
    for (k, v) in m {
      if let n = v as? NSNumber {
        let d = n.doubleValue
        if !d.isInfinite && !d.isNaN && d == d.rounded(.towardZero) {
          out[k] = n.int64Value
        } else {
          out[k] = d
        }
      } else {
        out[k] = v
      }
    }
    let data = (try? JSONSerialization.data(withJSONObject: out, options: [])) ?? Data("{}".utf8)
    return String(data: data, encoding: .utf8) ?? "{}"
  }

  // Unwrap {"ok":…,"result":…}; throws VBError on {ok:false} or malformed.
  private struct VBError: Error { let message: String }
  private func result(_ resp: String) throws -> Any {
    guard let data = resp.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw VBError(message: "vaultbeam: malformed native response")
    }
    if (obj["ok"] as? Bool) == true { return obj["result"] ?? NSNull() }
    throw VBError(message: (obj["error"] as? String) ?? "vaultbeam native error")
  }

  // vb_call(op, args) → parsed result; frees the returned pointer.
  private func call(_ op: String, _ argsJson: String) throws -> Any {
    guard let raw = vb_call(op, argsJson) else { throw VBError(message: "vaultbeam: native call returned null") }
    defer { vb_free(raw) }
    return try result(String(cString: raw))
  }

  private func resolveDouble(_ v: Any) -> NSNumber {
    if let n = v as? NSNumber { return n }
    return NSNumber(value: 0)
  }

  // ── file IO ops ─────────────────────────────────────────────────────

  @objc(prealloc:totalBytes:resolver:rejecter:)
  func prealloc(_ path: String, totalBytes: NSNumber, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    workQueue.async {
      do {
        let args = self.jsonArgs(["path": path, "totalBytes": totalBytes.int64Value])
        resolve((try self.call("prealloc", args)) as? Bool ?? false)
      } catch { reject("prealloc", "\(error)", error) }
    }
  }

  @objc(sha256:resolver:rejecter:)
  func sha256(_ path: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    workQueue.async {
      do { resolve(try self.call("sha256", self.jsonArgs(["path": path]))) }
      catch { reject("sha256", "\(error)", error) }
    }
  }

  // Durability barrier — see fileio::sync_file. Closing a file is not fsync.
  @objc(syncFile:resolver:rejecter:)
  func syncFile(_ path: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    workQueue.async {
      do { resolve((try self.call("syncFile", self.jsonArgs(["path": path]))) as? Bool ?? false) }
      catch { reject("syncFile", "\(error)", error) }
    }
  }

  @objc(deleteFile:resolver:rejecter:)
  func deleteFile(_ path: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    workQueue.async {
      do { resolve((try self.call("deleteFile", self.jsonArgs(["path": path]))) as? Bool ?? false) }
      catch { reject("delete", "\(error)", error) }
    }
  }

  // ── R2 block ops: Rust seals/opens, URLSession does the HTTP ─────────
  // HTTP semantics mirror plugins/android/VaultBeamStreamModule.kt:
  // PUT Content-Type application/octet-stream; connect 30s / read 120s; 2xx = ok.

  @objc(uploadBlock:resolver:rejecter:)
  func uploadBlock(_ opts: [String: Any], resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    workQueue.async {
      do {
        guard let urlStr = opts["url"] as? String, let url = URL(string: urlStr) else {
          reject("upload", "missing url", nil); return
        }
        let ctB64 = (try self.call("sealBlockFromFile", self.jsonArgs(opts))) as? String ?? ""
        guard let body = Data(base64Encoded: ctB64) else { reject("upload", "bad ciphertext", nil); return }

        var req = URLRequest(url: url, timeoutInterval: 120)
        req.httpMethod = "PUT"
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 30; cfg.timeoutIntervalForResource = 120
        let session = URLSession(configuration: cfg)
        let task = session.uploadTask(with: req, from: body) { _, resp, err in
          if let err = err { reject("upload", "\(err)", err); return }
          let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
          if (200...299).contains(code) { resolve(NSNumber(value: body.count)) }
          else { reject("upload_http_\(code)", "PUT block failed: \(code)", nil) }
        }
        task.resume()
      } catch { reject("upload", "\(error)", error) }
    }
  }

  @objc(downloadBlock:resolver:rejecter:)
  func downloadBlock(_ opts: [String: Any], resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    workQueue.async {
      guard let urlStr = opts["url"] as? String, let url = URL(string: urlStr) else {
        reject("download", "missing url", nil); return
      }
      var req = URLRequest(url: url, timeoutInterval: 120)
      req.httpMethod = "GET"
      let cfg = URLSessionConfiguration.default
      cfg.timeoutIntervalForRequest = 30; cfg.timeoutIntervalForResource = 120
      let session = URLSession(configuration: cfg)
      let task = session.dataTask(with: req) { data, resp, err in
        if let err = err { reject("download", "\(err)", err); return }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if !(200...299).contains(code) { reject("download_http_\(code)", "GET block failed: \(code)", nil); return }
        guard let body = data else { reject("download", "empty body", nil); return }
        do {
          let args = self.jsonArgs(opts, extra: ["bodyB64": body.base64EncodedString()])
          resolve(self.resolveDouble(try self.call("writeBlockFromBody", args)))
        } catch { reject("download", "\(error)", error) }
      }
      task.resume()
    }
  }

  // ── P2 (WebRTC) per-chunk cipher primitives ─────────────────────────

  @objc(readCipherChunk:resolver:rejecter:)
  func readCipherChunk(_ opts: [String: Any], resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    workQueue.async {
      do { resolve(try self.call("readCipherChunk", self.jsonArgs(opts))) }
      catch { reject("readCipherChunk", "\(error)", error) }
    }
  }

  @objc(writeCipherChunk:resolver:rejecter:)
  func writeCipherChunk(_ opts: [String: Any], resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    workQueue.async {
      do { resolve(self.resolveDouble(try self.call("writeCipherChunk", self.jsonArgs(opts)))) }
      catch { reject("writeCipherChunk", "\(error)", error) }
    }
  }

  // ── P3 (LAN) direct TCP transport (Rust owns socket + file) ─────────

  @objc(lanIp:rejecter:)
  func lanIp(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    workQueue.async {
      do {
        let r = try self.call("lanIp", "{}")
        resolve(r is NSNull ? nil : r)
      } catch { reject("lanIp", "\(error)", error) }
    }
  }

  // Global C trampoline: unpack the emitter from ctx and forward the event.
  private static let eventCb: EventCb = { ctx, namePtr, payloadPtr in
    guard let ctx = ctx, let namePtr = namePtr, let payloadPtr = payloadPtr else { return }
    let me = Unmanaged<VaultBeamStreamRust>.fromOpaque(ctx).takeUnretainedValue()
    let name = String(cString: namePtr)
    let payload = String(cString: payloadPtr)
    let body = (try? JSONSerialization.jsonObject(with: Data(payload.utf8))) as? [String: Any] ?? [:]
    me.sendEvent(withName: name, body: body)
  }

  @objc(lanServe:resolver:rejecter:)
  func lanServe(_ opts: [String: Any], resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    workQueue.async { self.lan(vb_lan_serve, "lanServe", opts, resolve, reject) }
  }

  @objc(lanConnect:resolver:rejecter:)
  func lanConnect(_ opts: [String: Any], resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    workQueue.async { self.lan(vb_lan_connect, "lanConnect", opts, resolve, reject) }
  }

  private func lan(_ fn: (UnsafePointer<CChar>?, EventCb?, UnsafeMutableRawPointer?) -> UnsafeMutablePointer<CChar>?,
                   _ tag: String, _ opts: [String: Any],
                   _ resolve: @escaping RCTPromiseResolveBlock, _ reject: @escaping RCTPromiseRejectBlock) {
    let ctx = Unmanaged.passRetained(self).toOpaque()   // held for the whole blocking call
    defer { Unmanaged<VaultBeamStreamRust>.fromOpaque(ctx).release() }
    let args = jsonArgs(opts)
    guard let raw = args.withCString({ fn($0, VaultBeamStreamRust.eventCb, ctx) }) else {
      reject(tag, "vaultbeam: native call returned null", nil); return
    }
    defer { vb_free(raw) }
    do { resolve(resolveDouble(try result(String(cString: raw)))) }
    catch { reject(tag, "\(error)", error) }
  }
}
