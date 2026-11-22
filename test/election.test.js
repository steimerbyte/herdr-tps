const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { claimLock, ownsLock, releaseLock, electWriter } = require('../agents.js');

function files(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-tps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { state: path.join(dir, 'tps'), lock: path.join(dir, 'writer.lock') };
}

const election = (lock, pid, session, nowMs) => ({
  lockFile: lock,
  owner: { pid, pane: 'pane', session },
  nowMs,
});

test('first openSync(wx) wins, a second instance loses while the lock is fresh', (t) => {
  const { lock } = files(t);
  const now = Date.now();
  assert.equal(electWriter(election(lock, 1, 'root', now)), true);
  assert.equal(electWriter(election(lock, 2, 'sub', now + 1000)), false);
  assert.equal(ownsLock(lock, 1, 'root'), true);
  assert.equal(ownsLock(lock, 2, 'sub'), false);
});

test('a released lock is taken over immediately even with a fresh state tick', (t) => {
  const { state, lock } = files(t);
  const now = Date.now();
  // The writer shut down cleanly: tick still fresh, lock gone.
  fs.writeFileSync(state, `412 tok/s (199 rsn/s) · 1 Agent\n${now}\n`);
  assert.equal(electWriter(election(lock, 2, 'sub', now)), true);
  assert.equal(ownsLock(lock, 2, 'sub'), true);
});

test('a stale lock is taken over', (t) => {
  const { lock } = files(t);
  const now = Date.now();
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, pane: 'pane', session: 'root', ts: now - 20_000 }));
  assert.equal(electWriter(election(lock, 2, 'sub', now)), true);
  assert.equal(ownsLock(lock, 2, 'sub'), true);
  assert.equal(ownsLock(lock, 1, 'root'), false);
});

test('a fresh lock blocks takeover even when its ts is missing', (t) => {
  const { lock } = files(t);
  const now = Date.now();
  fs.writeFileSync(lock, '{"pid":1,"pane":"pane","session":"root"}');
  assert.equal(electWriter(election(lock, 2, 'sub', now)), false);
});

test('an unreadable lock is not stolen while mid-creation, but is after 10 s', (t) => {
  const { lock } = files(t);
  const now = Date.now();
  fs.writeFileSync(lock, 'not json');
  assert.equal(claimLock(lock, { pid: 2, pane: 'pane', session: 'sub', ts: now }, now), false);

  fs.utimesSync(lock, new Date(now - 20_000), new Date(now - 20_000));
  assert.equal(claimLock(lock, { pid: 2, pane: 'pane', session: 'sub', ts: now }, now), true);
  assert.equal(ownsLock(lock, 2, 'sub'), true);
});

test('claimLock retries once after unlinking a stale lock and refuses a foreign fresh one', (t) => {
  const { lock } = files(t);
  const now = Date.now();
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, pane: 'pane', session: 'root', ts: now - 30_000 }));
  assert.equal(claimLock(lock, { pid: 2, pane: 'pane', session: 'sub', ts: now }, now), true);

  fs.writeFileSync(lock, JSON.stringify({ pid: 3, pane: 'pane', session: 'root', ts: now }));
  assert.equal(claimLock(lock, { pid: 4, pane: 'pane', session: 'sub', ts: now }, now), false);
  assert.equal(ownsLock(lock, 3, 'root'), true);
});

test('a missing lock is claimable; release only touches the own pid and session', (t) => {
  const { lock } = files(t);
  const now = Date.now();
  assert.equal(electWriter(election(lock, 5, 'root', now)), true);

  releaseLock(lock, 6, 'root'); // wrong pid
  assert.equal(ownsLock(lock, 5, 'root'), true);
  releaseLock(lock, 5, 'sub'); // wrong session
  assert.equal(ownsLock(lock, 5, 'root'), true);
  releaseLock(lock, 5, 'root');
  assert.equal(ownsLock(lock, 5, 'root'), false);
});
