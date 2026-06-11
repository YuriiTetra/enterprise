#!/usr/bin/env node
// cli.js — build the index and probe it without the MCP layer.
//
//   node src/cli.js index [--paths src/engine/backend,docs]
//   node src/cli.js rebuild
//   node src/cli.js resolve <fqdn>
//   node src/cli.js callers <symbol>
//   node src/cli.js blast <symbol> [depth]
//   node src/cli.js search "<query>"
//   node src/cli.js watch

import path from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { Db } from './db.js';
import { Clangd } from './clangd.js';
import { indexCode, indexDocs } from './indexer.js';
import { resolve as resolveFqdn } from './resolve.js';
import { search as ragSearch } from './rag.js';
import * as nav from './nav.js';

const ROOT = process.env.OES_CG_ROOT || path.resolve(process.cwd(), '../..');
const DBFILE = process.env.OES_CG_DB || path.join(ROOT, 'tools/codegraph/.cache/codegraph.db');
const COMPILE_DIR = process.env.OES_CG_COMPILE_DIR || path.join(ROOT, 'build');

const log = (m) => process.stderr.write(`[codegraph] ${m}\n`);
const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : def;
}

async function withClangd(fn) {
  const c = new Clangd({ root: ROOT, compileDir: COMPILE_DIR });
  await c.start();
  try { return await fn(c); } finally { c.stop(); }
}

const cmd = process.argv[2];

if (cmd === 'rebuild') {
  if (existsSync(DBFILE)) { rmSync(DBFILE, { force: true }); rmSync(DBFILE + '-wal', { force: true }); rmSync(DBFILE + '-shm', { force: true }); }
  log('cache cleared');
}

if (cmd === 'index' || cmd === 'rebuild') {
  const paths = (arg('--paths', 'src/engine/backend,docs')).split(',').map((s) => s.trim());
  const codePaths = paths.filter((p) => p !== 'docs');
  const db = new Db(DBFILE);
  await withClangd(async (c) => {
    // documentSymbols is per-file AST — it does NOT need the full background
    // index. A short settle lets clangd parse compile flags; then we index.
    await new Promise((r) => setTimeout(r, 3000));
    log('indexing code (documentSymbols per file)');
    const n = await indexCode(db, c, ROOT, codePaths, log);
    log(`indexed ${n} atoms`);
  });
  if (paths.includes('docs')) { const d = await indexDocs(db, ROOT, log); log(`indexed ${d} docs`); }
  db.close();
  log('done');
} else if (cmd === 'resolve') {
  const db = new Db(DBFILE); out(resolveFqdn(db, ROOT, process.argv[3])); db.close();
} else if (cmd === 'callers') {
  const db = new Db(DBFILE);
  await withClangd(async (c) => out(await nav.callers(db, c, process.argv[3])));
  db.close();
} else if (cmd === 'blast') {
  const db = new Db(DBFILE);
  await withClangd(async (c) => out(await nav.blastRadius(db, c, process.argv[3], { depth: Number(process.argv[4] || 2) })));
  db.close();
} else if (cmd === 'refs') {
  const db = new Db(DBFILE);
  await withClangd(async (c) => out(await nav.references(db, c, process.argv[3])));
  db.close();
} else if (cmd === 'search') {
  const db = new Db(DBFILE); out(await ragSearch(db, process.argv[3], { topK: 8 })); db.close();
} else if (cmd === 'watch') {
  const { startWatcher } = await import('./watcher.js');
  await startWatcher({ root: ROOT, dbFile: DBFILE, compileDir: COMPILE_DIR, log });
} else if (!['index', 'rebuild'].includes(cmd)) {
  log('commands: index | rebuild | resolve <fqdn> | callers <sym> | blast <sym> [d] | refs <sym> | search "<q>" | watch');
  process.exit(1);
}
