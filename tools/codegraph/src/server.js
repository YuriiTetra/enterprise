#!/usr/bin/env node
// server.js — the OES codegraph MCP server. Exposes code-intelligence tools so
// a Claude agent can resolve FQDNs, navigate (fresh, clangd-backed), and search
// (graph-augmented RAG) instead of grep-dancing or dumping whole files.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import { Db } from './db.js';
import { Clangd } from './clangd.js';
import { resolve as resolveFqdn } from './resolve.js';
import { search as ragSearch } from './rag.js';
import * as nav from './nav.js';

const ROOT = process.env.OES_CG_ROOT || process.cwd();
const DBFILE = process.env.OES_CG_DB || path.join(ROOT, 'tools/codegraph/.cache/codegraph.db');
const COMPILE_DIR = process.env.OES_CG_COMPILE_DIR || path.join(ROOT, 'build');

const db = new Db(DBFILE);
let clangd = null;
async function clangdReady() {
  if (clangd) return clangd;
  clangd = new Clangd({ root: ROOT, compileDir: COMPILE_DIR });
  await clangd.start();
  return clangd;
}

const TOOLS = [
  {
    name: 'cg_resolve',
    description: 'Resolve an OES FQDN (canonical `relpath#symbol`/`docs/..md` or short `O.module.symbol`) to a concrete path. The no-read-ops contract: resolve THEN read; never guess a path. Ambiguous short forms return candidates.',
    inputSchema: { type: 'object', properties: { fqdn: { type: 'string' } }, required: ['fqdn'] },
    run: (args) => resolveFqdn(db, ROOT, args.fqdn),
  },
  {
    name: 'cg_definition',
    description: 'Where is this symbol defined? Live clangd, freshness-guarded. Accepts a bare/qualified name or a canonical-code FQDN.',
    inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    run: async (args) => nav.definition(db, await clangdReady(), args.target),
  },
  {
    name: 'cg_references',
    description: 'All references to a symbol (semantic, complete — beats grep, includes test mocks). Live clangd, freshness-guarded.',
    inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    run: async (args) => nav.references(db, await clangdReady(), args.target),
  },
  {
    name: 'cg_callers',
    description: 'Direct callers of a function/method, with call-site lines. Live clangd, resolves virtual dispatch and macro expansion. Use before changing a function.',
    inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    run: async (args) => nav.callers(db, await clangdReady(), args.target),
  },
  {
    name: 'cg_blast_radius',
    description: 'Transitive impact of changing a symbol: BFS over incoming calls to `depth`. Fresh by design — the freshness guard is why this tool exists (clangd alone returns confidently-stale results right after a bulk merge).',
    inputSchema: { type: 'object', properties: { target: { type: 'string' }, depth: { type: 'integer', default: 2 } }, required: ['target'] },
    run: async (args) => nav.blastRadius(db, await clangdReady(), args.target, { depth: args.depth ?? 2 }),
  },
  {
    name: 'cg_search',
    description: 'Concept->symbol semantic search (graph-augmented RAG). Use for "how does X work / where is the code that does Y" when you do not know the symbol name. Returns symbols + graph neighbours + linked docs.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, topK: { type: 'integer', default: 8 } }, required: ['query'] },
    run: (args) => ragSearch(db, args.query, { topK: args.topK ?? 8 }),
  },
];

const server = new Server({ name: 'oes-codegraph', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) return { isError: true, content: [{ type: 'text', text: `unknown tool ${req.params.name}` }] };
  try {
    const result = await tool.run(req.params.arguments || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `error: ${e.message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.on('SIGINT', () => { try { clangd?.stop(); } catch {} db.close(); process.exit(0); });
