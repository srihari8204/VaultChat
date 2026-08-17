package com.vaultchat.app.golive

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Registers the Go Live native module. Its own package rather than an entry
 * added to CallPackage: registering a broadcasting module through calling's
 * package would make the two products share a build-time dependency for no
 * benefit, and CallPackage is working code this change does not touch.
 */
class GoLivePackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(GoLiveModule(reactContext))

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
