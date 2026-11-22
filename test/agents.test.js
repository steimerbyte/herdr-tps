const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { countActive, reporterEntries, formatStatus, sumRates } = require('../agents.js');

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
  assert.equal(sumRates(parsed, NOW), 0); // no rate reported: no contribution
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

test('formatStatus renders the rate with one decimal and the agent count', () => {
  assert.equal(formatStatus(412, 3), '412.0 tok/s · 3 Agenten');
  assert.equal(formatStatus(88.46, 1), '88.5 tok/s · 1 Agent');
  assert.equal(formatStatus(0, 0), '0.0 tok/s · 0 Agenten');
  assert.equal(formatStatus(Number.NaN, Number.NaN), '0.0 tok/s · 0 Agenten');
});

test('sumRates adds fresh readings only', () => {
  assert.equal(sumRates([{ ts: NOW, rate: 10 }, { ts: NOW - 1000, rate: 2.5 }], NOW), 12.5);
  assert.equal(sumRates([{ ts: NOW - 10_000, rate: 9 }], NOW), 9);
  assert.equal(sumRates([{ ts: NOW - 10_001, rate: 100 }], NOW), 0);
  assert.equal(sumRates([{ ts: NOW, rate: Number.NaN }, { rate: 4 }], NOW), 0);
  assert.equal(sumRates(null, NOW), 0);
});
