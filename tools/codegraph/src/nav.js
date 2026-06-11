// nav.js — LIVE navigation over clangd. These answers must be FRESH because an
// agent acts on them (a missed caller ships a regression), so every entry point
// awaits the freshness guard and queries clangd directly — never the persisted
// (possibly stale) edge graph.

import { classify, parseCanonicalCode } from './fqdn.js';

/** Locate a (file, line0, char0) decl position for a symbol or fqdn. */
function locate(db, target) {
  // fqdn?
  if (classify(target) === 'canonical-code') {
    const a = db.atomByFqdn(target);
    if (a) return { file: a.relpath, line: a.line - 1, character: a.character - 1, name: a.name };
    const p = parseCanonicalCode(target);
    if (p) return { _needName: p.symbol };
  }
  // bare name / qualified — pick the best atom (prefer a definition kind)
  const candidates = db.atomsByName(target.split('::').pop());
  const exact = candidates.filter((a) => a.symbol === target || a.name === target);
  const pool = exact.length ? exact : candidates;
  if (!pool.length) return null;
  // prefer method/function/ctor decls
  pool.sort((a, b) => (b.kind === 12 || b.kind === 6) - (a.kind === 12 || a.kind === 6));
  const a = pool[0];
  return { file: a.relpath, line: a.line - 1, character: a.character - 1, name: a.name,
    ambiguous: pool.length > 1 ? pool.length : 0 };
}

async function ensureFresh(clangd, fresh) {
  if (fresh) await clangd.awaitIndexed();
}

export async function definition(db, clangd, target, { fresh = true } = {}) {
  await ensureFresh(clangd, fresh);
  const loc = locate(db, target);
  if (!loc || loc._needName) return { error: 'symbol not located', target };
  return { target, name: loc.name, definitions: await clangd.definition(loc.file, loc.line, loc.character) };
}

export async function references(db, clangd, target, { fresh = true } = {}) {
  await ensureFresh(clangd, fresh);
  const loc = locate(db, target);
  if (!loc || loc._needName) return { error: 'symbol not located', target };
  const refs = await clangd.references(loc.file, loc.line, loc.character, true);
  return { target, name: loc.name, count: refs.length,
    ambiguousDecl: loc.ambiguous || 0, references: refs };
}

export async function callers(db, clangd, target, { fresh = true } = {}) {
  await ensureFresh(clangd, fresh);
  const loc = locate(db, target);
  if (!loc || loc._needName) return { error: 'symbol not located', target };
  const inc = await clangd.incomingCalls(loc.file, loc.line, loc.character);
  return { target, name: loc.name, count: inc.length, callers: inc };
}

/**
 * Transitive blast-radius: BFS over incoming calls to `depth`. Fresh by design.
 */
export async function blastRadius(db, clangd, target, { depth = 2, fresh = true, cap = 200 } = {}) {
  await ensureFresh(clangd, fresh);
  const root = locate(db, target);
  if (!root || root._needName) return { error: 'symbol not located', target };

  const seen = new Set();
  const levels = [];
  let frontier = [{ file: root.file, line: root.line, character: root.character, name: root.name }];
  seen.add(`${root.file}:${root.name}`);

  for (let d = 0; d < depth && frontier.length; d++) {
    const next = [];
    const levelOut = [];
    for (const f of frontier) {
      let inc = [];
      try { inc = await clangd.incomingCalls(f.file, f.line, f.character); } catch { /* skip */ }
      for (const c of inc) {
        const key = `${c.file}:${c.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        levelOut.push({ name: c.name, location: `${c.file}:${c.line}`, via: f.name, callSites: c.callSites });
        if (c.line != null) next.push({ file: c.file, line: c.line - 1, character: (c.character || 1) - 1, name: c.name });
        if (seen.size > cap) break;
      }
      if (seen.size > cap) break;
    }
    if (levelOut.length) levels.push({ depth: d + 1, callers: levelOut });
    frontier = next;
    if (seen.size > cap) { levels.push({ truncatedAt: cap }); break; }
  }

  const total = seen.size - 1;
  return { target, name: root.name, depth, totalImpacted: total,
    ambiguousDecl: root.ambiguous || 0, levels };
}
