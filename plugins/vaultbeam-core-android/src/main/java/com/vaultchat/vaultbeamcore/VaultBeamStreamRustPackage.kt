package com.vaultchat.vaultbeamcore

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Registers VaultBeamStreamRustModule — but ONLY when libvaultbeamnative.so
 * actually loaded. If it didn't, we register nothing, so JS never finds
 * NativeModules.VaultBeamStreamRust and cleanly falls back to the Kotlin
 * VaultBeamStream module (same fallback contract as crypto-core).
 */
class VaultBeamStreamRustPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        if (VaultBeamStreamRustModule.loaded) listOf(VaultBeamStreamRustModule(reactContext))
        else emptyList()

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
