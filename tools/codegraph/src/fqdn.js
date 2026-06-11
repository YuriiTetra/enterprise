// fqdn.js — stable identifiers for OES artifacts, in two equivalent forms.
//
//   canonical (in metadata, human-greppable):
//     code:  <relpath>#<qualifiedSymbol>     src/engine/backend/.../databaseLayer.h#ibTxOptions
//     doc:   <relpath>                        docs/architecture/eval-scope-refactor.md
//
//   short  (compact reference for LLM context):
//     code:  <BUCKET><NNN>.<module>.<symbol>  O100.databaseLayer.ibTxOptions
//     doc:   S100.<area>.<slug>               S100.architecture.eval-scope-refactor
//
// Identity, not location: a rename moves the canonical path but the short-form
// id survives (the resolver re-points it). Hex buckets group the OES core by
// domain so a short id carries a coarse "where" without a lookup.
//
// Buckets are deliberately small (3-digit slot). This is the OES-specific map;
// adjust as the tree grows. No external brand names / TLDs ever appear here.

export const BUCKETS = [
  // order matters: first match wins (most specific path fragment first)
  { prefix: 'B', test: (p) => /\/(bas|migration)\b|basMapping|basXml|basCf/i.test(p), label: 'business/BAS' },
  { prefix: 'D', test: (p) => /\/databaseLayer\b|\/query\b|\/session\b|\/lock\b/.test(p), label: 'data' },
  { prefix: 'O', test: (p) => /^src\/engine\/backend\//.test(p), label: 'core-backend' },
  { prefix: 'F', test: (p) => /^src\/engine\/frontend\//.test(p), label: 'core-frontend' },
  { prefix: 'G', test: (p) => /^src\/engine\/designer\//.test(p), label: 'designer' },
  { prefix: 'S', test: (p) => /^docs\//.test(p), label: 'spec/doc' },
  { prefix: 'O', test: () => true, label: 'core' }, // fallback
];

export function bucketFor(relpath) {
  return BUCKETS.find((b) => b.test(relpath)) || BUCKETS[BUCKETS.length - 1];
}

const SHORT_RE = /^([A-Z])(\d{2,4})\.([A-Za-z0-9_]+)\.(.+)$/;

/** Classify a raw fqdn string: 'short' | 'canonical-code' | 'canonical-doc'. */
export function classify(fqdn) {
  if (SHORT_RE.test(fqdn)) return 'short';
  if (fqdn.includes('#')) return 'canonical-code';
  return 'canonical-doc';
}

/** Parse a canonical-code fqdn into { relpath, symbol }. */
export function parseCanonicalCode(fqdn) {
  const i = fqdn.lastIndexOf('#');
  if (i === -1) return null;
  return { relpath: fqdn.slice(0, i), symbol: fqdn.slice(i + 1) };
}

/** Parse a short-form fqdn into { bucket, slot, module, symbol }. */
export function parseShort(fqdn) {
  const m = SHORT_RE.exec(fqdn);
  if (!m) return null;
  return { bucket: m[1], slot: Number(m[2]), module: m[3], symbol: m[4] };
}

/** Last path segment of a module dir, used as the short-form module token. */
export function moduleToken(relpath) {
  const noFile = relpath.replace(/\/[^/]+$/, '');     // strip filename
  const seg = noFile.split('/').filter(Boolean).pop() || 'root';
  return seg.replace(/[^A-Za-z0-9_]/g, '');
}

/** Build the canonical-code fqdn for a code symbol. */
export function canonicalCode(relpath, symbol) {
  return `${relpath}#${symbol}`;
}

/** Doc slug from a markdown path: docs/<area>/<slug>.md -> { area, slug }. */
export function docParts(relpath) {
  const m = /^docs\/(?:(.+)\/)?([^/]+)\.md$/i.exec(relpath);
  if (!m) return null;
  return { area: (m[1] || 'root').replace(/\//g, '-'), slug: m[2] };
}
