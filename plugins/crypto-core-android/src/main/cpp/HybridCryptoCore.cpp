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

} // namespace vaultchat

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* /*vm*/, void* /*reserved*/) {
  margelo::nitro::HybridObjectRegistry::registerHybridObjectConstructor(
      "CryptoCore", []() -> std::shared_ptr<margelo::nitro::HybridObject> {
        return std::make_shared<vaultchat::HybridCryptoCore>();
      });
  return JNI_VERSION_1_6;
}
