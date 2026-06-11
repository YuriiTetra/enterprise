// watcher.js — keep the persisted index close to disk truth. On a file change,
// reindex ONLY that file's atoms (re-symbol + re-embed + refresh containment).
// The persisted graph is for retrieval, so "close" is enough; the live clangd
// path (nav.js) is what must be exactly fresh, and clangd reindexes itself.

import chokidar from 'chokidar';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Db, vecToBlob } from './db.js';
import { Clangd } from './clangd.js';
import { embed } from './embeddings.js';
import { bucketFor, moduleToken, canonicalCode } from './fqdn.js';

const CODE_EXT = ['.h', '.hpp', '.cpp', '.c', '.cc'];
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

export async function startWatcher({ root, dbFile, compileDir, log }) {
  const db = new Db(dbFile);
  const clangd = new Clangd({ root, compileDir });
  await clangd.start();
  log('watcher: clangd starting, settling index...');
  await clangd.awaitIndexed(120000);

  const paths = JSON.parse(db.getMeta('code_paths') || '["src/engine/backend"]');
  const watchDirs = paths.map((p) => path.join(root, p)).concat([path.join(root, 'docs')]);

  let queue = Promise.resolve();
  const enqueue = (fn) => { queue = queue.then(fn).catch((e) => log(`watch err: ${e.message}`)); };

  const w = chokidar.watch(watchDirs, {
    ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    ignored: /(^|[\/\\])\.|node_modules|build|3rdparty/,
  });

  w.on('all', (event, file) => {
    const rel = path.relative(root, file);
    const ext = path.extname(file);
    if (CODE_EXT.includes(ext)) enqueue(() => reindexCodeFile(db, clangd, root, rel, event, log));
    else if (ext === '.md') enqueue(() => reindexDoc(db, root, rel, event, log));
  });

  log(`watcher: watching ${watchDirs.length} dirs (Ctrl-C to stop)`);
  process.on('SIGINT', () => { clangd.stop(); db.close(); process.exit(0); });
}

async function reindexCodeFile(db, clangd, root, rel, event, log) {
  const t0 = Date.now();
  db.deleteAtomsInFile(rel);
  if (event === 'unlink' || !existsSync(path.join(root, rel))) { log(`- ${rel} (removed)`); return; }

  // clangd needs to re-see the file; re-open with a bumped version by closing first
  clangd.opened.delete(`file://${path.join(root, rel)}`);
  let symbols = [];
  try { symbols = await clangd.documentSymbols(rel); } catch { /* */ }

  const flat = [];
  (function walk(arr, parentQual) {
    for (const s of arr || []) {
      const qual = parentQual ? `${parentQual}::${s.name}` : s.name;
      if ([3, 5, 6, 9, 10, 11, 12, 14, 22, 23].includes(s.kind))
        flat.push({ name: s.name, symbol: qual, kind: s.kind, detail: s.detail || '',
          line: (s.selectionRange?.start?.line ?? 0) + 1, character: (s.selectionRange?.start?.character ?? 0) + 1,
          parentQual });
      if (s.children) walk(s.children, qual);
    }
  })(symbols, '');

  for (const a of flat) {
    const fqdn = canonicalCode(rel, a.symbol);
    const short = `${bucketFor(rel).prefix}.${moduleToken(rel)}.${a.name}`;
    const vec = await embed(`${a.symbol} ${a.detail} in ${rel}`);
    db.upsertAtom({ fqdn, short, relpath: rel, symbol: a.symbol, name: a.name, kind: a.kind,
      line: a.line, character: a.character, parent_id: null, summary: a.detail || null,
      embedding: vecToBlob(vec), hash: hash(a.symbol + a.line) });
  }
  log(`~ ${rel}: ${flat.length} atoms (${Date.now() - t0}ms)`);
}

async function reindexDoc(db, root, rel, event, log) {
  const abs = path.join(root, rel);
  if (event === 'unlink' || !existsSync(abs)) return;
  const text = readFileSync(abs, 'utf8');
  const title = (/^#\s+(.+)$/m.exec(text)?.[1] || path.basename(rel, '.md')).trim();
  const vec = await embed(`${title}\n${text.slice(0, 2000)}`);
  db.upsertDoc({ fqdn: rel, short: null, relpath: rel, title, embedding: vecToBlob(vec), hash: hash(text) });
  log(`~ ${rel} (doc)`);
}
