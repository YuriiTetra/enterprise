# Integration plan — feature/syntax-helper → develop

Status: **planned, not started.** Recon done 2026-06-12. Execute in a fresh,
focused session (structural conflicts — quality needs clean context).

## The situation

Two large tracks diverged from the same base `fc333932`
("macOS/Clang: fix Clang errors uncovered by upstream rebase"):

- **develop** — upstream OES catch-up (60 commits: query engine L2-L4, record
  locks, audit log, doc/view fork, typeid registry, CLSID FNV-1a, gtest
  revival) + postgres-dialect extraction + codegraph + build-speed.
- **feature/syntax-helper** — **139 unique commits**: the AI-assistant / Pugi
  chat integration, the plugin system (ABI v1-v4, pluginManager phases 1-7,
  sandbox, policy), the help / syntax-helper subsystem (corpus, panes, gettext,
  CES/VES), template wizard, metaBridge, oes-rag-local, designer agent work.

The longer they live apart the worse the merge — this is the #1 lurking risk,
ahead of any feature work.

## Recon (test-merge feature/syntax-helper → develop, then aborted)

- Merge brings **287 files, +79,696 / −696**.
- **35 conflicted files.** Distribution: designer/mainFrame ×6, backend/
  metaCollection ×5, backend/compiler ×2, frontend ×5 scattered, tests ×3, the
  rest 1 each.
- Conflict hunks are mostly small (1–3 per file). The outlier is
  `docs/syntax-helper-design.md` (23 hunks — trivial, union the text).

### The hard part — STRUCTURAL, not textual

feature/syntax-helper **reorganized `designer/` into `designer/mainFrame/`**.
Two modify/delete conflicts prove it:

- `designer/mainFrameDesignerCmd.cpp`  — deleted in syntax-helper (moved), modified in develop
- `designer/mainFrameDesignerMenu.cpp` — deleted in syntax-helper (moved), modified in develop

There are NEW counterparts under `designer/mainFrame/` with content conflicts.
So this is a file-move-vs-edit: develop's edits to the OLD path must be carried
into the NEW location, not just "take one side". Resolving wrong = a silent
designer runtime bug that won't show at build time. This is why it is NOT a
tail-of-session task.

## Full conflict list (35)

```
CMakeLists.txt
docs/syntax-helper-design.md
backend/CMakeLists.txt
backend/appData.cpp,  backend/appData.h
backend/backend.vcxproj,  backend/backend.vcxproj.filters
backend/backend_exception.cpp,  backend/backend_exception.h
backend/compiler/cache/byteCodeCache.cpp
backend/compiler/procUnit.cpp
backend/metaCollection/partial/{accumulationRegister,catalogManager_impl,catalog,document,informationRegister}Object.cpp
backend/session/session.cpp
backend/system/systemManager.cpp
designer/mainFrame/mainFrameDesigner.{cpp,h}
designer/mainFrame/mainFrameDesignerEvent.cpp
designer/mainFrame/mainFrameDesignerMenu.cpp
designer/mainFrame/mainFrameDesignerParts.cpp   (7 hunks — heaviest code file)
designer/mainFrame/output/outputWindow.cpp
designer/mainFrameDesignerCmd.cpp     (modify/delete — moved)
designer/mainFrameDesignerMenu.cpp    (modify/delete — moved)
frontend/docView/docView.cpp
frontend/frontend.vcxproj
frontend/mainFrame/mainFrame.h
frontend/visualView/ctrl/formObject.cpp   (5 hunks)
frontend/win/editor/codeEditor/codeEditor.cpp
simplePlugin/simplePluginDLL.cpp
tests/CMakeLists.txt,  tests/test_compiler.cpp,  tests/test_number.cpp
```

## Phased execution (next session)

1. **Branch** `feature/integrate-syntax-helper` off develop; `git merge --no-ff feature/syntax-helper`.
2. **Trivial first** — `docs/syntax-helper-design.md` (union), the two `tests/test_*` (take the API the merged backend exposes — same GetLexemCount/NumberBuffer pattern as the upstream merge), `.vcxproj`/`.vcxproj.filters` (union the source lists, Windows-only).
3. **Structural designer reorg** — for each modify/delete, read develop's edit to the OLD file, port it into the NEW `designer/mainFrame/` counterpart, then accept the delete of the old path. Files: mainFrameDesignerCmd.cpp, mainFrameDesignerMenu.cpp + the `designer/mainFrame/*` conflicts.
4. **backend** — appData/exception/session/systemManager/procUnit/byteCodeCache/metaCollection: both tracks added; keep both where additive (develop's query-engine hooks + syntax-helper's plugin/metaBridge hooks). Watch appData ctor-token + exception taxonomy (same seams the upstream merge touched).
5. **frontend** — formObject/docView/codeEditor/mainFrame.h: additive merge.
6. **CMakeLists** (root + backend + tests): union — keep develop's ccache/PCH/lld + syntax-helper's new sources (plugin, help, io, vcs).
7. **Build** — full, `-j2` (16 GB RAM, freeze risk; PCH on), keep-going to collect all Clang errors at once. Expect macOS/Clang portability fixes (the syntax-helper track was MSVC-developed) — same class as the upstream merge (ibTxOptions-style qualifiers, LP64 ctors, wxString ternaries).
8. **Test** — `oes_tests`; expect the 444 + syntax-helper's plugin/metaBridge/help suites. Watch the FirebirdLease 2 (known POSIX advisory-lock, low-pri).
9. **Land** — FF develop, push, after a clean build + green tests.

## Notes

- codegraph is on develop now — use `cg_callers` / `cg_blast_radius` to check the designer-reorg blast radius before/after each structural resolution.
- The git-service work is on a separate branch `feature/designer-git` (c6beb708) — independent, land after.
- Do NOT delete feature/syntax-helper until this merge lands and is verified.
