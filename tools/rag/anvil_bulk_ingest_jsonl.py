#!/usr/bin/env python3
"""
Bulk-ingest precomputed JSONL embeddings into Anvil KnowledgeChunk.

This is a safer variant of the historical BAS ingest script: document source is
explicitly configurable, so adding a new corpus cannot accidentally delete an
older BAS/OES corpus document.
"""
from __future__ import annotations

import json
import os
import sys
import time
import uuid
from pathlib import Path

import psycopg2
from psycopg2.extras import execute_values


PGHOST = os.environ.get("PGHOST", "localhost")
PGPORT = int(os.environ.get("PGPORT", "5433"))
PGUSER = os.environ.get("PGUSER", "codeforge")
PGPASSWORD = os.environ.get("PGPASSWORD", "")
PGDATABASE = os.environ.get("PGDATABASE", "cf_admin")
WORKSPACE = os.environ.get("WORKSPACE", "oes_ces")
DOC_SOURCE = os.environ.get("DOC_SOURCE", "bas-business-patterns-2026-05-23")
DOC_TITLE = os.environ.get("DOC_TITLE", "BAS business-pattern corpus for OES")
CORPUS = Path(os.environ.get("CORPUS", "var/rag/bas-business-corpus-with-embeddings-v2.jsonl"))
BATCH = int(os.environ.get("BATCH", "500"))
DRY_RUN = os.environ.get("DRY_RUN") == "1"


def vector_literal(vec: list[float]) -> str:
    return "[" + ",".join(f"{x:.6g}" for x in vec) + "]"


def load_rows() -> list[tuple[str, str, str]]:
    rows: list[tuple[str, str, str]] = []
    with CORPUS.open("r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, 1):
            rec = json.loads(line)
            emb = rec.get("embedding")
            if not isinstance(emb, list) or not emb:
                raise SystemExit(f"ERROR: no embedding at line {line_no}")
            content = rec.get("content", "")
            metadata = rec.get("metadata", {}) or {}
            metadata["source"] = rec.get("source", "")
            metadata["title"] = rec.get("title", "")
            metadata["workspace_id_source"] = rec.get("workspace_id", "")
            rows.append((content, vector_literal(emb), json.dumps(metadata, ensure_ascii=False)))
    return rows


def main() -> None:
    if not CORPUS.exists():
        raise SystemExit(f"ERROR: corpus not found: {CORPUS}")
    rows = load_rows()
    print(f"[plan] corpus={CORPUS} rows={len(rows)} workspace={WORKSPACE} doc_source={DOC_SOURCE}")
    if DRY_RUN:
        print("[dry-run] no database changes")
        return
    if not PGPASSWORD:
        raise SystemExit("ERROR: PGPASSWORD env required")

    conn = psycopg2.connect(
        host=PGHOST, port=PGPORT, user=PGUSER, password=PGPASSWORD, database=PGDATABASE
    )
    conn.autocommit = False
    cur = conn.cursor()

    cur.execute(
        'SELECT COUNT(*) FROM "KnowledgeChunk" WHERE workspace_id = %s',
        (WORKSPACE,),
    )
    print(f"[pre] existing chunks in {WORKSPACE}: {cur.fetchone()[0]}")

    cur.execute(
        'SELECT id FROM "KnowledgeDocument" WHERE workspace_id = %s AND source = %s',
        (WORKSPACE, DOC_SOURCE),
    )
    row = cur.fetchone()
    if row:
        doc_id = row[0]
        print(f"[doc] reuse {doc_id}")
    else:
        doc_id = str(uuid.uuid4())
        cur.execute(
            'INSERT INTO "KnowledgeDocument" (id, workspace_id, source, metadata) VALUES (%s, %s, %s, %s)',
            (
                doc_id,
                WORKSPACE,
                DOC_SOURCE,
                json.dumps({
                    "title": DOC_TITLE,
                    "corpus": str(CORPUS),
                    "embedder": "bge-m3",
                    "generated_at": "2026-05-23",
                }, ensure_ascii=False),
            ),
        )
        print(f"[doc] created {doc_id}")

    cur.execute('DELETE FROM "KnowledgeChunk" WHERE document_id = %s', (doc_id,))
    if cur.rowcount:
        print(f"[reset] deleted {cur.rowcount} old chunks for this document only")
    conn.commit()

    started = time.time()
    inserted = 0
    for start in range(0, len(rows), BATCH):
        batch = []
        for offset, (content, embedding, metadata) in enumerate(rows[start:start + BATCH]):
            batch.append((
                str(uuid.uuid4()),
                doc_id,
                WORKSPACE,
                start + offset,
                content,
                embedding,
                metadata,
            ))
        execute_values(
            cur,
            'INSERT INTO "KnowledgeChunk" (id, document_id, workspace_id, chunk_index, content, embedding, metadata) VALUES %s',
            batch,
            template="(%s, %s, %s, %s, %s, %s::vector, %s::jsonb)",
        )
        conn.commit()
        inserted += len(batch)
        print(f"[batch] {inserted}/{len(rows)}")

    cur.close()
    conn.close()
    print(f"[done] inserted {inserted} chunks in {time.time() - started:.1f}s")


if __name__ == "__main__":
    main()
