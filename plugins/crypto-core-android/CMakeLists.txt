# crypto-core — links the cargo-ndk-built Rust staticlib + the Nitro C++
# wrapper into libvaultcrypto.so. Lives at android/crypto-core after prebuild,
# so ../../ is the repo root.
cmake_minimum_required(VERSION 3.22.1)
project(vaultcrypto)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(vaultcrypto SHARED src/main/cpp/HybridCryptoCore.cpp)

find_package(react-native-nitro-modules REQUIRED CONFIG)
find_package(ReactAndroid REQUIRED CONFIG)
find_library(LOG_LIB log)

# Rust staticlib produced by the cargoBuildCryptoCore gradle task.
set(RUST_TARGET_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../services/crypto/rust/target)
if(ANDROID_ABI STREQUAL "arm64-v8a")
  set(RUST_TRIPLE aarch64-linux-android)
elseif(ANDROID_ABI STREQUAL "armeabi-v7a")
  set(RUST_TRIPLE armv7-linux-androideabi)
elseif(ANDROID_ABI STREQUAL "x86")
  set(RUST_TRIPLE i686-linux-android)
elseif(ANDROID_ABI STREQUAL "x86_64")
  set(RUST_TRIPLE x86_64-linux-android)
else()
  message(FATAL_ERROR "crypto-core: unsupported ABI ${ANDROID_ABI}")
endif()

add_library(crypto_core_rust STATIC IMPORTED)
set_target_properties(crypto_core_rust PROPERTIES
  IMPORTED_LOCATION ${RUST_TARGET_DIR}/${RUST_TRIPLE}/release/libcrypto_core.a)

target_link_libraries(vaultcrypto
  react-native-nitro-modules::NitroModules
  ReactAndroid::jsi
  ReactAndroid::reactnative
  crypto_core_rust
  ${LOG_LIB}
  android
)
