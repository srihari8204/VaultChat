#include <jni.h>
#include <cstdint>
#include <cstddef>

extern "C" {
uint64_t vc_transport_create();
bool vc_transport_supports_webtransport();
void vc_transport_close(uint64_t id);
bool vc_transport_send(uint64_t id, const uint8_t* bytes, size_t len);
void vc_transport_run(uint64_t id, const char* url, const char* token,
    void (*callback)(void*, uint32_t, const uint8_t*, size_t, uint16_t), void* context);
}

struct Listener { JNIEnv* env; jobject listener; jmethodID method; uint64_t id; };
// Rust invokes this synchronously on the calling Kotlin executor thread.
static void onEvent(void* context, uint32_t kind, const uint8_t* bytes, size_t len, uint16_t code) {
    auto* ctx = static_cast<Listener*>(context);
    jbyteArray data = nullptr;
    if (bytes) {
        data = ctx->env->NewByteArray(static_cast<jsize>(len));
        if (data) ctx->env->SetByteArrayRegion(data, 0, static_cast<jsize>(len), reinterpret_cast<const jbyte*>(bytes));
    }
    if (!ctx->env->ExceptionCheck()) ctx->env->CallVoidMethod(ctx->listener, ctx->method, static_cast<jint>(kind), data, static_cast<jint>(code));
    if (ctx->env->ExceptionCheck()) { ctx->env->ExceptionClear(); vc_transport_close(ctx->id); }
    if (data) ctx->env->DeleteLocalRef(data);
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_vaultchat_transportcore_TransportCoreModule_nativeCreate(JNIEnv*, jobject) {
    return static_cast<jlong>(vc_transport_create());
}
extern "C" JNIEXPORT jboolean JNICALL
Java_com_vaultchat_transportcore_TransportCoreModule_nativeSupportsWebTransport(JNIEnv*, jobject) {
    return vc_transport_supports_webtransport() ? JNI_TRUE : JNI_FALSE;
}
extern "C" JNIEXPORT void JNICALL
Java_com_vaultchat_transportcore_TransportCoreModule_nativeClose(JNIEnv*, jobject, jlong id) {
    vc_transport_close(static_cast<uint64_t>(id));
}
extern "C" JNIEXPORT jboolean JNICALL
Java_com_vaultchat_transportcore_TransportCoreModule_nativeSend(JNIEnv* env, jobject, jlong id, jbyteArray data) {
    const auto len = env->GetArrayLength(data);
    if (len <= 0 || len > 2097157) return JNI_FALSE;
    auto* bytes = env->GetByteArrayElements(data, nullptr);
    if (!bytes) return JNI_FALSE;
    bool accepted = vc_transport_send(static_cast<uint64_t>(id), reinterpret_cast<const uint8_t*>(bytes), static_cast<size_t>(len));
    env->ReleaseByteArrayElements(data, bytes, JNI_ABORT);
    return accepted ? JNI_TRUE : JNI_FALSE;
}
extern "C" JNIEXPORT void JNICALL
Java_com_vaultchat_transportcore_TransportCoreModule_nativeRun(JNIEnv* env, jobject, jlong id, jstring url, jstring token, jobject listener) {
    const auto cls = env->GetObjectClass(listener);
    const auto method = env->GetMethodID(cls, "onEvent", "(I[BI)V");
    env->DeleteLocalRef(cls);
    if (!method) { vc_transport_close(id); return; }
    const char* address = env->GetStringUTFChars(url, nullptr);
    if (!address) { vc_transport_close(id); return; }
    const char* credential = env->GetStringUTFChars(token, nullptr);
    if (credential) {
        Listener ctx{env, listener, method, static_cast<uint64_t>(id)};
        vc_transport_run(id, address, credential, onEvent, &ctx);
        env->ReleaseStringUTFChars(token, credential);
    } else { vc_transport_close(id); }
    env->ReleaseStringUTFChars(url, address);
}
