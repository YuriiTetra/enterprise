// db.js — sqlite store. The index is a CACHE, never the source of truth:
// deleting the file and re-running `index` reconstructs everything from disk.

import Database from 'better-sqlite3';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- One row per indexed symbol (code) — the "atom".
CREATE TABLE IF NOT EXISTS atoms (
  id         INTEGER PRIMARY KEY,
  fqdn       TEXT UNIQUE NOT NULL,   -- canonical:  relpath#symbol
  short      TEXT,                   -- short:      O100.module.symbol
  relpath    TEXT NOT NULL,
  symbol     TEXT NOT NULL,          -- qualified name
  name       TEXT NOT NULL,          -- bare name (last ::segment)
  kind       INTEGER,                -- LSP SymbolKind
  line       INTEGER,                -- 1-based decl line
  character  INTEGER,
  parent_id  INTEGER,               -- enclosing atom (class/namespace)
  summary    TEXT,
  embedding  BLOB,                   -- Float32 vector
  hash       TEXT                    -- source content hash (for incremental)
);
CREATE INDEX IF NOT EXISTS idx_atoms_relpath ON atoms(relpath);
CREATE INDEX IF NOT EXISTS idx_atoms_name    ON atoms(name);
CREATE INDEX IF NOT EXISTS idx_atoms_short   ON atoms(short);

-- Code-graph edges between atoms (calls / includes / inherits / references).
CREATE TABLE IF NOT EXISTS edges (
  src  INTEGER NOT NULL,
  dst  INTEGER NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (src, dst, kind)
);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);

-- Docs (markdown) — the Glova corpus.
CREATE TABLE IF NOT EXISTS docs (
  id        INTEGER PRIMARY KEY,
  fqdn      TEXT UNIQUE NOT NULL,    -- canonical: relpath
  short     TEXT,
  relpath   TEXT NOT NULL,
  title     TEXT,
  embedding BLOB,
  hash      TEXT
);

-- Glova links: a doc references a code atom (by FQDN mention or symbol name).
CREATE TABLE IF NOT EXISTS doc_links (
  doc_id  INTEGER NOT NULL,
  atom_id INTEGER NOT NULL,
  reason  TEXT,                       -- 'fqdn' | 'symbol-mention'
  PRIMARY KEY (doc_id, atom_id)
);

-- FQDN aliases (old -> new) for a grace period after a rename / re-bucket.
CREATE TABLE IF NOT EXISTS aliases (
  old_fqdn TEXT PRIMARY KEY,
  new_fqdn TEXT NOT NULL
);
`;

export class Db {
  constructor(file) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close() { this.db.close(); }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, String(value));
  }
  getMeta(key) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value; }

  upsertAtom(a) {
    return this.db.prepare(`
      INSERT INTO atoms(fqdn,short,relpath,symbol,name,kind,line,character,parent_id,summary,embedding,hash)
      VALUES(@fqdn,@short,@relpath,@symbol,@name,@kind,@line,@character,@parent_id,@summary,@embedding,@hash)
      ON CONFLICT(fqdn) DO UPDATE SET
        short=excluded.short, relpath=excluded.relpath, symbol=excluded.symbol, name=excluded.name,
        kind=excluded.kind, line=excluded.line, character=excluded.character, parent_id=excluded.parent_id,
        summary=excluded.summary, embedding=excluded.embedding, hash=excluded.hash
      RETURNING id`).get(a).id;
  }

  atomByFqdn(fqdn) { return this.db.prepare('SELECT * FROM atoms WHERE fqdn=?').get(fqdn); }
  atomById(id) { return this.db.prepare('SELECT * FROM atoms WHERE id=?').get(id); }
  atomsByShort(short) { return this.db.prepare('SELECT * FROM atoms WHERE short=?').all(short); }
  atomsByName(name) { return this.db.prepare('SELECT * FROM atoms WHERE name=?').all(name); }
  atomsInFile(relpath) { return this.db.prepare('SELECT * FROM atoms WHERE relpath=?').all(relpath); }
  allAtomsWithEmbedding() {
    return this.db.prepare('SELECT id,fqdn,short,relpath,symbol,name,kind,line,summary,embedding FROM atoms WHERE embedding IS NOT NULL').all();
  }
  deleteAtomsInFile(relpath) { this.db.prepare('DELETE FROM atoms WHERE relpath=?').run(relpath); }

  addEdge(src, dst, kind) {
    this.db.prepare('INSERT OR IGNORE INTO edges(src,dst,kind) VALUES(?,?,?)').run(src, dst, kind);
  }
  incomingEdges(dst) { return this.db.prepare('SELECT * FROM edges WHERE dst=?').all(dst); }
  outgoingEdges(src) { return this.db.prepare('SELECT * FROM edges WHERE src=?').all(src); }
  neighbors(id) {
    return this.db.prepare(
      'SELECT dst AS other, kind FROM edges WHERE src=? UNION SELECT src AS other, kind FROM edges WHERE dst=?'
    ).all(id, id);
  }

  upsertDoc(d) {
    return this.db.prepare(`
      INSERT INTO docs(fqdn,short,relpath,title,embedding,hash)
      VALUES(@fqdn,@short,@relpath,@title,@embedding,@hash)
      ON CONFLICT(fqdn) DO UPDATE SET short=excluded.short, title=excluded.title,
        embedding=excluded.embedding, hash=excluded.hash
      RETURNING id`).get(d).id;
  }
  allDocsWithEmbedding() {
    return this.db.prepare('SELECT id,fqdn,short,relpath,title,embedding FROM docs WHERE embedding IS NOT NULL').all();
  }
  addDocLink(docId, atomId, reason) {
    this.db.prepare('INSERT OR IGNORE INTO doc_links(doc_id,atom_id,reason) VALUES(?,?,?)').run(docId, atomId, reason);
  }
  docsForAtom(atomId) {
    return this.db.prepare(
      'SELECT d.* FROM docs d JOIN doc_links l ON l.doc_id=d.id WHERE l.atom_id=?'
    ).all(atomId);
  }

  addAlias(oldF, newF) {
    this.db.prepare('INSERT OR REPLACE INTO aliases(old_fqdn,new_fqdn) VALUES(?,?)').run(oldF, newF);
  }
  resolveAlias(fqdn) { return this.db.prepare('SELECT new_fqdn FROM aliases WHERE old_fqdn=?').get(fqdn)?.new_fqdn; }
}

// ---- vector helpers (Float32 blob <-> array, cosine) ----------------------

export function vecToBlob(arr) { return Buffer.from(new Float32Array(arr).buffer); }
export function blobToVec(buf) {
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}
