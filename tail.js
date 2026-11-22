const fs = require('node:fs');
const path = require('node:path');

const SCAN_BYTES = 262144;
const MAX_SCAN_BYTES = 8 << 20;
const CHUNK_BYTES = 1 << 20;
// Deliberate compromise: watch events carry the load; a full directory reconcile every minute
// catches dropped events and renames. One poll per minute may be expensive, the rest are free.
const RECONCILE_MS = 60_000;
// Sessions live at <root>/<slug>/<name>.jsonl and <root>/<slug>/<ISO>_<uuid>/<name>.jsonl.
// Everything else under the root (blobs/, local/, changes.jsonl) is not a session transcript.
const SESSION_DIR = /^\d{4}-\d\d-\d\dT/;
const SKIP_DIRS = new Set(['blobs', 'local']);

// Syscall/byte counters for the resource proof (see MESSUNG.md). Cheap to maintain.
const stats = { readdir: 0, stat: 0, open: 0, close: 0, read: 0, bytes: 0, polls: 0, pollMs: 0, fullScans: 0 };

// Records are either {type:"message", message:{usage}} or {type:"model_usage", usage}.
function parseUsage(line) {
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  const usage = rec?.usage ?? rec?.message?.usage;
  const output = usage?.output;
  const tsMs = typeof rec?.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
  if (!Number.isFinite(output) || !Number.isFinite(tsMs)) return null;
  const reasoning = usage?.reasoningTokens;
  return {
    output,
    // Subset of output, reported separately: never added to it.
    reasoningTokens: Number.isFinite(reasoning) ? reasoning : 0,
    tsMs,
    key: rec.id == null ? null : `${rec.id}@${rec.timestamp}`,
  };
}

function isTranscript(name) {
  return name.endsWith('.jsonl') && name !== 'changes.jsonl';
}

// Same selection as the directory walk, applied to a watch path relative to the root.
function isSessionPath(rel) {
  const parts = rel.split(path.sep);
  if (!isTranscript(parts[parts.length - 1])) return false;
  return parts.length === 2 || (parts.length === 3 && SESSION_DIR.test(parts[1]));
}

// Line start right after the newest record older than fromMs, or 0.
// shortcut: the backward scan stops after 8 MB; such a hot file is read from byte 0 instead.
function findStartOffset(fd, size, fromMs) {
  let head = size; // absolute position of buf[0]
  let buf = Buffer.alloc(0);
  while (head > 0 && size - head < MAX_SCAN_BYTES) {
    const len = Math.min(SCAN_BYTES, head);
    const part = Buffer.allocUnsafe(len);
    stats.read += 1; stats.bytes += len;
    const n = fs.readSync(fd, part, 0, len, head - len);
    if (n !== len) return 0; // file changed under us: read it all
    buf = Buffer.concat([part, buf]);
    head -= len;

    let start = 0;
    if (head > 0) {
      const nl = buf.indexOf(10);
      if (nl === -1) continue; // chunk holds no line start yet
      start = nl + 1; // first complete line
    }
    let offset = null;
    for (let pos = start; pos < buf.length; ) {
      const nl = buf.indexOf(10, pos);
      if (nl === -1) break;
      const rec = parseUsage(buf.toString('utf8', pos, nl));
      if (rec && rec.tsMs < fromMs) offset = head + nl + 1;
      pos = nl + 1;
    }
    if (offset !== null) return offset;
  }
  if (head > 0) stats.fullScans += 1; // 8 MB cap hit: the caller falls back to reading from 0
  return 0;
}

function createTailer({ root, windowMs, onRecord }) {
  const files = new Map(); // path -> {offset, partial}
  const seen = new Map(); // id@timestamp -> tsMs, so one record never counts twice
  const dirs = new Map(); // dir -> {mtimeMs, entries}; unchanged dirs are not re-listed
  const dirty = new Set(); // paths named by a watch event since the last poll
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  let watcher = null;
  let noWatch = false; // no recursive watch here: every poll reconciles, like the old tailer
  let rescan = true;
  let lastScan = -Infinity;

  function consume(file, buf) {
    const state = files.get(file);
    const data = state.partial.length ? Buffer.concat([state.partial, buf]) : buf;
    let start = 0;
    for (;;) {
      const nl = data.indexOf(10, start);
      if (nl === -1) break;
      const rec = parseUsage(data.toString('utf8', start, nl));
      start = nl + 1;
      if (!rec) continue;
      if (rec.key !== null) {
        if (seen.has(rec.key)) continue;
        seen.set(rec.key, rec.tsMs);
      }
      onRecord({ output: rec.output, reasoningTokens: rec.reasoningTokens, tsMs: rec.tsMs, file });
    }
    state.partial = Buffer.from(data.subarray(start));
  }

  // Reads from state.offset up to file end (or `limit` bytes on a first sighting).
  function readFrom(fd, file, limit) {
    const state = files.get(file);
    let total = 0;
    while (total < limit) {
      stats.read += 1;
      const n = fs.readSync(fd, chunk, 0, Math.min(CHUNK_BYTES, limit - total), state.offset);
      stats.bytes += Math.max(n, 0);
      if (n <= 0) break;
      state.offset += n;
      total += n;
      consume(file, chunk.subarray(0, n));
    }
    return total;
  }

  function readFile(file, nowMs) {
    let state = files.get(file);
    if (!state) {
      stats.stat += 1;
      const st = fs.statSync(file);
      // mtime before the window start => the file cannot hold a record inside the window.
      if (st.mtimeMs < nowMs - windowMs) return;

      stats.open += 1;
      const fd = fs.openSync(file, 'r');
      try {
        state = { offset: findStartOffset(fd, st.size, nowMs - windowMs), partial: Buffer.alloc(0) };
        files.set(file, state);
        readFrom(fd, file, st.size);
      } finally {
        stats.close += 1;
        fs.closeSync(fd);
      }
      return;
    }

    // Known file: the watch event already proves it changed, so no stat unless the read hits
    // EOF at a nonzero offset — the only way to tell an unchanged file from a truncated one.
    stats.open += 1;
    const fd = fs.openSync(file, 'r');
    try {
      if (readFrom(fd, file, Infinity) > 0 || state.offset === 0) return;
      stats.stat += 1;
      const st = fs.fstatSync(fd);
      if (st.size >= state.offset) return;
      // Truncated / restarted: re-read from 0; the dedupe set keeps old records from counting twice.
      state.offset = 0;
      state.partial = Buffer.alloc(0);
      readFrom(fd, file, st.size);
    } finally {
      stats.close += 1;
      fs.closeSync(fd);
    }
  }

  function onEvent(_eventType, rel) {
    if (typeof rel !== 'string') {
      rescan = true;
      return;
    }
    if (isSessionPath(rel)) {
      dirty.add(path.join(root, rel));
      return;
    }
    // changes.jsonl, logs, blobs: irrelevant unless the path is a directory (rename/create/delete).
    // Not counted in stats: this classifies events, it is not poll work.
    try {
      if (fs.statSync(path.join(root, rel)).isDirectory()) rescan = true;
    } catch {
      rescan = true; // vanished: may have been a directory holding tracked files
    }
  }

  function ensureWatch() {
    if (watcher || noWatch) return;
    try {
      const w = fs.watch(root, { recursive: true }, onEvent);
      w.unref();
      w.on('error', () => {
        try { w.close(); } catch { /* already gone */ }
        watcher = null;
        noWatch = true;
        rescan = true;
      });
      watcher = w;
    } catch {
      noWatch = true; // fall back to a full scan per poll
    }
  }

  // Lists a directory, re-reading only when its mtime changed. Marks every freshly listed dir.
  function listDir(dir, fresh) {
    stats.stat += 1;
    const st = fs.statSync(dir); // throws when the root is gone
    const cached = dirs.get(dir);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.entries;
    stats.readdir += 1;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    dirs.set(dir, { mtimeMs: st.mtimeMs, entries });
    fresh.add(dir);
    return entries;
  }

  function reconcile(nowMs) {
    const fresh = new Set();
    const found = new Set();
    // 0 = root (slugs), 1 = slug (files + session dirs), 2 = session dir (files only).
    const walk = (dir, level) => {
      const entries = listDir(dir, fresh);
      const changed = fresh.has(dir);
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (level > 1) continue; // deeper than <slug>/<session>/ is not a transcript dir
          if (level === 1 && (SKIP_DIRS.has(entry.name) || !SESSION_DIR.test(entry.name))) continue;
          walk(path.join(dir, entry.name), level + 1);
        } else if (level > 0 && changed && entry.isFile() && isTranscript(entry.name)) {
          found.add(path.join(dir, entry.name));
        }
      }
    };
    walk(root, 0);
    // Files from unchanged dirs are only worth a look when already tracked.
    for (const file of files.keys()) found.add(file);
    for (const file of found) {
      try {
        readFile(file, nowMs);
      } catch {
        // Transient (locked, vanished): the next tick retries.
      }
    }
  }

  // Returns false when the sessions root cannot be read; never throws.
  return {
    poll(nowMs) {
      const t0 = process.hrtime.bigint();
      ensureWatch();
      if (noWatch) rescan = true;
      if (rescan || nowMs - lastScan >= RECONCILE_MS) {
        try {
          reconcile(nowMs);
        } catch {
          return false;
        }
        rescan = false;
        lastScan = nowMs;
      }
      for (const file of dirty) {
        dirty.delete(file);
        try {
          readFile(file, nowMs);
        } catch {
          // Transient (locked, vanished): the next tick retries.
        }
      }
      const from = nowMs - windowMs;
      for (const [key, tsMs] of seen) if (tsMs < from) seen.delete(key);
      stats.polls += 1;
      stats.pollMs += Number(process.hrtime.bigint() - t0) / 1e6;
      return true;
    },
  };
}

module.exports = { createTailer, parseUsage, stats };
