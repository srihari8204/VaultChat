import Foundation
import UIKit
import AVFoundation
import React

/**
 VaultView / VaultCheck pixel work — iOS.

 Byte-for-byte the same scheme as plugins/android/VaultMediaModule.kt: an ID
 embedded on Android must extract on iOS and vice versa, so the constants
 (16px blocks, delta 3, 48-bit id + CRC-16/CCITT-FALSE, raster-order pairs,
 majority vote) are duplicated deliberately rather than diverged. If you change
 one, change both — a mismatch silently produces `found: false` on cross-platform
 leaks, which reads as "no watermark" when the truth is "wrong decoder".

 See the Kotlin file for what the watermark survives (JPEG re-encode, brightness,
 cropping) and what it does not (rescale, rotation, heavy blur).
 */
@objc(VaultViewMedia)
class VaultViewMedia: NSObject {

  private let block = 16
  private let delta = 3
  private let payloadBits = 64

  @objc static func requiresMainQueueSetup() -> Bool { false }

  // ── payload helpers ──────────────────────────────────────

  private func crc16(_ data: [UInt8]) -> Int {
    var crc = 0xFFFF
    for b in data {
      crc ^= Int(b) << 8
      for _ in 0..<8 {
        crc = (crc & 0x8000) != 0 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF
      }
    }
    return crc & 0xFFFF
  }

  private func bits(fromHex idHex: String) -> [Bool]? {
    let clean = idHex.trimmingCharacters(in: .whitespaces).lowercased()
    guard clean.count == 12, clean.allSatisfy({ $0.isHexDigit }) else { return nil }
    var id = [UInt8]()
    var idx = clean.startIndex
    for _ in 0..<6 {
      let next = clean.index(idx, offsetBy: 2)
      guard let byte = UInt8(clean[idx..<next], radix: 16) else { return nil }
      id.append(byte)
      idx = next
    }
    let crc = crc16(id)
    var out = [Bool](repeating: false, count: payloadBits)
    for i in 0..<48 {
      out[i] = (Int(id[i / 8]) >> (7 - (i % 8))) & 1 == 1
    }
    for i in 0..<16 { out[48 + i] = (crc >> (15 - i)) & 1 == 1 }
    return out
  }

  private func hex(fromBits b: [Bool]) -> String? {
    var id = [UInt8](repeating: 0, count: 6)
    for i in 0..<48 where b[i] { id[i / 8] |= UInt8(1 << (7 - (i % 8))) }
    var crc = 0
    for i in 0..<16 where b[48 + i] { crc |= 1 << (15 - i) }
    guard crc == crc16(id) else { return nil }
    return id.map { String(format: "%02x", $0) }.joined()
  }

  /// Decode any image file to a tightly-packed RGBA8 buffer.
  private func rgba(from path: String) -> (buf: [UInt8], w: Int, h: Int)? {
    let clean = path.hasPrefix("file://") ? String(path.dropFirst(7)) : path
    guard let img = UIImage(contentsOfFile: clean), let cg = img.cgImage else { return nil }
    let w = cg.width, h = cg.height
    var buf = [UInt8](repeating: 0, count: w * h * 4)
    guard let ctx = CGContext(
      data: &buf, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    return (buf, w, h)
  }

  private func luma(_ buf: [UInt8], _ i: Int) -> Int {
    (Int(buf[i]) * 299 + Int(buf[i + 1]) * 587 + Int(buf[i + 2]) * 114) / 1000
  }

  private func blockMean(_ buf: [UInt8], _ w: Int, _ blockIndex: Int, _ bx: Int) -> Int {
    let col = blockIndex % bx, row = blockIndex / bx
    var sum = 0
    for y in 0..<block {
      let base = ((row * block + y) * w + col * block) * 4
      for x in 0..<block { sum += luma(buf, base + x * 4) }
    }
    return sum / (block * block)
  }

  private func shiftBlock(_ buf: inout [UInt8], _ w: Int, _ h: Int, _ blockIndex: Int, _ bx: Int, _ shift: Int) {
    guard shift != 0 else { return }
    let col = blockIndex % bx, row = blockIndex / bx
    for y in 0..<block {
      let yy = row * block + y
      if yy >= h { return }
      let base = (yy * w + col * block) * 4
      for x in 0..<block {
        let i = base + x * 4
        for c in 0..<3 {
          buf[i + c] = UInt8(max(0, min(255, Int(buf[i + c]) + shift)))
        }
      }
    }
  }

  // ── embed ────────────────────────────────────────────────

  @objc(embedTrackingId:dstPath:idHex:quality:resolver:rejecter:)
  func embedTrackingId(
    _ srcPath: String, dstPath: String, idHex: String, quality: NSNumber,
    resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock
  ) {
    guard let payload = bits(fromHex: idHex) else {
      reject("bad_id", "idHex must be 12 hex chars (48-bit id)", nil); return
    }
    guard var (buf, w, h) = rgba(from: srcPath).map({ ($0.buf, $0.w, $0.h) }) else {
      reject("decode_failed", "could not decode \(srcPath)", nil); return
    }
    let bx = w / block, by = h / block
    guard bx * by >= 128 else {
      reject("too_small", "image must be at least 128 blocks (\(block)px) to carry the id", nil); return
    }

    let pairs = (bx * by) / 2
    for k in 0..<pairs {
      let bit = payload[k % payloadBits]
      let ia = 2 * k, ib = 2 * k + 1
      let diff = blockMean(buf, w, ia, bx) - blockMean(buf, w, ib, bx)
      let want = bit ? delta : -delta
      if (bit && diff >= want) || (!bit && diff <= want) { continue }
      let shift = (want - diff) / 2
      shiftBlock(&buf, w, h, ia, bx, shift)
      shiftBlock(&buf, w, h, ib, bx, -shift)
    }

    guard let ctx = CGContext(
      data: &buf, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ), let out = ctx.makeImage() else {
      reject("encode_failed", "could not rebuild image", nil); return
    }
    let q = CGFloat(truncating: quality) / 100.0
    guard let data = UIImage(cgImage: out).jpegData(compressionQuality: q > 0 && q <= 1 ? q : 0.92) else {
      reject("encode_failed", "jpeg encode failed", nil); return
    }
    let dst = dstPath.hasPrefix("file://") ? String(dstPath.dropFirst(7)) : dstPath
    do {
      try FileManager.default.createDirectory(
        atPath: (dst as NSString).deletingLastPathComponent,
        withIntermediateDirectories: true)
      try data.write(to: URL(fileURLWithPath: dst))
      resolve(true)
    } catch {
      reject("write_failed", error.localizedDescription, error)
    }
  }

  // ── extract ──────────────────────────────────────────────

  @objc(extractTrackingId:resolver:rejecter:)
  func extractTrackingId(
    _ srcPath: String,
    resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock
  ) {
    guard let (buf, w, h) = rgba(from: srcPath).map({ ($0.buf, $0.w, $0.h) }) else {
      reject("decode_failed", "could not decode \(srcPath)", nil); return
    }
    let bx = w / block, by = h / block
    guard bx * by >= 128 else {
      resolve(["found": false, "reason": "too_small"]); return
    }
    var votes = [Int](repeating: 0, count: payloadBits)
    let pairs = (bx * by) / 2
    for k in 0..<pairs {
      let diff = blockMean(buf, w, 2 * k, bx) - blockMean(buf, w, 2 * k + 1, bx)
      votes[k % payloadBits] += diff > 0 ? 1 : (diff < 0 ? -1 : 0)
    }
    let decoded = (0..<payloadBits).map { votes[$0] > 0 }
    guard let id = hex(fromBits: decoded) else {
      // CRC failed → say so. Never return a best-guess id: the output of this
      // function names a person.
      resolve(["found": false, "reason": "crc_mismatch"]); return
    }
    let reps = Double(pairs) / Double(payloadBits)
    let margin = (votes.map { Double(abs($0)) }.reduce(0, +) / Double(payloadBits)) / max(1.0, reps)
    resolve(["found": true, "id": id, "confidence": min(max(margin, 0.0), 1.0)])
  }

  // ── rPPG frame sampling ──────────────────────────────────

  /// See the Kotlin twin for the contract. Returns [{ tMs, r, g, b }]; frames
  /// the decoder cannot produce are skipped, never interpolated.
  @objc(sampleVideoChannels:startMs:endMs:frames:roiX:roiY:roiW:roiH:resolver:rejecter:)
  func sampleVideoChannels(
    _ path: String, startMs: NSNumber, endMs: NSNumber, frames: NSNumber,
    roiX: NSNumber, roiY: NSNumber, roiW: NSNumber, roiH: NSNumber,
    resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock
  ) {
    let clean = path.hasPrefix("file://") ? String(path.dropFirst(7)) : path
    let asset = AVURLAsset(url: URL(fileURLWithPath: clean))
    let gen = AVAssetImageGenerator(asset: asset)
    gen.appliesPreferredTrackTransform = true
    // Exact sampling — rPPG is a frequency measurement, so the generator must
    // not silently snap to arbitrary keyframes.
    gen.requestedTimeToleranceBefore = .zero
    gen.requestedTimeToleranceAfter = .zero

    let n = max(2, min(300, frames.intValue))
    let s = startMs.doubleValue, e = endMs.doubleValue
    let step = (e - s) / Double(n - 1)
    var out: [[String: Any]] = []

    for i in 0..<n {
      let tMs = s + step * Double(i)
      let time = CMTime(seconds: tMs / 1000.0, preferredTimescale: 600)
      guard let cg = try? gen.copyCGImage(at: time, actualTime: nil) else { continue }
      let w = cg.width, h = cg.height
      var buf = [UInt8](repeating: 0, count: w * h * 4)
      guard let ctx = CGContext(
        data: &buf, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      ) else { continue }
      ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))

      let x0 = min(max(Int(roiX.doubleValue * Double(w)), 0), w - 1)
      let y0 = min(max(Int(roiY.doubleValue * Double(h)), 0), h - 1)
      let rw = min(max(Int(roiW.doubleValue * Double(w)), 1), w - x0)
      let rh = min(max(Int(roiH.doubleValue * Double(h)), 1), h - y0)

      var sr = 0.0, sg = 0.0, sb = 0.0
      for y in y0..<(y0 + rh) {
        let base = y * w * 4
        for x in x0..<(x0 + rw) {
          let i = base + x * 4
          sr += Double(buf[i]); sg += Double(buf[i + 1]); sb += Double(buf[i + 2])
        }
      }
      let count = Double(rw * rh)
      out.append(["tMs": tMs, "r": sr / count, "g": sg / count, "b": sb / count])
    }
    resolve(out)
  }
}
