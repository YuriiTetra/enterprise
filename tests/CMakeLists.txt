################################################################################
# OES Enterprise — Unit Tests
#
# Uses Google Test fetched via FetchContent.
# Build with: cmake -B build -DBUILD_TESTING=ON && cmake --build build
################################################################################

cmake_minimum_required(VERSION 3.20)

include(FetchContent)

FetchContent_Declare(
    googletest
    GIT_REPOSITORY https://github.com/google/googletest.git
    GIT_TAG        v1.14.0
)

# Prevent GoogleTest from overriding our compiler/linker settings (Windows)
set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)

# Do not install GTest alongside the project
set(INSTALL_GTEST OFF CACHE BOOL "" FORCE)

FetchContent_MakeAvailable(googletest)

# ---------------------------------------------------------------------------
# OpenSSL for the triple-review integration test's direct HTTPS probe.
# cpp-httplib needs CPPHTTPLIB_OPENSSL_SUPPORT defined to enable TLS; the
# test's call site does this with #define before #include "httplib.h",
# but we still need to link OpenSSL::SSL + OpenSSL::Crypto. Without
# OpenSSL on this machine the integration test is excluded from the
# sources list entirely so it can't drag <openssl/*> into a build that
# has nothing to satisfy it.
# ---------------------------------------------------------------------------
find_package(OpenSSL QUIET)
if(OpenSSL_FOUND)
    message(STATUS "tests: OpenSSL found — triple-review HTTPS probe enabled")
else()
    message(STATUS "tests: OpenSSL not found — skipping test_tripleReviewIntegration.cpp")
endif()

# ---------------------------------------------------------------------------
# Test executable
# ---------------------------------------------------------------------------
set(OES_TESTS_SOURCES
    test_clsid.cpp
    test_value.cpp
    test_string.cpp
    bench_string.cpp
    test_number.cpp
    test_byteCodeAOT.cpp
    test_compiler.cpp
    test_runtime.cpp
    test_connectionPool.cpp
    test_session.cpp
    # --- develop: query engine + core ---
    test_module_manager_split.cpp
    test_pagingRamTable.cpp
    test_blobCompression.cpp
    test_firebirdLease.cpp
    test_logger.cpp
    test_dbTaxonomy.cpp
    test_metadataSerialize.cpp
    test_queryRenderer.cpp
    test_queryLifecycle.cpp
    test_queryBuilderShowcase.cpp
    test_queryTotals.cpp
    test_queryL2.cpp
    test_queryComposer.cpp
    test_queryL3Vocab.cpp
    test_queryL4Lexer.cpp
    test_queryL4Parser.cpp
    test_queryRewrite.cpp
    test_lambdaRecorder.cpp
    test_queryValueMembers.cpp
    # --- syntax-helper: plugin / metaBridge / help / MCP ---
    test_pluginApi.cpp
    test_pluginWebPane.cpp
    test_pluginWebPaneHistory.cpp
    test_legacyShim.cpp
    test_pluginLoadIntegration.cpp
    # Designer <-> oes-mcp concurrency primitives (configLock, mutation
    # marker). Same-process gtest coverage; inter-process semantics are
    # exercised by tests/mcp-smoke.py.
    test_configLock.cpp
    # Functional-test runner — assertion builtins + fixture manager +
    # `@test` discovery. End-to-end run_tests envelope shape is covered
    # by mcp-smoke.py.
    test_testRunner.cpp
    # Form-layout authoring (MCP form_layout_read / form_layout_set).
    # Serializer is DEFERRED (see formLayoutBlob.hpp); these tests
    # pin the deferral contract + validator-level checks that run
    # today against agent-supplied DTOs.
    test_formLayoutBlob.cpp
    # BAS / 1С XML + .cf migration to OES mutations[].
    # Covers basMapping (kind + type qualifier), basXmlReader (single-file
    # parse + root manifest), basCfReader (deferred unpacker stub).
    test_basMigration.cpp
    # Auto-snapshot manager — capture / list / load / mark consumed /
    # prune. Pure file-IO so no DB / metaBridge fixtures required.
    test_snapshotManager.cpp
)
# SEC-P2-3: only pull the triple-review integration test in when OpenSSL is
# available — the source unconditionally includes <openssl/*> via httplib.
if(OpenSSL_FOUND)
    list(APPEND OES_TESTS_SOURCES test_tripleReviewIntegration.cpp)
    # AGENT-MODE: oes_agent integration suite — same OpenSSL gate.
    list(APPEND OES_TESTS_SOURCES test_oesAgentIntegration.cpp)
endif()
add_executable(oes_tests ${OES_TESTS_SOURCES})

target_link_libraries(oes_tests
    PRIVATE
        backend
        frontend
        wx::core
        wx::base
        wx::webview
        GTest::gtest
        GTest::gtest_main
)

# Tests need to construct app-owned subsystems directly (no full appData
# bring-up). OES_TESTING opens ib::AppDataCtorToken's default ctor; see
# backend/appDataCtorToken.h.
target_compile_definitions(oes_tests PRIVATE OES_TESTING)

if(OpenSSL_FOUND)
    target_link_libraries(oes_tests PRIVATE OpenSSL::SSL OpenSSL::Crypto)
    if(APPLE)
        # cpp-httplib + OpenSSL pull in SecTrust* via the keychain trust-
        # anchor support — link the system frameworks they live in.
        target_link_libraries(oes_tests PRIVATE
            "-framework CoreFoundation"
            "-framework Security")
    endif()
endif()

target_include_directories(oes_tests PRIVATE
    "${CMAKE_SOURCE_DIR}/src"
    "${CMAKE_SOURCE_DIR}/src/engine"
    "${CMAKE_SOURCE_DIR}/src/engine/backend"
    "${CMAKE_SOURCE_DIR}/src/engine/frontend"
)

# On non-Windows the backend is a .dylib/.so; ensure the test can find it
# at runtime by setting the RPATH to the build output directory.
set_target_properties(oes_tests PROPERTIES
    CXX_STANDARD          17
    CXX_STANDARD_REQUIRED ON
    BUILD_RPATH            "${CMAKE_BINARY_DIR}/bin"
    INSTALL_RPATH          "${CMAKE_BINARY_DIR}/bin"
)

# ---------------------------------------------------------------------------
# Register with CTest
# ---------------------------------------------------------------------------
include(GoogleTest)
gtest_discover_tests(oes_tests)

# ---------------------------------------------------------------------------
# Lightweight string-layer tests — ibString/fstring only.
#
# fstring.h + fstringPool.h are header-only and depend on nothing but wxBase,
# so this target does NOT link (or recompile) backend.dll. Use it for fast
# iteration on the string type — it builds in seconds even after touching core
# backend headers:
#
#   cmake --build build --target oes_string_tests
#   ./bin/oes_string_tests                                    # functional tests
#   ./bin/oes_string_tests --gtest_also_run_disabled_tests \
#       --gtest_filter=*IbStringBench*                        # benchmark
# ---------------------------------------------------------------------------
add_executable(oes_string_tests
    test_string.cpp
    bench_string.cpp
)

target_link_libraries(oes_string_tests
    PRIVATE
        wx::base
        GTest::gtest
        GTest::gtest_main
)

target_include_directories(oes_string_tests PRIVATE
    "${CMAKE_SOURCE_DIR}/src/engine"
)

set_target_properties(oes_string_tests PROPERTIES
    CXX_STANDARD          17
    CXX_STANDARD_REQUIRED ON
    BUILD_RPATH            "${CMAKE_BINARY_DIR}/bin"
    INSTALL_RPATH          "${CMAKE_BINARY_DIR}/bin"
)

gtest_discover_tests(oes_string_tests)

# ---------------------------------------------------------------------------
# Standalone ИТОГИ-tree test — backend + gtest only, no other test TUs (so it
# links even when an optional driver, e.g. MySQL, is OFF and a sibling test TU
# references it). Pure RAM fold, no DB:
#   cmake --build build --target oes_query_totals_test --config Debug
#   ./bin/oes_query_totals_test
# ---------------------------------------------------------------------------
add_executable(oes_query_totals_test test_queryTotals.cpp)

target_link_libraries(oes_query_totals_test
    PRIVATE
        backend
        GTest::gtest
        GTest::gtest_main
)

target_compile_definitions(oes_query_totals_test PRIVATE OES_TESTING)

target_include_directories(oes_query_totals_test PRIVATE
    "${CMAKE_SOURCE_DIR}/src"
    "${CMAKE_SOURCE_DIR}/src/engine"
    "${CMAKE_SOURCE_DIR}/src/engine/backend"
)

set_target_properties(oes_query_totals_test PROPERTIES
    CXX_STANDARD          17
    CXX_STANDARD_REQUIRED ON
    BUILD_RPATH            "${CMAKE_BINARY_DIR}/bin"
    INSTALL_RPATH          "${CMAKE_BINARY_DIR}/bin"
)

gtest_discover_tests(oes_query_totals_test)
