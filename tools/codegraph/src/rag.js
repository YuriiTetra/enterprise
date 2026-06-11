// rag.js — graph-augmented retrieval. Vector finds the entry point; code-graph
// edges give the surrounding neighbourhood. Three tiers:
//   T1 atom     — cosine over symbol embeddings (the hit)
//   T2 parent   — enclosing class/namespace + Glova docs for context
//   T3 graph    — neighbours via containment/include edges (and, on request,
//                 live clangd callers for a truly fresh blast neighbourhood)

import { blobToVec, cosine } from './db.js';
import { embed } from './embeddings.js';

export async function search(db, query, { topK = 8, perHitNeighbors = 5 } = {}) {
  const qv = await embed(query);

  // T1 — atoms
  const atoms = db.allAtomsWithEmbedding();
  const scoredA = atoms.map((a) => ({ a, score: cosine(qv, blobToVec(a.embedding)) }))
    .sort((x, y) => y.score - x.score).slice(0, topK);

  // docs (parallel channel)
  const docs = db.allDocsWithEmbedding();
  const scoredD = docs.map((d) => ({ d, score: cosine(qv, blobToVec(d.embedding)) }))
    .sort((x, y) => y.score - x.score).slice(0, Math.ceil(topK / 2));

  const hits = scoredA.map(({ a, score }) => {
    // T3 — neighbours via persisted edges
    const neigh = db.neighbors(a.id).slice(0, perHitNeighbors).map((n) => {
      const o = db.atomById(n.other);
      return o ? { fqdn: o.fqdn, short: o.short, name: o.name, edge: n.kind } : null;
    }).filter(Boolean);
    // T2 — Glova docs linked to this atom
    const linkedDocs = db.docsForAtom(a.id).slice(0, 3).map((d) => ({ fqdn: d.fqdn, title: d.title }));
    return {
      fqdn: a.fqdn, short: a.short, symbol: a.symbol, kind: a.kind,
      location: `${a.relpath}:${a.line}`, summary: a.summary || null,
      score: round(score), neighbors: neigh, docs: linkedDocs,
    };
  });

  return {
    query,
    symbols: hits,
    docs: scoredD.map(({ d, score }) => ({ fqdn: d.fqdn, title: d.title, score: round(score) })),
  };
}

function round(x) { return Math.round(x * 1000) / 1000; }
