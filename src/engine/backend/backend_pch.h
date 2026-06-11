// backend_pch.h — precompiled-header payload for the backend target.
//
// Only ubiquitous, stable headers belong here: the heavy wx + STL ones that
// nearly every backend TU pulls in. PCH parses them once instead of ~350 times.
// Do NOT add project headers that change often — a churny PCH invalidates the
// whole target on every edit. CXX-only (the firebird/sqlite .c sources never
// see this; the CMake list guards by COMPILE_LANGUAGE).
#pragma once

#include <wx/string.h>
#include <wx/arrstr.h>
#include <wx/datetime.h>

#include <vector>
#include <string>
#include <memory>
#include <unordered_map>
#include <functional>
