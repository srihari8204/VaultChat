// VaultView.m — RCT bridge for the VaultView Swift modules. Exports the classic
// bridge surface with the same method names as plugins/android/*.kt so
// lib/screenGuard.ts and lib/trackingId.ts drive both platforms identically.
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(VaultViewGuard, RCTEventEmitter)

RCT_EXTERN_METHOD(getState:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setSecure:(BOOL)enabled
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(startWatch)
RCT_EXTERN_METHOD(stopWatch)

@end

@interface RCT_EXTERN_MODULE(VaultViewMedia, NSObject)

RCT_EXTERN_METHOD(embedTrackingId:(NSString *)srcPath
                  dstPath:(NSString *)dstPath
                  idHex:(NSString *)idHex
                  quality:(nonnull NSNumber *)quality
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(extractTrackingId:(NSString *)srcPath
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(cancelSampling)

RCT_EXTERN_METHOD(sampleVideoChannels:(NSString *)path
                  startMs:(nonnull NSNumber *)startMs
                  endMs:(nonnull NSNumber *)endMs
                  frames:(nonnull NSNumber *)frames
                  roiX:(nonnull NSNumber *)roiX
                  roiY:(nonnull NSNumber *)roiY
                  roiW:(nonnull NSNumber *)roiW
                  roiH:(nonnull NSNumber *)roiH
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
