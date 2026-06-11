# oes-codegraph

Code-intelligence MCP server for the OES core, built for the Claude-dev workflow.

## Why

clangd already gives semantic def/refs/callers — but its index goes **stale**
right after a bulk change and returns confidently-incomplete results (proven on
the 854-file upstream merge: `findReferences` returned 2 of 15). For an AI agent
that ACTS on a blast-radius answer, an incomplete result is worse than none.
This server wraps clangd with a freshness guard, adds concept->symbol vector
search (which clangd can't do), FQDN no-read-ops resolution, and Glova
code<->doc linking.

## Layers

- **LIVE (clangd, freshness-guarded):** `cg_definition`, `cg_references`,
  `cg_callers`, `cg_blast_radius`. Must be exactly fresh — queried live.
- **PERSISTED (sqlite):** `cg_resolve` (FQDN -> path), `cg_search`
  (graph-augmented RAG over symbol embeddings + edges + Glova doc links).

## Use

```
npm install
node src/cli.js index --paths src/engine/backend,docs   # build persisted index
node src/cli.js resolve "src/.../databaseLayer.h#ibTxOptions"
node src/cli.js callers ibConnectionScope::SafeBeginTransaction
node src/cli.js blast  ibConnectionScope::SafeBeginTransaction 2
node src/cli.js search "how is a transaction begun"
node src/cli.js watch                                    # incremental reindex
node src/server.js                                       # MCP stdio server
```

Env: `OES_CG_ROOT`, `OES_CG_DB`, `OES_CG_COMPILE_DIR`, `OES_CG_MODEL`, `OES_CG_OFFLINE=1`.

Status: MVP. clangd first-warmup of the full core takes minutes (then persisted
in `.cache/clangd`); the persisted RAG/FQDN layer is independent of warmth.
