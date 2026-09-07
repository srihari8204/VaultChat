// VaultChat crypto-core — Nitro HybridObject over the Rust C ABI.
//
// One synchronous JSI method: call(op, argsJson) -> responseJson. All
// marshaling is JSON (services/crypto/rust/DESIGN.md §4); the typed surface
// lives in services/crypto/native/CryptoCore.ts. Registered under the name
// "CryptoCore" from JNI_OnLoad when MainApplication loads libvaultcrypto.so —
// if that load fails, JS simply finds no "CryptoCore" and stays on the TS
// backend (never a crash).

#include <NitroModules/HybridObject.hpp>
#include <NitroModules/HybridObjectRegistry.hpp>
#include <jni.h>
#include <memory>
#include <string>

extern "C" {
char* vc_crypto_call(const char* op, const char* argsJson);
void vc_crypto_free(char* ptr);
// nav-core (services/nav/rust) is linked into this same .so — see CMakeLists.
char* vc_nav_call(const char* op, const char* argsJson);
void vc_nav_free(char* ptr);
}

namespace vaultchat {

using namespace margelo::nitro;

class HybridCryptoCore : public HybridObject {
public:
  HybridCryptoCore() : HybridObject(TAG) {}

  std::string call(const std::string& op, const std::string& argsJson) {
    char* raw = vc_crypto_call(op.c_str(), argsJson.c_str());
    if (raw == nullptr) {
      return R"({"ok":false,"error":"crypto-core: native call returned null"})";
    }
    std::string out(raw);
    vc_crypto_free(raw);
    return out;
  }

  void loadHybridMethods() override {
    HybridObject::loadHybridMethods();
    registerHybrids(this, [](Prototype& prototype) {
      prototype.registerHybridMethod("call", &HybridCryptoCore::call);
    });
  }

  static constexpr auto TAG = "CryptoCore";
};

// ── NavCore ──────────────────────────────────────────────────────────────
//
// The per-GPS-fix route mathematics (services/nav/rust). Same one-method shape
// as CryptoCore so there is exactly one native calling convention in this app.
//
// The route geometry is uploaded ONCE via setRoute and cached on the Rust side,
// so a fix crosses this boundary as a handful of scalars rather than
// re-marshalling thousands of coordinates every second.
//
// If this object is absent for any reason, lib/nav/native/NavCore.ts falls back
// to lib/nav/routeProgress.ts, which is the reference implementation and is
// proven equal by services/nav/rust/tests/parity.rs. Navigation is never
// degraded by the native layer being missing.
class HybridNavCore : public HybridObject {
public:
  HybridNavCore() : HybridObject(TAG) {}

  std::string call(const std::string& op, const std::string& argsJson) {
    char* raw = vc_nav_call(op.c_str(), argsJson.c_str());
    if (raw == nullptr) {
      return R"({"ok":false,"error":"nav-core: native call returned null"})";
    }
    std::string out(raw);
    vc_nav_free(raw);
    return out;
  }

  void loadHybridMethods() override {
    HybridObject::loadHybridMethods();
    registerHybrids(this, [](Prototype& prototype) {
      prototype.registerHybridMethod("call", &HybridNavCore::call);
    });
  }

  static constexpr auto TAG = "NavCore";
};

} // namespace vaultchat

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* /*vm*/, void* /*reserved*/) {
  margelo::nitro::HybridObjectRegistry::registerHybridObjectConstructor(
      "CryptoCore", []() -> std::shared_ptr<margelo::nitro::HybridObject> {
        return std::make_shared<vaultchat::HybridCryptoCore>();
      });
  margelo::nitro::HybridObjectRegistry::registerHybridObjectConstructor(
      "NavCore", []() -> std::shared_ptr<margelo::nitro::HybridObject> {
        return std::make_shared<vaultchat::HybridNavCore>();
      });
  return JNI_VERSION_1_6;
}
