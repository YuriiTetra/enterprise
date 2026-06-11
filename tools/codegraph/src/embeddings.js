// embeddings.js — local sentence embeddings via transformers.js (ONNX).
//
// Model is fetched once into the HF cache, then runs fully offline. No torch,
// no network at query time. all-MiniLM-L6-v2: 384-dim, small, good enough for
// concept->symbol retrieval over terse C++ identifiers (we feed it the symbol
// name + signature + doc comment, not the raw mangled identifier alone).

import { pipeline, env } from '@huggingface/transformers';

// Keep everything on-disk + local. allowRemoteModels stays true only so the
// first run can populate the cache; set OES_CG_OFFLINE=1 to hard-forbid network.
if (process.env.OES_CG_OFFLINE === '1') env.allowRemoteModels = false;

const MODEL = process.env.OES_CG_MODEL || 'Xenova/all-MiniLM-L6-v2';

let _pipe = null;
export async function embedder() {
  if (!_pipe) _pipe = await pipeline('feature-extraction', MODEL);
  return _pipe;
}

/** Embed one string -> Float32 array (mean-pooled, L2-normalized). */
export async function embed(text) {
  const pipe = await embedder();
  const out = await pipe(text || ' ', { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

/** Embed many strings sequentially (transformers.js batches poorly under node). */
export async function embedMany(texts, onProgress) {
  const pipe = await embedder();
  const vecs = [];
  for (let i = 0; i < texts.length; i++) {
    const out = await pipe(texts[i] || ' ', { pooling: 'mean', normalize: true });
    vecs.push(Array.from(out.data));
    if (onProgress && (i % 50 === 0)) onProgress(i, texts.length);
  }
  return vecs;
}
