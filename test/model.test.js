const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const here = __dirname;
const CLI = path.join(here, '..', 'tps.js');
const WINDOW_S = 8;
const OUTPUT = 800;
const REASONING = 200;
const EXPECTED = '900.0 tok/s · 8 s · 7200 tok · 1800 rsn';

const line = (rec) => JSON.stringify(rec) + '\n';
const iso = (tsMs) => new Date(tsMs).toISOString();
// Session directory names carry the ISO timestamp; colons/dots are not path-safe there.
const stamp = (tsMs) => iso(tsMs).replace(/[:.]/g, '-');

function sessionLine(tsMs, id, parentSession) {
  const rec = { type: 'session', id, timestamp: iso(tsMs) };
  if (parentSession) rec.parentSession = parentSession;
  return line(rec);
}

function usageLine(tsMs, id, output, reasoningTokens) {
  return line({
    type: 'message',
    id,
    timestamp: iso(tsMs),
    message: { role: 'assistant', usage: { input: 0, output, cacheRead: 0, cacheWrite: 0, reasoningTokens } },
  });
}

// 3 leads as <slug>/<ISO>_<uuid>.jsonl, each with 3 subagents as
// <slug>/<session-id>/<Name>.jsonl. The 9 subagents are the 9 active agents;
// the leads hold only their session record (idle, 0 tok/s).
function fixture(t, { extraAgent = false, duplicate = false } = {}) {
  const root = fs.mkdtempSync(path.join(here, 'tmp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ts = Date.now();
  const first = [];

  for (let l = 0; l < 3; l++) {
    const sessionId = `${stamp(ts)}_lead-${l}`;
    const slugDir = path.join(root, `lead-${l}`);
    const sessionDir = path.join(slugDir, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const leadFile = path.join(slugDir, `${sessionId}.jsonl`);
    fs.writeFileSync(leadFile, sessionLine(ts, sessionId));

    for (let s = 0; s < 3; s++) {
      const id = `${sessionId}-sub-${s}`;
      const usage = usageLine(ts, id, OUTPUT, REASONING);
      const subFile = path.join(sessionDir, `Sub-${s}.jsonl`);
      fs.writeFileSync(subFile, sessionLine(ts, id, sessionId) + usage);
      first.push({ leadFile, subFile, usage });
    }
  }

  if (extraAgent) {
    const extraDir = path.join(root, 'extra');
    fs.mkdirSync(extraDir);
    fs.writeFileSync(
      path.join(extraDir, `${stamp(ts)}_total-tokens.jsonl`),
      sessionLine(ts, 'total-tokens') +
        line({ type: 'model_usage', timestamp: iso(ts), usage: { totalTokens: 999_999 } }),
    );
  }

  // Same record (id + timestamp) reachable from a lead file and a subagent file.
  if (duplicate) fs.appendFileSync(first[0].leadFile, first[0].usage);

  return { root, atMs: ts + 1000 };
}

function run({ root, atMs }) {
  return execFileSync(process.execPath, [CLI, '--at', iso(atMs)], {
    encoding: 'utf8',
    env: { ...process.env, TPS_SESSIONS_ROOT: root, TPS_WINDOW_SECONDS: String(WINDOW_S) },
  });
}

test('the CLI sums 9 agents at 100 tps to 900 tok/s, ignoring totalTokens and duplicate records', (t) => {
  const plain = fixture(t);
  assert.equal(run(plain).trim(), EXPECTED);

  const withTotalTokens = fixture(t, { extraAgent: true });
  assert.equal(run(withTotalTokens).trim(), EXPECTED);

  const withDuplicate = fixture(t, { duplicate: true });
  assert.equal(run(withDuplicate).trim(), EXPECTED);
});
