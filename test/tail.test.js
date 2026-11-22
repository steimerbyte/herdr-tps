const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTailer, parseUsage, stats } = require('../tail.js');
const { createWindow } = require('../window.js');

const here = __dirname;
const MIN = 60_000;
const T0 = Date.parse('2026-11-21T11:09:00.000Z');

function messageRecord(tsMs, output, id = `m-${tsMs}-${output}`, reasoningTokens) {
  const usage = { input: 0, output, cacheRead: 0, cacheWrite: 0 };
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens;
  return JSON.stringify({
    type: 'message',
    id,
    timestamp: new Date(tsMs).toISOString(),
    message: { role: 'assistant', usage },
  });
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(here, 'tmp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'slug'));
  return dir;
}

function harness(root, windowMs = MIN, opts = {}) {
  const win = createWindow(windowMs);
  const tailer = createTailer({
    root,
    windowMs,
    ...opts,
    onRecord: (r) => win.add(r.output, r.tsMs),
  });
  return { win, tailer };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Watch events arrive on a later tick, so event-driven pickup is checked by a bounded poll loop.
async function pollUntil(tailer, nowMs, done) {
  const deadline = Date.now() + 2000;
  for (;;) {
    tailer.poll(nowMs);
    if (done()) return;
    if (Date.now() >= deadline) return;
    await sleep(10);
  }
}

const counters = ['readdir', 'stat', 'open', 'close', 'read', 'bytes', 'fullScans'];
const snapshot = () => Object.fromEntries(counters.map((k) => [k, stats[k]]));
const delta = (a, b) => Object.fromEntries(counters.map((k) => [k, b[k] - a[k]]));

test('parseUsage reads both record kinds, keeps an identity key, rejects junk', () => {
  assert.deepEqual(parseUsage(messageRecord(T0, 42, 'abc')), {
    output: 42,
    reasoningTokens: 0,
    tsMs: T0,
    key: `abc@${new Date(T0).toISOString()}`,
  });
  assert.deepEqual(
    parseUsage(
      JSON.stringify({ type: 'model_usage', timestamp: new Date(T0).toISOString(), usage: { output: 7, reasoningTokens: 3 } }),
    ),
    { output: 7, reasoningTokens: 3, tsMs: T0, key: null },
  );
  assert.equal(parseUsage('{"type":"call"}'), null);
  assert.equal(parseUsage('not json'), null);
  assert.equal(parseUsage(JSON.stringify({ timestamp: 'nope', usage: { output: 1 } })), null);
});

test('a record without output is ignored, even when it carries totalTokens', () => {
  const oldMetric = JSON.stringify({ type: 'model_usage', timestamp: new Date(T0).toISOString(), usage: { totalTokens: 500 } });
  assert.equal(parseUsage(oldMetric), null);
});

test('reasoningTokens is reported separately, never added to output', (t) => {
  const dir = setup(t);
  const slug = path.join(dir, 'slug');
  let output = 0;
  let reasoning = 0;
  const tailer = createTailer({
    root: dir,
    windowMs: MIN,
    onRecord: ({ output: o, reasoningTokens: r, tsMs }) => {
      output += o;
      reasoning += r;
      assert.equal(tsMs, T0);
    },
  });
  fs.writeFileSync(path.join(slug, 'a.jsonl'), messageRecord(T0, 2500, 'r1', 1600) + '\n' + messageRecord(T0, 40, 'r2') + '\n');
  tailer.poll(T0);
  assert.equal(output, 2540);
  assert.equal(reasoning, 1600);
});

test('sums records across top-level and nested session files, picks up new files', async (t) => {
  const dir = setup(t);
  const slug = path.join(dir, 'slug');
  fs.writeFileSync(path.join(slug, 'a.jsonl'), messageRecord(T0, 100) + '\n' + messageRecord(T0 + 1000, 50) + '\n');
  const sessionDir = path.join(slug, '2026-11-21T11-00-00-000Z_01a1fdca-0000-0000-0000-000000000000');
  fs.mkdirSync(sessionDir);
  fs.writeFileSync(path.join(sessionDir, 'Sub.jsonl'), messageRecord(T0 + 1500, 25) + '\n');
  const { win, tailer } = harness(dir);

  assert.equal(tailer.poll(T0 + 2000), true);
  assert.equal(win.total(T0 + 2000), 175);

  fs.writeFileSync(path.join(slug, 'b.jsonl'), messageRecord(T0 + 2000, 5) + '\n');
  await pollUntil(tailer, T0 + 3000, () => win.total(T0 + 3000) === 180);
  assert.equal(win.total(T0 + 3000), 180);
});

test('ignores changes.jsonl, blobs/, local/ and deeper directories', (t) => {
  const dir = setup(t);
  const slug = path.join(dir, 'slug');
  const sessionDir = path.join(slug, '2026-11-21T11-00-00-000Z_01a1fdca-0000-0000-0000-000000000000');
  fs.mkdirSync(path.join(slug, 'blobs'), { recursive: true });
  fs.mkdirSync(path.join(sessionDir, 'local'), { recursive: true });
  fs.writeFileSync(path.join(slug, 'changes.jsonl'), messageRecord(T0, 1000) + '\n');
  fs.writeFileSync(path.join(slug, 'blobs', 'x.jsonl'), messageRecord(T0, 2000) + '\n');
  fs.writeFileSync(path.join(sessionDir, 'local', 'y.jsonl'), messageRecord(T0, 3000) + '\n');
  fs.writeFileSync(path.join(sessionDir, 'changes.jsonl'), messageRecord(T0, 4000) + '\n');
  const { win, tailer } = harness(dir);

  tailer.poll(T0);
  assert.equal(win.total(T0), 0);
});

test('finds the start behind a >256 KB tail, no partial line, no double count', (t) => {
  const dir = setup(t);
  const pad = JSON.stringify({
    type: 'message',
    id: 'pad',
    timestamp: new Date(T0 + 5000).toISOString(),
    message: { role: 'assistant', usage: { output: 1 }, pad: 'x'.repeat(400 * 1024) },
  });
  fs.writeFileSync(
    path.join(dir, 'slug', 'a.jsonl'),
    messageRecord(T0 - 70_000, 1000, 'old') + '\n' + messageRecord(T0, 42, 'in-window') + '\n' + pad + '\n',
  );
  const { win, tailer } = harness(dir);

  tailer.poll(T0);
  assert.equal(win.total(T0), 42);
  tailer.poll(T0);
  assert.equal(win.total(T0), 42);
});

test('reads from 0 when no older record exists within the 8 MB scan cap', (t) => {
  const dir = setup(t);
  const pad = JSON.stringify({
    type: 'message',
    id: 'pad',
    timestamp: new Date(T0 + 5000).toISOString(),
    message: { role: 'assistant', usage: { output: 1 }, pad: 'x'.repeat(9 * 1024 * 1024) },
  });
  fs.writeFileSync(path.join(dir, 'slug', 'a.jsonl'), messageRecord(T0, 42, 'in-window') + '\n' + pad + '\n');
  const { win, tailer } = harness(dir);

  tailer.poll(T0);
  assert.equal(win.total(T0), 42);
});

test('one record reachable under two paths counts once', (t) => {
  const dir = setup(t);
  const slug = path.join(dir, 'slug');
  const sessionDir = path.join(slug, '2026-11-21T11-00-00-000Z_01a1fdca-0000-0000-0000-000000000000');
  fs.mkdirSync(sessionDir);
  const line = messageRecord(T0, 100, 'same-id') + '\n';
  fs.writeFileSync(path.join(slug, 'a.jsonl'), line);
  fs.writeFileSync(path.join(sessionDir, 'copy.jsonl'), line);
  const { win, tailer } = harness(dir);

  tailer.poll(T0 + 1000);
  assert.equal(win.total(T0 + 1000), 100);
});

test('a truncated/restarted file is not double counted', async (t) => {
  const dir = setup(t);
  const file = path.join(dir, 'slug', 'session.jsonl');
  fs.writeFileSync(file, messageRecord(T0, 100) + '\n' + messageRecord(T0 + 1000, 50) + '\n');
  const { win, tailer } = harness(dir);

  tailer.poll(T0 + 2000);
  assert.equal(win.total(T0 + 2000), 150);

  // Truncate and rewrite with partially identical content, then append a new record.
  fs.writeFileSync(file, messageRecord(T0, 100) + '\n' + messageRecord(T0 + 3000, 7) + '\n');
  await pollUntil(tailer, T0 + 4000, () => win.total(T0 + 4000) === 157);
  assert.equal(win.total(T0 + 4000), 157);
  tailer.poll(T0 + 4000);
  assert.equal(win.total(T0 + 4000), 157);
});

test('a missing sessions root reports failure instead of throwing', () => {
  const { tailer } = harness(path.join(here, 'does-not-exist'));
  assert.equal(tailer.poll(T0), false);
});

test('a watch event picks up a new file without a directory rescan', async (t) => {
  const dir = setup(t);
  const slug = path.join(dir, 'slug');
  fs.writeFileSync(path.join(slug, 'a.jsonl'), messageRecord(T0, 100) + '\n');
  const { win, tailer } = harness(dir);

  tailer.poll(T0);
  assert.equal(win.total(T0), 100);
  const before = snapshot();

  fs.writeFileSync(path.join(slug, 'b.jsonl'), messageRecord(T0 + 1000, 5) + '\n');
  await pollUntil(tailer, T0 + 1000, () => win.total(T0 + 1000) === 105);
  assert.equal(win.total(T0 + 1000), 105);
  assert.equal(stats.readdir - before.readdir, 0); // the event named the file: no rescan
});

test('an append is read from its watch event without a stat', async (t) => {
  const dir = setup(t);
  const file = path.join(dir, 'slug', 'a.jsonl');
  fs.writeFileSync(file, messageRecord(T0, 100) + '\n');
  const { win, tailer } = harness(dir);

  tailer.poll(T0);
  assert.equal(win.total(T0), 100);
  const before = snapshot();

  fs.appendFileSync(file, messageRecord(T0 + 1000, 5) + '\n');
  await pollUntil(tailer, T0 + 1000, () => win.total(T0 + 1000) === 105);
  assert.equal(win.total(T0 + 1000), 105);
  assert.equal(stats.stat - before.stat, 0);
});

test('the minute reconcile finds a file whose watch event has not landed yet', (t) => {
  const dir = setup(t);
  const slug = path.join(dir, 'slug');
  fs.writeFileSync(path.join(slug, 'a.jsonl'), messageRecord(T0, 100) + '\n');
  const { win, tailer } = harness(dir);

  tailer.poll(T0);
  assert.equal(win.total(T0), 100);

  // Written and polled in the same tick: the watch callback cannot have run, so only the
  // 60 s reconcile can see the file.
  fs.writeFileSync(path.join(slug, 'b.jsonl'), messageRecord(T0 + 1000, 5) + '\n');
  tailer.poll(T0 + MIN);
  assert.equal(win.total(T0 + MIN), 105);
});

test('an idle poll makes no file syscalls', async (t) => {
  const dir = setup(t);
  fs.writeFileSync(path.join(dir, 'slug', 'a.jsonl'), messageRecord(T0, 100) + '\n');
  const { tailer } = harness(dir);

  tailer.poll(T0);
  await sleep(50); // let any queued watch event land
  tailer.poll(T0 + 1000);
  const before = snapshot();
  tailer.poll(T0 + 2000);
  assert.deepEqual(delta(before, snapshot()), {
    readdir: 0, stat: 0, open: 0, close: 0, read: 0, bytes: 0, fullScans: 0,
  });
});

test('onRecord names the absolute session file that produced the record', (t) => {
  const dir = setup(t);
  const file = path.join(dir, 'slug', 'session.jsonl');
  fs.writeFileSync(file, messageRecord(T0, 5) + '\n');
  const seen = [];
  const tailer = createTailer({ root: dir, windowMs: MIN, onRecord: (r) => seen.push(r) });

  tailer.poll(T0 + 1000);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].file, file);
  assert.equal(seen[0].output, 5);
  assert.equal(seen[0].tsMs, T0);
});
