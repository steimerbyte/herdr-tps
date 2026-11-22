const os = require('node:os');
const path = require('node:path');
const { createWindow } = require('./window.js');
const { createTailer, stats } = require('./tail.js');

const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

const seconds = Number(process.env.TPS_WINDOW_SECONDS ?? 8);
const windowSec = Number.isFinite(seconds) && seconds > 0 ? seconds : 8;
const windowMs = windowSec * 1000;
const root = process.env.TPS_SESSIONS_ROOT ?? path.join(os.homedir(), '.omp/agent/sessions');

const outWin = createWindow(windowMs);
const rsnWin = createWindow(windowMs);
const tailer = createTailer({
  root,
  windowMs,
  onRecord: ({ output, reasoningTokens, tsMs }) => {
    outWin.add(output, tsMs);
    rsnWin.add(reasoningTokens, tsMs);
  },
});

function line(nowMs, ok) {
  outWin.prune(nowMs);
  rsnWin.prune(nowMs);
  const tokens = outWin.total(nowMs);
  const reasoning = rsnWin.total(nowMs);
  const rate = (tokens / windowSec).toFixed(1);
  const rsn = reasoning > 0 ? ` · ${Math.round(reasoning)} rsn` : '';
  return `${rate} tok/s · ${windowSec} s · ${Math.round(tokens)} tok${rsn}${ok ? '' : ' · no sessions'}`;
}

function out(text) {
  process.stdout.write(text);
}

const wantStats = argv.includes('--stats');
const t0 = process.hrtime.bigint();
function printStats() {
  if (!wantStats) return;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  process.stderr.write(JSON.stringify({ ...stats, ms: Math.round(ms * 10) / 10 }) + '\n');
}

process.stdout.on('error', () => process.exit(0));

const at = argValue('--at');
if (at !== undefined) {
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) {
    process.stderr.write(`invalid --at: ${at}\n`);
    process.exit(2);
  }
  out(line(atMs, tailer.poll(atMs)) + '\n');
  printStats();
  process.exit(0);
}

if (argv.includes('--once')) {
  const now = Date.now();
  out(line(now, tailer.poll(now)) + '\n');
  printStats();
  process.exit(0);
}

let stopped = false;
let first = true;

function tick() {
  const now = Date.now();
  // In a pane refresh in place; piped output gets one clean line per tick.
  const prefix = process.stdout.isTTY ? '\r\x1b[K' : first ? '' : '\n';
  first = false;
  out(prefix + line(now, tailer.poll(now)));
}

function stop() {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  out('\n');
  printStats();
  process.exit(0);
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);

const timer = setInterval(tick, 1000);
tick();
