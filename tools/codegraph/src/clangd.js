// clangd.js — minimal LSP stdio client tuned for code-intelligence queries.
//
// Why hand-rolled instead of an LSP library: we need exactly five operations
// (definition, references, document symbols, call hierarchy in/out, workspace
// symbol) plus one thing no generic client surfaces well — a FRESHNESS signal.
// clangd's background indexer emits work-done progress; we latch onto it so a
// caller can await "index is idle" before trusting a blast-radius answer. That
// freshness guard is the whole reason this wrapper exists (clangd alone returns
// confidently-stale results right after a bulk change — see the OES 854-file
// merge probe).

import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export class Clangd {
  /**
   * @param {object} opts
   * @param {string} opts.root           absolute repo root
   * @param {string} opts.compileDir     dir containing compile_commands.json
   * @param {string} [opts.bin]          clangd binary
   */
  constructor({ root, compileDir, bin = 'clangd' }) {
    this.root = root;
    this.compileDir = compileDir;
    this.bin = bin;
    this.proc = null;
    this.seq = 0;
    this.pending = new Map();      // id -> {resolve, reject}
    this.opened = new Set();       // file URIs we've didOpen'd
    this.buf = Buffer.alloc(0);
    // Freshness: clangd reports background-index progress via $/progress.
    // We treat "no active indexing token" as idle. Starts busy until the
    // first idle is observed after initialize.
    this._activeProgress = new Set();
    this._idleWaiters = [];
    this._everIdle = false;
  }

  start() {
    this.proc = spawn(this.bin, [
      `--compile-commands-dir=${this.compileDir}`,
      '--background-index',
      '--pch-storage=memory',
      '--log=error',
      '-j=2',
    ], { cwd: this.root });

    this.proc.stdout.on('data', (d) => this._onData(d));
    this.proc.stderr.on('data', () => {}); // clangd logs are noisy; ignore
    this.proc.on('exit', (code) => {
      for (const { reject } of this.pending.values())
        reject(new Error(`clangd exited (${code})`));
      this.pending.clear();
    });

    return this._request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(this.root).href,
      capabilities: {
        textDocument: {
          callHierarchy: { dynamicRegistration: false },
          references: {}, definition: {}, documentSymbol: {},
        },
        workspace: { symbol: {} },
        window: { workDoneProgress: true },
      },
    }).then(() => {
      this._notify('initialized', {});
    });
  }

  stop() { try { this.proc?.kill(); } catch { /* noop */ } }

  // ---- framing ------------------------------------------------------------

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buf.slice(0, headerEnd).toString('ascii');
      const m = /content-length:\s*(\d+)/i.exec(header);
      if (!m) { this.buf = this.buf.slice(headerEnd + 4); continue; }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (this.buf.length < start + len) return; // wait for the rest
      const body = this.buf.slice(start, start + len).toString('utf8');
      this.buf = this.buf.slice(start + len);
      try { this._dispatch(JSON.parse(body)); } catch { /* skip malformed */ }
    }
  }

  _send(msg) {
    const s = JSON.stringify(msg);
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
  }

  _request(method, params) {
    const id = ++this.seq;
    this._send({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  _notify(method, params) { this._send({ jsonrpc: '2.0', method, params }); }

  _dispatch(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'LSP error'));
      else p.resolve(msg.result);
      return;
    }
    // Server -> client requests/notifications
    if (msg.method === 'window/workDoneProgress/create') {
      this._send({ jsonrpc: '2.0', id: msg.id, result: null });
      return;
    }
    if (msg.method === '$/progress') this._onProgress(msg.params);
    // Other server requests we must answer to keep clangd happy:
    else if (msg.id !== undefined) this._send({ jsonrpc: '2.0', id: msg.id, result: null });
  }

  _onProgress({ token, value }) {
    if (!value) return;
    if (value.kind === 'begin') this._activeProgress.add(token);
    else if (value.kind === 'end') {
      this._activeProgress.delete(token);
      if (this._activeProgress.size === 0) {
        this._everIdle = true;
        const waiters = this._idleWaiters; this._idleWaiters = [];
        for (const w of waiters) w();
      }
    }
  }

  /**
   * Resolve once background indexing is idle. This is the freshness guard.
   * @param {number} timeoutMs
   */
  awaitIndexed(timeoutMs = 60000) {
    if (this._everIdle && this._activeProgress.size === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      this._idleWaiters.push(() => { clearTimeout(t); resolve(true); });
    });
  }

  // ---- documents ----------------------------------------------------------

  _uri(file) {
    const abs = path.isAbsolute(file) ? file : path.join(this.root, file);
    return pathToFileURL(abs).href;
  }

  ensureOpen(file) {
    const uri = this._uri(file);
    if (this.opened.has(uri)) return;
    const abs = fileURLToPath(uri);
    let text = '';
    try { text = readFileSync(abs, 'utf8'); } catch { return; }
    const ext = path.extname(abs);
    const languageId = (ext === '.c') ? 'c' : 'cpp';
    this._notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    });
    this.opened.add(uri);
  }

  // ---- operations (line/character are 0-based LSP positions) --------------

  async definition(file, line, character) {
    this.ensureOpen(file);
    const r = await this._request('textDocument/definition', {
      textDocument: { uri: this._uri(file) }, position: { line, character },
    });
    return normalizeLocations(r, this.root);
  }

  async references(file, line, character, includeDeclaration = true) {
    this.ensureOpen(file);
    const r = await this._request('textDocument/references', {
      textDocument: { uri: this._uri(file) }, position: { line, character },
      context: { includeDeclaration },
    });
    return normalizeLocations(r, this.root);
  }

  async documentSymbols(file) {
    this.ensureOpen(file);
    const r = await this._request('textDocument/documentSymbol', {
      textDocument: { uri: this._uri(file) },
    });
    return r || [];
  }

  async workspaceSymbol(query) {
    const r = await this._request('workspace/symbol', { query });
    return (r || []).map((s) => ({
      name: s.name,
      kind: s.kind,
      container: s.containerName || '',
      ...locFromLspLocation(s.location, this.root),
    }));
  }

  async _prepareCallHierarchy(file, line, character) {
    this.ensureOpen(file);
    const r = await this._request('textDocument/prepareCallHierarchy', {
      textDocument: { uri: this._uri(file) }, position: { line, character },
    });
    return (r && r[0]) || null;
  }

  async incomingCalls(file, line, character) {
    const item = await this._prepareCallHierarchy(file, line, character);
    if (!item) return [];
    const r = await this._request('callHierarchy/incomingCalls', { item });
    return (r || []).map((c) => ({
      name: c.from.name,
      kind: c.from.kind,
      ...locFromLspLocation({ uri: c.from.uri, range: c.from.selectionRange }, this.root),
      callSites: (c.fromRanges || []).map((rg) => rg.start.line + 1),
    }));
  }

  async outgoingCalls(file, line, character) {
    const item = await this._prepareCallHierarchy(file, line, character);
    if (!item) return [];
    const r = await this._request('callHierarchy/outgoingCalls', { item });
    return (r || []).map((c) => ({
      name: c.to.name,
      kind: c.to.kind,
      ...locFromLspLocation({ uri: c.to.uri, range: c.to.selectionRange }, this.root),
    }));
  }
}

// ---- helpers --------------------------------------------------------------

function relUri(uri, root) {
  try {
    const abs = fileURLToPath(uri);
    return path.relative(root, abs);
  } catch { return uri; }
}

function locFromLspLocation(loc, root) {
  if (!loc) return { file: null, line: null, character: null };
  return {
    file: relUri(loc.uri, root),
    line: (loc.range?.start?.line ?? 0) + 1,        // expose 1-based
    character: (loc.range?.start?.character ?? 0) + 1,
  };
}

function normalizeLocations(result, root) {
  if (!result) return [];
  const arr = Array.isArray(result) ? result : [result];
  return arr.map((loc) => {
    // LocationLink has targetUri/targetSelectionRange; Location has uri/range
    const uri = loc.uri || loc.targetUri;
    const range = loc.range || loc.targetSelectionRange || loc.targetRange;
    return locFromLspLocation({ uri, range }, root);
  });
}
