# vaultbeam-core — links the cargo-ndk-built Rust staticlib (libvaultbeam_core.a)
# + a thin JNI C++ bridge into libvaultbeamnative.so. Lives at
# android/vaultbeam-core after prebuild, so ../../ is the repo root.
# (Mirrors plugins/crypto-core-android/CMakeLists.txt — but this is a plain JNI
# shared lib, no Nitro/jsi/reactnative link, so the surface is smaller.)
cmake_minimum_required(VERSION 3.22.1)
project(vaultbeamnative)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(vaultbeamnative SHARED src/main/cpp/VaultBeamJni.cpp)

find_library(LOG_LIB log)

# Rust staticlib produced by the cargoBuildVaultBeamCore gradle task.
set(RUST_TARGET_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../services/vaultbeam/rust/target)
if(ANDROID_ABI STREQUAL "arm64-v8a")
  set(RUST_TRIPLE aarch64-linux-android)
elseif(ANDROID_ABI STREQUAL "armeabi-v7a")
  set(RUST_TRIPLE armv7-linux-androideabi)
elseif(ANDROID_ABI STREQUAL "x86")
  set(RUST_TRIPLE i686-linux-android)
elseif(ANDROID_ABI STREQUAL "x86_64")
  set(RUST_TRIPLE x86_64-linux-android)
else()
  message(FATAL_ERROR "vaultbeam-core: unsupported ABI ${ANDROID_ABI}")
endif()

add_library(vaultbeam_core_rust STATIC IMPORTED)
set_target_properties(vaultbeam_core_rust PROPERTIES
  IMPORTED_LOCATION ${RUST_TARGET_DIR}/${RUST_TRIPLE}/release/libvaultbeam_core.a)

target_link_libraries(vaultbeamnative
  vaultbeam_core_rust
  ${LOG_LIB}
  android
)
