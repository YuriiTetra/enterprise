/////////////////////////////////////////////////////////////////////////////
// OES plugin ABI — minimal C interface a third-party DLL must export to be
// recognised as an OES plugin. Plain C so the boundary stays ABI-stable
// across MSVC/Clang/GCC and different STL versions.
//
// A candidate DLL is considered a plugin when:
//   1. GetProcAddress(dll, "oes_plugin_info") returns non-null.
//   2. The returned ibPluginInfo's abi_version == IB_PLUGIN_ABI_VERSION.
//
// Anything else (system DLL, vendor runtime, ibBackendException catch etc.)
// fails one of these two checks and is skipped silently.
/////////////////////////////////////////////////////////////////////////////

#ifndef _IB_PLUGIN_API_H_
#define _IB_PLUGIN_API_H_

#ifdef __cplusplus
extern "C" {
#endif

// Bump when the ABI changes incompatibly. Plugins compiled against an older
// number are rejected by the loader.
#define IB_PLUGIN_ABI_VERSION 1

typedef struct ibPluginInfo_s {
	int         abi_version;   // must equal IB_PLUGIN_ABI_VERSION
	const char* name;          // short identifier, e.g. "Excel Export"
	const char* version;       // free-form, e.g. "1.0.0"
	const char* description;   // user-facing summary, one line
	const char* vendor;        // optional, may be NULL
} ibPluginInfo;

// Required exports. Prototypes are typedefs so the host can GetProcAddress
// them without including wx/anything.
typedef const ibPluginInfo* (*ibPluginInfoFn)(void);

// Optional: called once after a successful info check. hostContext is a
// reserved pointer (currently NULL; future versions may pass ibApplicationData).
// Return 0 on success; non-zero aborts plugin load.
typedef int  (*ibPluginInitializeFn)(void* hostContext);

// Optional: called once before the DLL is unloaded.
typedef void (*ibPluginShutdownFn)(void);

#ifdef _WIN32
  #define OES_PLUGIN_EXPORT __declspec(dllexport)
#else
  #define OES_PLUGIN_EXPORT __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
}
#endif

#endif // _IB_PLUGIN_API_H_
