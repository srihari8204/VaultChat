// VaultBeamCore.h — C ABI of the vaultbeam-core Rust staticlib
// (services/vaultbeam/rust/src/ffi.rs). Used two ways:
//   1. as the -headers dir when packaging VaultBeamCore.xcframework, and
//   2. #included from the Swift bridging header so VaultBeamStreamRust.swift can
//      call these symbols directly.
#ifndef VAULTBEAM_CORE_H
#define VAULTBEAM_CORE_H

#ifdef __cplusplus
extern "C" {
#endif

// Request/response ops. Returns a heap JSON string {"ok":…,"result":…}; release
// with vb_free. `op` + `args_json` are NUL-terminated UTF-8.
char *vb_call(const char *op, const char *args_json);

// Event callback: (ctx, event_name, payload_json). Fires vbLanBound / vbLanProgress.
typedef void (*EventCb)(void *ctx, const char *event_name, const char *payload_json);

// Long-running LAN ops (block until the transfer completes). Return the same
// {"ok":…,"result":…} JSON string; release with vb_free.
char *vb_lan_serve(const char *args_json, EventCb cb, void *ctx);
char *vb_lan_connect(const char *args_json, EventCb cb, void *ctx);

// Release any string returned above.
void vb_free(char *ptr);

#ifdef __cplusplus
}
#endif

#endif // VAULTBEAM_CORE_H
