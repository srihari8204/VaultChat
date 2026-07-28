// VaultBeamJni — thin JNI bridge from the classic Kotlin module
// (VaultBeamStreamRustModule) to the vaultbeam-core Rust C ABI
// (services/vaultbeam/rust/src/ffi.rs).
//
// Three externals the Kotlin module binds via `external fun`:
//   nativeCall(op, argsJson): String            -> vb_call
//   nativeLanServe(argsJson, listener): String   -> vb_lan_serve   (blocking)
//   nativeLanConnect(argsJson, listener): String -> vb_lan_connect (blocking)
//
// nativeLanServe/Connect return the SAME {"ok":…,"result":…} JSON string that
// vb_call returns (Kotlin parses it). The task sketched `: int`, but returning
// the envelope keeps error propagation uniform with nativeCall and lets Rust own
// the result — the C ABI hands back a JSON string, not an int, so parsing it in
// C++ would only duplicate what Kotlin already does. [flagged in README]
//
// The Rust LAN ops fire their event callback SYNCHRONOUSLY on the calling thread
// (the Kotlin io Executor thread — already a JVM thread). The trampoline still
// uses GetEnv/AttachCurrentThread defensively so it stays correct even if a
// future Rust revision moves the callback onto its own worker thread.

#include <jni.h>
#include <string>

extern "C" {
char* vb_call(const char* op, const char* args_json);
typedef void (*EventCb)(void* ctx, const char* event_name, const char* payload_json);
char* vb_lan_serve(const char* args_json, EventCb cb, void* ctx);
char* vb_lan_connect(const char* args_json, EventCb cb, void* ctx);
void vb_free(char* ptr);
}

static JavaVM* g_vm = nullptr;

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* /*reserved*/) {
  g_vm = vm;
  return JNI_VERSION_1_6;
}

// Copy a heap C string from Rust into a std::string and release it with vb_free.
static std::string take(char* raw) {
  if (raw == nullptr) {
    return R"({"ok":false,"error":"vaultbeam: native call returned null"})";
  }
  std::string out(raw);
  vb_free(raw);
  return out;
}

// Context handed to the Rust event callback: a GlobalRef to the Kotlin listener
// (a `fun interface LanEventListener { fun onEvent(name, payloadJson) }` lambda)
// plus its resolved onEvent method id.
struct LanCtx {
  jobject listener;   // JNI GlobalRef — valid for the whole (blocking) call
  jmethodID onEvent;  // void onEvent(String, String)
};

// EventCb trampoline. Attaches the current thread to the JVM if needed, calls
// the Kotlin listener, then detaches only if we were the ones who attached.
static void lanEventTrampoline(void* ctx, const char* name, const char* payload) {
  if (g_vm == nullptr || ctx == nullptr) return;
  LanCtx* c = reinterpret_cast<LanCtx*>(ctx);

  JNIEnv* env = nullptr;
  bool attached = false;
  jint r = g_vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6);
  if (r == JNI_EDETACHED) {
    if (g_vm->AttachCurrentThread(&env, nullptr) != JNI_OK) return;
    attached = true;
  } else if (r != JNI_OK || env == nullptr) {
    return;
  }

  jstring jn = env->NewStringUTF(name ? name : "");
  jstring jp = env->NewStringUTF(payload ? payload : "{}");
  env->CallVoidMethod(c->listener, c->onEvent, jn, jp);
  if (env->ExceptionCheck()) env->ExceptionClear();  // never let JS-emit throw abort the transfer
  env->DeleteLocalRef(jn);
  env->DeleteLocalRef(jp);

  if (attached) g_vm->DetachCurrentThread();
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_vaultchat_vaultbeamcore_VaultBeamStreamRustModule_nativeCall(
    JNIEnv* env, jobject /*thiz*/, jstring jop, jstring jargs) {
  const char* op = env->GetStringUTFChars(jop, nullptr);
  const char* args = env->GetStringUTFChars(jargs, nullptr);
  std::string out = take(vb_call(op, args));
  env->ReleaseStringUTFChars(jop, op);
  env->ReleaseStringUTFChars(jargs, args);
  return env->NewStringUTF(out.c_str());
}

// Shared body for the two blocking LAN ops (only the Rust entrypoint differs).
static jstring lanCall(JNIEnv* env, jstring jargs, jobject listener,
                       char* (*fn)(const char*, EventCb, void*)) {
  const char* args = env->GetStringUTFChars(jargs, nullptr);

  jobject gListener = env->NewGlobalRef(listener);
  jclass cls = env->GetObjectClass(listener);
  jmethodID onEvent = env->GetMethodID(cls, "onEvent",
                                       "(Ljava/lang/String;Ljava/lang/String;)V");
  env->DeleteLocalRef(cls);

  LanCtx ctx{gListener, onEvent};  // stack-lives for the whole blocking call
  std::string out = take(fn(args, lanEventTrampoline, &ctx));

  env->DeleteGlobalRef(gListener);
  env->ReleaseStringUTFChars(jargs, args);
  return env->NewStringUTF(out.c_str());
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_vaultchat_vaultbeamcore_VaultBeamStreamRustModule_nativeLanServe(
    JNIEnv* env, jobject /*thiz*/, jstring jargs, jobject listener) {
  return lanCall(env, jargs, listener, vb_lan_serve);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_vaultchat_vaultbeamcore_VaultBeamStreamRustModule_nativeLanConnect(
    JNIEnv* env, jobject /*thiz*/, jstring jargs, jobject listener) {
  return lanCall(env, jargs, listener, vb_lan_connect);
}
