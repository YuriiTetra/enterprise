// resolve.js — the no-read-ops core: an FQDN (either form) -> a concrete path.
// The agent NEVER guesses a path; it sees an FQDN, calls resolve, then reads.
//
// Sources, in order (only local ones are implemented; the enum is a seam for
// future remote sources, intentionally unimplemented):
//   1. local     — indexed atoms/docs in the project DB
//   2. workspace — a path on disk (canonical-doc / file#symbol) even if unindexed
//   3. remote*   — NOT implemented (typed seam only)

import path from 'node:path';
import { existsSync } from 'node:fs';
import { classify, parseCanonicalCode, parseShort } from './fqdn.js';

export const Source = { LOCAL: 'local', WORKSPACE: 'workspace', REMOTE: 'remote' };

/**
 * @returns {{ok:true, canonicalPath, absPath, exists, source, symbol?, line?}
 *          | {ok:false, code, message, candidates?}}
 */
export function resolve(db, root, fqdn) {
  // alias hop first (renamed / re-bucketed ids on a grace period)
  const aliased = db.resolveAlias(fqdn);
  if (aliased) fqdn = aliased;

  const kind = classify(fqdn);

  if (kind === 'short') return resolveShort(db, root, fqdn);
  if (kind === 'canonical-code') return resolveCanonicalCode(db, root, fqdn);
  return resolveCanonicalDoc(db, root, fqdn);
}

function ok(root, relpath, extra = {}) {
  const absPath = path.join(root, relpath);
  return { ok: true, canonicalPath: relpath, absPath, exists: existsSync(absPath),
    source: extra._source || Source.LOCAL, ...stripMeta(extra) };
}
function stripMeta(e) { const { _source, ...rest } = e; return rest; }

function resolveCanonicalCode(db, root, fqdn) {
  const p = parseCanonicalCode(fqdn);
  if (!p) return { ok: false, code: 'BAD_FQDN', message: `not a code fqdn: ${fqdn}` };
  const atom = db.atomByFqdn(fqdn);
  if (atom) return ok(root, atom.relpath, { symbol: atom.symbol, line: atom.line, _source: Source.LOCAL });
  // workspace fallback: the file exists even if the symbol isn't indexed
  if (existsSync(path.join(root, p.relpath)))
    return ok(root, p.relpath, { symbol: p.symbol, _source: Source.WORKSPACE });
  return { ok: false, code: 'NOT_FOUND', message: `unindexed and not on disk: ${fqdn}` };
}

function resolveCanonicalDoc(db, root, fqdn) {
  // doc fqdn == its relpath
  if (existsSync(path.join(root, fqdn)))
    return ok(root, fqdn, { _source: db.atomByFqdn(fqdn) ? Source.LOCAL : Source.WORKSPACE });
  return { ok: false, code: 'NOT_FOUND', message: `no such path: ${fqdn}` };
}

function resolveShort(db, root, fqdn) {
  const s = parseShort(fqdn);
  if (!s) return { ok: false, code: 'BAD_FQDN', message: `bad short form: ${fqdn}` };
  // short form has no slot lookup table in v1 — match by stored short string.
  const atoms = db.atomsByShort(fqdn);
  if (atoms.length === 1)
    return ok(root, atoms[0].relpath, { symbol: atoms[0].symbol, line: atoms[0].line });
  if (atoms.length > 1)
    return { ok: false, code: 'AMBIGUOUS', message: `short form matches ${atoms.length} atoms`,
      candidates: atoms.map((a) => ({ fqdn: a.fqdn, location: `${a.relpath}:${a.line}` })) };
  // try by bare symbol name as a courtesy
  const byName = db.atomsByName(s.symbol);
  if (byName.length === 1)
    return ok(root, byName[0].relpath, { symbol: byName[0].symbol, line: byName[0].line });
  if (byName.length > 1)
    return { ok: false, code: 'AMBIGUOUS', message: `name '${s.symbol}' matches ${byName.length} atoms`,
      candidates: byName.map((a) => ({ fqdn: a.fqdn, location: `${a.relpath}:${a.line}` })) };
  return { ok: false, code: 'NOT_FOUND', message: `no atom for ${fqdn}` };
}
