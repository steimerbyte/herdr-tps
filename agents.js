// Active agents (agent_start -> agent_end), the status line, and the single-writer
// election shared by every OMP extension instance (one instance per session).
const fs = require('node:fs');

const STALE_MS = 10_000;

// entries: {path, ts}[] collected from every fresh reporter file. The same agent
// reported twice is one agent; malformed entries are ignored.
function countActive(entries, nowMs, staleMs = STALE_MS) {
  if (!Array.isArray(entries)) return 0;
  const from = nowMs - staleMs;
  const active = new Set();
  for (const entry of entries) {
    const file = entry?.path;
    const ts = entry?.ts;
    if (typeof file !== 'string' || file === '') continue;
    if (!Number.isFinite(ts) || ts < from) continue;
    active.add(file);
  }
  return active.size;
}

// Parsed reporter files ({ts, active:[path]}) -> countActive input. A reporter whose
// file timestamp is stale belongs to a session that ended without cleanup.
function reporterEntries(reports, nowMs, staleMs = STALE_MS) {
  const from = nowMs - staleMs;
  const entries = [];
  for (const report of reports) {
    if (!Number.isFinite(report?.ts) || report.ts < from) continue;
    for (const file of report.active ?? []) entries.push({ path: file, ts: report.ts });
  }
  return entries;
}

// An agent is active when it produced output inside the window or its agent_start is
// still open. Distinct paths only: a burst and an open run of the same session is one.
function countAgents(openPaths, outputEntries, nowMs, windowMs) {
  const from = nowMs - windowMs;
  const active = new Set();
  if (Array.isArray(openPaths)) {
    for (const file of openPaths) {
      if (typeof file === 'string' && file !== '') active.add(file);
    }
  }
  if (Array.isArray(outputEntries)) {
    for (const entry of outputEntries) {
      const file = entry?.path;
      const ts = entry?.ts;
      if (typeof file !== 'string' || file === '') continue;
      if (!Number.isFinite(ts) || ts < from) continue;
      active.add(file);
    }
  }
  return active.size;
}

function whole(value) {
  return Math.round(Number.isFinite(value) ? value : 0);
}

// Rates are already per second. The count is always shown, so 0 is visible too.
function formatStatus(outputPerSec, reasoningPerSec, agents) {
  const reasoning = whole(reasoningPerSec);
  const active = Math.max(whole(agents), 0);
  const reasoningPart = reasoning > 0 ? ` (${reasoning} rsn/s)` : '';
  return `${whole(outputPerSec)} tok/s${reasoningPart} · ${active} ${active === 1 ? 'Agent' : 'Agenten'}`;
}

function readLock(lockFile) {
  try {
    return JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  } catch {
    return null;
  }
}

function lockAge(lockFile, nowMs) {
  try {
    return nowMs - fs.statSync(lockFile).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY; // vanished: claimable
  }
}

// 'wx' creation is the atomic part. A lock with a stale ts (or an unreadable lock
// older than staleMs) belongs to a dead writer; an unreadable but fresh lock is
// most likely mid-creation and gets the next tick to finish.
function claimLock(lockFile, owner, nowMs, staleMs = STALE_MS) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify(owner));
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (err) {
      if (err?.code !== 'EEXIST') return false;
      const held = readLock(lockFile);
      const ts = Number(held?.ts);
      const fresh = Number.isFinite(ts) ? ts >= nowMs - staleMs : lockAge(lockFile, nowMs) < staleMs;
      if (fresh) return false;
      try {
        fs.unlinkSync(lockFile);
      } catch {
        // Someone else unlinked it first: the next 'wx' shows who won.
      }
    }
  }
  return false;
}

function ownsLock(lockFile, pid, session) {
  const held = readLock(lockFile);
  return held?.pid === pid && held?.session === session;
}

function releaseLock(lockFile, pid, session) {
  if (!ownsLock(lockFile, pid, session)) return;
  try {
    fs.unlinkSync(lockFile);
  } catch {
    // Already gone.
  }
}

// The lock is the only signal: a released lock is taken over on the next tick,
// even while the state tick is still fresh.
function electWriter({ lockFile, owner, nowMs, staleMs = STALE_MS }) {
  return claimLock(lockFile, { ...owner, ts: nowMs }, nowMs, staleMs);
}

module.exports = {
  STALE_MS,
  countActive,
  reporterEntries,
  countAgents,
  formatStatus,
  claimLock,
  ownsLock,
  releaseLock,
  electWriter,
};
