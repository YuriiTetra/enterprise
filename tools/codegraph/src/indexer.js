// indexer.js — build the persisted graph from disk.
//
// Division of labour (deliberate, per the freshness thesis):
//   - LIVE from clangd at query time: definition / references / callers /
//     blast_radius. Always fresh; never trust a stale persisted call edge for
//     something an agent will act on.
//   - PERSISTED here: atoms (for FQDN resolve + vector search), embeddings,
//     containment + include edges (for RAG Tier-3 neighbourhood walk), docs,
//     and Glova code<->doc links. Retrieval tolerates slight staleness; the
//     watcher keeps it close anyway.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { vecToBlob } from './db.js';
import { embedMany } from './embeddings.js';
import { bucketFor, moduleToken, canonicalCode, docParts } from './fqdn.js';

const KIND_NAME = {
  5: 'class', 6: 'method', 9: 'constructor', 11: 'interface', 12: 'function',
  10: 'enum', 22: 'struct', 23: 'event', 13: 'variable', 14: 'constant',
  8: 'field', 26: 'type-parameter', 3: 'namespace',
};
// Symbols worth indexing as atoms (skip locals, params, etc.).
const ATOM_KINDS = new Set([5, 6, 9, 10, 11, 12, 22, 23, 3, 14]);

function hash(s) { return createHash('sha1').update(s).digest('hex').slice(0, 16); }

function walkFiles(dir, exts, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'build' || e.name === '3rdparty') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(full);
  }
  return out;
}

/** Flatten clangd DocumentSymbol tree into atom records with containment. */
function flattenSymbols(symbols, relpath, parentQual = '', acc = []) {
  for (const s of symbols || []) {
    const qual = parentQual ? `${parentQual}::${s.name}` : s.name;
    if (ATOM_KINDS.has(s.kind)) {
      // DocumentSymbol has selectionRange/range; SymbolInformation has location.range
      const start = (s.selectionRange?.start ?? s.range?.start ?? s.location?.range?.start ?? { line: 0, character: 0 });
      acc.push({
        name: s.name,
        symbol: qual,
        kind: s.kind,
        detail: s.detail || '',
        line: start.line + 1,
        character: start.character + 1,
        relpath,
        parentQual,
      });
    }
    if (s.children) flattenSymbols(s.children, relpath, qual, acc);
  }
  return acc;
}

export async function indexCode(db, clangd, root, paths, log = () => {}) {
  const exts = ['.h', '.hpp', '.cpp', '.c', '.cc'];
  const files = [];
  for (const p of paths) {
    const abs = path.join(root, p);
    if (existsSync(abs) && statSync(abs).isDirectory()) walkFiles(abs, exts, files);
    else if (existsSync(abs)) files.push(abs);
  }
  log(`scanning ${files.length} files for symbols`);

  // 1) symbols -> atom rows (+ containment map for edges)
  const atomRows = [];
  let done = 0;
  for (const abs of files) {
    const rel = path.relative(root, abs);
    let symbols;
    try { symbols = await clangd.documentSymbols(rel); } catch { symbols = []; }
    const flat = flattenSymbols(symbols, rel);
    for (const a of flat) atomRows.push(a);
    if (++done % 100 === 0) log(`  symbols ${done}/${files.length}`);
  }
  log(`collected ${atomRows.length} atoms; embedding...`);

  // 2) embeddings — feed a readable string, not the bare mangled identifier
  const texts = atomRows.map((a) =>
    `${KIND_NAME[a.kind] || 'symbol'} ${a.symbol} ${a.detail} in ${a.relpath}`);
  const vecs = await embedMany(texts, (i, n) => log(`  embed ${i}/${n}`));

  // 3) persist atoms; assign canonical + short fqdn
  const idByFqdn = new Map();
  const insert = db.db.transaction(() => {
    for (let i = 0; i < atomRows.length; i++) {
      const a = atomRows[i];
      const fqdn = canonicalCode(a.relpath, a.symbol);
      const bucket = bucketFor(a.relpath);
      const short = `${bucket.prefix}.${moduleToken(a.relpath)}.${a.name}`;
      const id = db.upsertAtom({
        fqdn, short, relpath: a.relpath, symbol: a.symbol, name: a.name,
        kind: a.kind, line: a.line, character: a.character, parent_id: null,
        summary: a.detail || null, embedding: vecToBlob(vecs[i]),
        hash: hash(a.symbol + a.line),
      });
      idByFqdn.set(fqdn, id);
      a._id = id;
    }
    // containment edges (parent class/namespace -> member)
    for (const a of atomRows) {
      if (!a.parentQual) continue;
      const parentFqdn = canonicalCode(a.relpath, a.parentQual);
      const pid = idByFqdn.get(parentFqdn);
      if (pid && a._id) db.addEdge(pid, a._id, 'contains');
    }
  });
  insert();
  log(`persisted ${atomRows.length} atoms + containment edges`);

  // 4) include edges (file -> file, attached to representative atoms)
  indexIncludeEdges(db, root, files, idByFqdn);

  db.setMeta('code_indexed_at', Date.now());
  db.setMeta('code_paths', JSON.stringify(paths));
  return atomRows.length;
}

function indexIncludeEdges(db, root, files, idByFqdn) {
  // crude: link the first atom of a file to the first atom of each #included
  // local header. Enough for RAG neighbourhood; not a precise dep graph.
  const firstAtomOf = new Map();
  for (const [fqdn, id] of idByFqdn) {
    const rel = fqdn.slice(0, fqdn.lastIndexOf('#'));
    if (!firstAtomOf.has(rel)) firstAtomOf.set(rel, id);
  }
  for (const abs of files) {
    const rel = path.relative(root, abs);
    const srcId = firstAtomOf.get(rel);
    if (!srcId) continue;
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/#include\s+"([^"]+)"/g)) {
      const inc = m[1];
      // try to resolve included header to an indexed file by basename
      const base = path.basename(inc);
      for (const [r, id] of firstAtomOf) {
        if (r.endsWith('/' + base) || r === base) { db.addEdge(srcId, id, 'includes'); break; }
      }
    }
  }
}

export async function indexDocs(db, root, log = () => {}) {
  const docsDir = path.join(root, 'docs');
  if (!existsSync(docsDir)) { log('no docs/ dir'); return 0; }
  const files = walkFiles(docsDir, ['.md']);
  log(`indexing ${files.length} docs`);

  const rows = [];
  for (const abs of files) {
    const rel = path.relative(root, abs);
    let text; try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    const titleM = /^#\s+(.+)$/m.exec(text);
    const dp = docParts(rel);
    rows.push({
      relpath: rel,
      title: titleM ? titleM[1].trim() : path.basename(rel, '.md'),
      short: dp ? `S.${dp.area}.${dp.slug}` : null,
      text,
    });
  }
  const vecs = await embedMany(rows.map((r) => `${r.title}\n${r.text.slice(0, 2000)}`),
    (i, n) => log(`  embed doc ${i}/${n}`));

  const tx = db.db.transaction(() => {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const id = db.upsertDoc({
        fqdn: r.relpath, short: r.short, relpath: r.relpath, title: r.title,
        embedding: vecToBlob(vecs[i]), hash: hash(r.text),
      });
      r._id = id;
    }
  });
  tx();

  // 5) Glova links: doc mentions a code symbol (by FQDN or by bare name)
  linkDocsToCode(db, rows, log);
  db.setMeta('docs_indexed_at', Date.now());
  return rows.length;
}

function linkDocsToCode(db, docRows, log) {
  // Build a name -> atomIds map once.
  const byName = new Map();
  for (const a of db.db.prepare('SELECT id,name FROM atoms').all()) {
    if (a.name.length < 4) continue;             // skip trivial names
    if (!byName.has(a.name)) byName.set(a.name, []);
    byName.get(a.name).push(a.id);
  }
  let links = 0;
  const tx = db.db.transaction(() => {
    for (const d of docRows) {
      const seen = new Set();
      // explicit FQDN mention: relpath#symbol
      for (const m of d.text.matchAll(/[\w./-]+\.(?:h|hpp|cpp|cc)#[\w:]+/g)) {
        const a = db.atomByFqdn(m[0]);
        if (a && !seen.has(a.id)) { db.addDocLink(d._id, a.id, 'fqdn'); seen.add(a.id); links++; }
      }
      // bare ib-prefixed symbol mentions (OES convention: ibXxx / m_xxx)
      for (const m of d.text.matchAll(/\bib[A-Z]\w{3,}/g)) {
        const ids = byName.get(m[0]);
        if (!ids) continue;
        for (const id of ids) {
          if (seen.has(id)) continue;
          db.addDocLink(d._id, id, 'symbol-mention'); seen.add(id); links++;
          if (seen.size > 40) break;             // cap noisy docs
        }
      }
    }
  });
  tx();
  log(`Glova: ${links} doc<->code links`);
}
