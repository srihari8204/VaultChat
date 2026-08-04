package com.vaultchat.app.vaultshield

import android.content.Context
import android.os.Build
import android.os.Debug
import android.provider.Settings
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket
import java.security.MessageDigest

/**
 * VaultShield — Android device-integrity detectors.
 *
 * The native half of the Device Security & Monitoring module. It reports raw
 * booleans/strings; the DECISION (scoring, banding, alerting) stays in the pure,
 * Node-tested JS core (services/security/deviceSecurity). This module never
 * wipes and never blocks — it only observes.
 *
 * Honesty, same as VaultViewModule: each check states what it can and cannot do.
 * A well-hidden root (Magisk DenyList / Shamiko) or a Frida server that hooks
 * these very functions can defeat the heuristic checks — that is why the JS
 * layer weights them with reduced confidence and why Play Integrity (separate)
 * is the real trust anchor. `scan()` returns everything in one call so a single
 * bridge round-trip covers a full device pass.
 */
class VaultShieldModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "VaultShield"

    // ── Root / su / Magisk ───────────────────────────────────
    private val suPaths = arrayOf(
        "/system/bin/su", "/system/xbin/su", "/sbin/su", "/system/su",
        "/system/bin/.ext/.su", "/system/usr/we-need-root/su", "/data/local/xbin/su",
        "/data/local/bin/su", "/data/local/su", "/su/bin/su",
    )
    private val rootApps = arrayOf(
        "com.topjohnwu.magisk", "com.noshufou.android.su", "com.koushikdutta.superuser",
        "eu.chainfire.supersu", "com.thirdparty.superuser", "com.yellowes.su",
    )
    private val magiskPaths = arrayOf(
        "/sbin/.magisk", "/cache/.disable_magisk", "/dev/.magisk.unblock",
        "/cache/magisk.log", "/data/adb/magisk", "/data/adb/modules",
    )

    private fun anyExists(paths: Array<String>): String? =
        paths.firstOrNull { try { File(it).exists() } catch (_: Throwable) { false } }

    private fun isRootAppInstalled(): String? {
        val pm = reactApplicationContext.packageManager
        return rootApps.firstOrNull {
            try { pm.getPackageInfo(it, 0); true } catch (_: Throwable) { false }
        }
    }

    private fun hasTestKeys(): Boolean =
        (Build.TAGS ?: "").contains("test-keys")

    // ── Debugger / tracer ────────────────────────────────────
    private fun tracerPid(): Int {
        return try {
            File("/proc/self/status").readLines()
                .firstOrNull { it.startsWith("TracerPid:") }
                ?.substringAfter(":")?.trim()?.toIntOrNull() ?: 0
        } catch (_: Throwable) { 0 }
    }

    // ── Frida / instrumentation ──────────────────────────────
    // Raw-socket probe of Frida's default port (replaces the old HTTP fetch,
    // which spoke the wrong protocol and was blocked by cleartext policy). A
    // connection that ACCEPTS is strong evidence; connection-refused is normal.
    private fun fridaPortOpen(): Boolean {
        for (port in intArrayOf(27042, 27043)) {
            try {
                Socket().use { s ->
                    s.connect(InetSocketAddress("127.0.0.1", port), 350)
                    if (s.isConnected) return true
                }
            } catch (_: Throwable) { /* refused = clean */ }
        }
        return false
    }

    // Scan our own memory map for injected-library signatures.
    private fun mapsMatch(needles: Array<String>): String? {
        return try {
            val text = File("/proc/self/maps").readText().lowercase()
            needles.firstOrNull { text.contains(it) }
        } catch (_: Throwable) { null }
    }

    private val fridaNeedles = arrayOf("frida", "gum-js-loop", "gadget", "linjector")
    private val hookNeedles = arrayOf("xposed", "lspd", "riru", "zygisk", "substrate", "edxposed")

    // ── Emulator ─────────────────────────────────────────────
    private fun isEmulator(): Boolean {
        val fp = (Build.FINGERPRINT ?: "").lowercase()
        val model = (Build.MODEL ?: "").lowercase()
        val hw = (Build.HARDWARE ?: "").lowercase()
        val product = (Build.PRODUCT ?: "").lowercase()
        return fp.startsWith("generic") || fp.contains("vbox") || fp.contains("emulator") ||
            model.contains("emulator") || model.contains("android sdk built for") ||
            hw.contains("goldfish") || hw.contains("ranchu") || hw.contains("vbox") ||
            product.contains("sdk_gphone") || product.contains("emulator") || product.contains("simulator")
    }

    // ── Settings ─────────────────────────────────────────────
    private fun globalInt(key: String): Int =
        try { Settings.Global.getInt(reactApplicationContext.contentResolver, key, 0) } catch (_: Throwable) { 0 }

    private fun enabledAccessibilityServices(): String =
        try {
            Settings.Secure.getString(
                reactApplicationContext.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
            ) ?: ""
        } catch (_: Throwable) { "" }

    // ── App signing certificate SHA-256 (re-sign detection) ──
    @Suppress("DEPRECATION", "PackageManagerGetSignatures")
    private fun signingSha256(): String? {
        return try {
            val pm = reactApplicationContext.packageManager
            val pkg = reactApplicationContext.packageName
            val signatures = if (Build.VERSION.SDK_INT >= 28) {
                val info = pm.getPackageInfo(pkg, android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES)
                info.signingInfo?.apkContentsSigners
            } else {
                pm.getPackageInfo(pkg, android.content.pm.PackageManager.GET_SIGNATURES).signatures
            } ?: return null
            val first = signatures.firstOrNull() ?: return null
            val md = MessageDigest.getInstance("SHA-256")
            md.digest(first.toByteArray()).joinToString("") { "%02x".format(it) }
        } catch (_: Throwable) { null }
    }

    // ── One-shot full scan ───────────────────────────────────
    @ReactMethod
    fun scan(promise: Promise) {
        try {
            val map: WritableMap = Arguments.createMap()

            val su = anyExists(suPaths)
            val rootApp = isRootAppInstalled()
            val magisk = anyExists(magiskPaths)
            map.putBoolean("rooted", su != null || rootApp != null || magisk != null || hasTestKeys())
            map.putBoolean("suBinary", su != null)
            if (su != null) map.putString("suDetail", su)
            map.putBoolean("magisk", magisk != null)
            if (rootApp != null) map.putString("rootApp", rootApp)
            map.putBoolean("testKeys", hasTestKeys())

            val debugger = Debug.isDebuggerConnected() || Debug.waitingForDebugger() || tracerPid() != 0
            map.putBoolean("debugger", debugger)
            map.putInt("tracerPid", tracerPid())

            val fridaMap = mapsMatch(fridaNeedles)
            val fridaPort = fridaPortOpen()
            map.putBoolean("frida", fridaMap != null || fridaPort)
            if (fridaMap != null) map.putString("fridaDetail", "maps:$fridaMap")
            else if (fridaPort) map.putString("fridaDetail", "port 27042 open")

            val hook = mapsMatch(hookNeedles)
            map.putBoolean("hookFramework", hook != null)
            if (hook != null) map.putString("hookDetail", hook)

            map.putBoolean("emulator", isEmulator())
            map.putBoolean("devOptions", globalInt(Settings.Global.DEVELOPMENT_SETTINGS_ENABLED) == 1)
            map.putBoolean("adb", globalInt(Settings.Global.ADB_ENABLED) == 1)

            val digest = signingSha256()
            if (digest != null) map.putString("signingSha256", digest)

            val a11y = enabledAccessibilityServices()
            val services: WritableArray = Arguments.createArray()
            if (a11y.isNotEmpty()) a11y.split(":").forEach { if (it.isNotBlank()) services.pushString(it) }
            map.putArray("accessibilityServices", services)

            promise.resolve(map)
        } catch (e: Throwable) {
            promise.reject("vaultshield_scan_failed", e)
        }
    }
}
