// VaultShield.m — RCT bridge for the VaultShield Swift detector. Exports the same
// `scan` method name as plugins/android/VaultShieldModule.kt so the JS bridge
// (services/security/deviceSecurity/nativeSecurity.ts) drives both platforms
// identically.
#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(VaultShield, NSObject)

RCT_EXTERN_METHOD(scan:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

+ (BOOL)requiresMainQueueSetup { return NO; }

@end
