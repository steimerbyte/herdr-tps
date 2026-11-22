const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { countActive, countAgents, reporterEntries, formatStatus } = require('../agents.js');
const { createTailer } = require('../tail.js');
const { createWindow } = require('../window.js');

const NOW = 1_795_000_000_000;

test('countActive counts distinct agents across several reporters', () => {
  const entries = [
    { path: '/s/lead.jsonl', ts: NOW },
    { path: '/s/Sub-A.jsonl', ts: NOW - 1000 },
    { path: '/s/Sub-B.jsonl', ts: NOW - 2000 },
  ];
  assert.equal(countActive(entries, NOW), 3);
  assert.equal(countActive([], NOW), 0);
});

test('countActive counts a path reported twice once', () => {
  const entries = [
    { path: '/s/Sub-A.jsonl', ts: NOW },
    { path: '/s/Sub-A.jsonl', ts: NOW },
    { path: '/s/Sub-B.jsonl', ts: NOW },
  ];
  assert.equal(countActive(entries, NOW), 2);
});

test('countActive drops stale entries at the 10 s boundary', () => {
  assert.equal(countActive([{ path: '/s/Sub-A.jsonl', ts: NOW - 10_000 }], NOW), 1);
  assert.equal(countActive([{ path: '/s/Sub-A.jsonl', ts: NOW - 10_001 }], NOW), 0);
});

test('countActive ignores broken entries', () => {
  const entries = [
    null,
    undefined,
    {},
    { path: 42, ts: NOW },
    { path: '', ts: NOW },
    { path: '/s/Sub-A.jsonl', ts: 'now' },
    { path: '/s/Sub-A.jsonl', ts: Number.NaN },
    { path: '/s/Sub-B.jsonl', ts: NOW },
  ];
  assert.equal(countActive(entries, NOW), 1);
  assert.equal(countActive(null, NOW), 0);
  assert.equal(countActive(undefined, NOW), 0);
});

// Reporter files as the extension writes them: one per session in one pane.
function reporterFiles(t, reports) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-agents-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, report] of Object.entries(reports)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(report));
  }
  return fs.readdirSync(dir).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
}

test('two reporter files of the same pane with one path each count two agents', (t) => {
  const parsed = reporterFiles(t, {
    'wA_p1__root.json': { pane: 'wA:p1', pid: 1, session: 'root', ts: NOW, active: ['/s/root.jsonl'] },
    'wA_p1__Sub-A.json': { pane: 'wA:p1', pid: 1, session: 'Sub-A', ts: NOW, active: ['/s/Sub-A.jsonl'] },
  });
  assert.equal(countActive(reporterEntries(parsed, NOW), NOW), 2);
  assert.equal(formatStatus(412, 199, 2), '412 tok/s (199 rsn/s) · 2 Agenten');
});

test('the same session in two reporter files counts once', (t) => {
  const parsed = reporterFiles(t, {
    'wA_p1__root.json': { pane: 'wA:p1', pid: 1, session: 'root', ts: NOW, active: ['/s/root.jsonl'] },
    'wA_p1__root-dup.json': { pane: 'wA:p1', pid: 1, session: 'root', ts: NOW, active: ['/s/root.jsonl'] },
  });
  assert.equal(countActive(reporterEntries(parsed, NOW), NOW), 1);
});

test('an idle reporter and a stale reporter file leave the count at zero', (t) => {
  const parsed = reporterFiles(t, {
    'wA_p1__root.json': { pane: 'wA:p1', pid: 1, session: 'root', ts: NOW, active: [] },
    'wA_p1__Sub-A.json': { pane: 'wA:p1', pid: 1, session: 'Sub-A', ts: NOW - 10_001, active: ['/s/Sub-A.jsonl'] },
  });
  assert.equal(countActive(reporterEntries(parsed, NOW), NOW), 0);
});

test('reporterEntries keeps the 10 s boundary and skips unreadable entries', () => {
  assert.equal(countActive(reporterEntries([{ ts: NOW - 10_000, active: ['/s/a.jsonl'] }], NOW), NOW), 1);
  assert.equal(countActive(reporterEntries([{ ts: NOW - 10_001, active: ['/s/a.jsonl'] }], NOW), NOW), 0);
  assert.equal(countActive(reporterEntries([{ ts: NOW }], NOW), NOW), 0);
  assert.equal(countActive(reporterEntries([{ active: ['/s/a.jsonl'] }], NOW), NOW), 0);
});

test('formatStatus renders reasoning and the agent count', () => {
  assert.equal(formatStatus(412, 199, 3), '412 tok/s (199 rsn/s) · 3 Agenten');
  assert.equal(formatStatus(412, 0, 3), '412 tok/s · 3 Agenten');
  assert.equal(formatStatus(88, 0, 1), '88 tok/s · 1 Agent');
  assert.equal(formatStatus(0, 0, 0), '0 tok/s · 0 Agenten');
});

test('formatStatus rounds and survives missing numbers', () => {
  assert.equal(formatStatus(411.6, 199.4, 2), '412 tok/s (199 rsn/s) · 2 Agenten');
  assert.equal(formatStatus(Number.NaN, Number.NaN, Number.NaN), '0 tok/s · 0 Agenten');
});

test('countAgents counts a burst inside the window without an open agent', () => {
  const record = { path: '/s/a.jsonl', ts: NOW - 1000 };
  assert.equal(countAgents([], [record], NOW, 8000), 1);
  assert.equal(countAgents([], [record], NOW + 8100, 8000), 0); // 8.1 s after the record
  assert.equal(countAgents([], [{ path: '/s/a.jsonl', ts: NOW }], NOW + 8000, 8000), 1); // boundary
});

test('countAgents unions open runs with output paths and dedupes by path', () => {
  const record = { path: '/s/a.jsonl', ts: NOW - 1000 };
  assert.equal(countAgents(['/s/open.jsonl'], [], NOW, 8000), 1); // open agent, no output
  assert.equal(countAgents(['/s/a.jsonl'], [record], NOW, 8000), 1); // same path in both sets
  assert.equal(countAgents(['/s/open.jsonl'], [record], NOW, 8000), 2);
});

test('countAgents ignores broken inputs', () => {
  assert.equal(countAgents(null, null, NOW, 8000), 0);
  assert.equal(countAgents(undefined, undefined, NOW, 8000), 0);
  const open = [42, '', null, '/s/a.jsonl'];
  const output = [{ path: 7, ts: NOW }, { path: '/s/b.jsonl', ts: 'now' }, null, undefined];
  assert.equal(countAgents(open, output, NOW, 8000), 1);
});

test('integration: a positive window rate always implies at least one agent', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-burst-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  const file = path.join(root, 'slug', 'session.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: 'message',
      id: 'burst-1',
      timestamp: new Date(now - 1000).toISOString(),
      message: { role: 'assistant', usage: { input: 0, output: 800, cacheRead: 0, cacheWrite: 0 } },
    }) + '\n',
  );

  const win = createWindow(8000);
  const recent = new Map();
  const tailer = createTailer({
    root,
    windowMs: 8000,
    onRecord: ({ output, tsMs, file: sessionFile }) => {
      win.add(output, tsMs);
      recent.set(sessionFile, tsMs);
    },
  });
  assert.equal(tailer.poll(now), true);

  const outputs = [...recent].map(([sessionFile, ts]) => ({ path: sessionFile, ts }));
  const rate = win.total(now) / 8;
  const agents = countAgents([], outputs, now, 8000);
  assert.ok(rate > 0, `rate ${rate}`);
  assert.ok(agents >= 1, `agents ${agents}`);

  const later = now + 8100;
  assert.equal(win.total(later), 0);
  assert.equal(countAgents([], outputs, later, 8000), 0);
});
