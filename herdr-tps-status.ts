// Global OMP output tokens/s + running agent count for the Herdr status area
// (ui.tab_bar_right command entry). OMP instantiates this extension once per session:
// every instance reports its own session's agent and the elected single writer
// (writer.lock) tails the session files and writes the display.
// Metric: usage.output per record (provider output rate). reasoningTokens is a subset
// of output and is shown separately, never added.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const require = createRequire(import.meta.url);
const repo = process.env.HERDR_TPS_ROOT ?? "/home/steimer/workspace/herdr-tps";
const { createWindow } = require(path.join(repo, "window.js"));
const { createTailer, stats: tailStats } = require(path.join(repo, "tail.js"));
const { STALE_MS, reporterEntries, countAgents, formatStatus, electWriter, ownsLock, releaseLock } = require(
  path.join(repo, "agents.js"),
);

const stateFile = process.env.HERDR_TPS_STATE_FILE ?? path.join(os.homedir(), ".cache/herdr-tps/tps");
const cacheDir = path.dirname(stateFile);
const agentsDir = path.join(cacheDir, "agents");
const lockFile = path.join(cacheDir, "writer.lock");
const statsFile = path.join(cacheDir, "stats.json");
// Nested omp processes and runs outside Herdr have nothing to show: no timer, no reporter.
const inactive =
  process.env.OMPCODE === "1" || process.env.HERDR_TPS_DISABLE === "1" || process.env.HERDR_ENV !== "1";
const UNSAFE_FILENAME = /[^A-Za-z0-9._-]+/g;

function writeAtomic(file: string, text: string) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch {
    // Display-only: a stale state file hides the entry and the next tick retries.
  }
}

// Required from the repo's plain JS, so the contract is spelled out here.
type UsageWindow = { add(value: number, tsMs: number): void; total(nowMs: number): number; prune(nowMs: number): void };
type Tailer = { poll(nowMs: number): boolean };
type Writer = {
  tailer: Tailer;
  outWin: UsageWindow;
  rsnWin: UsageWindow;
  recent: Map<string, number>;
  lastStats: number;
};

export default function herdrTpsStatus(pi: ExtensionAPI) {
  if (inactive) return;

  const seconds = Number(process.env.TPS_WINDOW_SECONDS ?? 8);
  const windowSec = Number.isFinite(seconds) && seconds > 0 ? seconds : 8;
  const windowMs = windowSec * 1000;
  const sessionsRoot = process.env.TPS_SESSIONS_ROOT ?? path.join(os.homedir(), ".omp/agent/sessions");
  const pane = process.env.HERDR_PANE_ID ?? String(process.pid);
  const paneKey = pane.replace(UNSAFE_FILENAME, "_");

  // One instance per session: this set only ever holds this session's file.
  const active = new Set<string>();
  let sessionKey = "";
  let reporterFile = "";
  let reported = ""; // JSON of the last active set written to the reporter file
  let timer: unknown;
  let writer: Writer | null = null; // kept across a demotion so a re-election reuses the tailer

  // A live agent writes every tick as the 10 s freshness heartbeat; an idle reporter
  // writes nothing while its content stays empty, so finished subagent sessions stop
  // rewriting their file. The stale empty file is ignored by the aggregation.
  function report(now: number, force = false) {
    if (reporterFile === "") return;
    const current = [...active];
    const content = JSON.stringify(current);
    if (!force && content === reported) return;
    writeAtomic(
      reporterFile,
      JSON.stringify({ pane, pid: process.pid, session: sessionKey, ts: now, active: current }),
    );
    reported = content;
  }

  // Open agent_start runs across every live reporter file, one file per session.
  function openPaths(now: number): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(agentsDir);
    } catch {
      return [];
    }
    const reports: { ts: number; active: string[] }[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        reports.push(JSON.parse(fs.readFileSync(path.join(agentsDir, name), "utf8")));
      } catch {
        // A half-written or foreign file is not a reporter.
      }
    }
    const open: string[] = [];
    for (const entry of reporterEntries(reports, now, STALE_MS)) {
      if (typeof entry.path === "string" && entry.path !== "") open.push(entry.path);
    }
    return open;
  }

  function becomeWriter(): Writer {
    const outWin = createWindow(windowMs);
    const rsnWin = createWindow(windowMs);
    const recent = new Map<string, number>();
    const tailer = createTailer({
      root: sessionsRoot,
      windowMs,
      onRecord: ({
        output,
        reasoningTokens,
        tsMs,
        file,
      }: {
        output: number;
        reasoningTokens: number;
        tsMs: number;
        file: string;
      }) => {
        outWin.add(output, tsMs);
        rsnWin.add(reasoningTokens, tsMs);
        recent.set(file, tsMs);
      },
    });
    return { tailer, outWin, rsnWin, recent, lastStats: 0 };
  }

  const tick = () => {
    const now = Date.now();
    report(now, active.size > 0);
    // Ownership is checked per tick: a stalled writer falls back to reporter-only.
    if (!ownsLock(lockFile, process.pid, sessionKey)) {
      const won = electWriter({
        lockFile,
        owner: { pid: process.pid, pane, session: sessionKey },
        nowMs: now,
        staleMs: STALE_MS,
      });
      if (!won) return; // Another instance writes: reporter only.
    }

    writer ??= becomeWriter(); // created on the first election, reused after a demotion
    writer.tailer.poll(now);
    writer.outWin.prune(now);
    writer.rsnWin.prune(now);
    const from = now - windowMs;
    for (const [session, ts] of writer.recent) if (ts < from) writer.recent.delete(session);
    const recent: { path: string; ts: number }[] = [];
    for (const [session, ts] of writer.recent) recent.push({ path: session, ts });
    const agents = countAgents(openPaths(now), recent, now, windowMs);
    const value = formatStatus(writer.outWin.total(now) / windowSec, writer.rsnWin.total(now) / windowSec, agents);
    writeAtomic(stateFile, `${value}\n${now}\npolls=${tailStats.polls}\npid=${process.pid}\n`);
    // The state tick is the display heartbeat; the lock of the writer's session is the ownership.
    writeAtomic(lockFile, JSON.stringify({ pid: process.pid, pane, session: sessionKey, ts: now }));
    if (now - writer.lastStats >= STALE_MS) {
      writer.lastStats = now;
      writeAtomic(statsFile, JSON.stringify({ ...tailStats, agents, writer: `${paneKey}__${sessionKey}`, ts: now }));
    }
  };

  pi.on("session_start", (_event, ctx) => {
    sessionKey = ctx.sessionManager.getSessionId().replace(UNSAFE_FILENAME, "_");
    reporterFile = path.join(agentsDir, `${paneKey}__${sessionKey}.json`);
    if (timer !== undefined) ctx.clearTimer(timer);
    timer = ctx.setInterval(tick, 1000);
    tick();
  });

  // One agent loop = streaming plus tool runs; between prompts nobody is active.
  // The identity is the session file: <parent>/<Name>.jsonl for task subagents.
  // Both events publish immediately; the tick only refreshes the heartbeat.
  pi.on("agent_start", (_event, ctx) => {
    const file = ctx.sessionManager.getSessionFile();
    if (file) active.add(file);
    report(Date.now(), true);
  });

  pi.on("agent_end", (_event, ctx) => {
    const file = ctx.sessionManager.getSessionFile();
    if (file) active.delete(file);
    else active.clear();
    report(Date.now(), true);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (timer !== undefined) {
      ctx.clearTimer(timer);
      timer = undefined;
    }
    active.clear();
    writer = null;
    if (reporterFile !== "") {
      // Empty first, then remove so a failed unlink leaves an idle reporter, never a ghost.
      writeAtomic(
        reporterFile,
        JSON.stringify({ pane, pid: process.pid, session: sessionKey, ts: Date.now(), active: [] }),
      );
      try {
        fs.unlinkSync(reporterFile);
      } catch {
        // Already gone.
      }
    }
    releaseLock(lockFile, process.pid, sessionKey);
  });
}
