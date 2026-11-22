// Global OMP output tokens/s + running agent count for the Herdr status area
// (ui.tab_bar_right command entry). OMP instantiates this extension once per session:
// every instance runs its own copy of OMP's TokenRateMeter (meter.js) on the same
// stream events, so its reading matches the native badge, and the elected single
// writer (writer.lock) sums the live reporters.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const require = createRequire(import.meta.url);
const repo = process.env.HERDR_TPS_ROOT ?? "/home/steimer/workspace/herdr-tps";
const { createMeter } = require(path.join(repo, "meter.js"));
const { STALE_MS, reporterEntries, countActive, sumRates, formatStatus, electWriter, ownsLock, releaseLock } = require(
  path.join(repo, "agents.js"),
);

const stateFile = process.env.HERDR_TPS_STATE_FILE ?? path.join(os.homedir(), ".cache/herdr-tps/tps");
const cacheDir = path.dirname(stateFile);
const agentsDir = path.join(cacheDir, "agents");
const lockFile = path.join(cacheDir, "writer.lock");
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

type Reporter = { ts: number; active: string[]; rate: number };

function readReports(): Reporter[] {
  let names: string[];
  try {
    names = fs.readdirSync(agentsDir);
  } catch {
    return [];
  }
  const reports: Reporter[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      reports.push(JSON.parse(fs.readFileSync(path.join(agentsDir, name), "utf8")));
    } catch {
      // A half-written or foreign file is not a reporter.
    }
  }
  return reports;
}

export default function herdrTpsStatus(pi: ExtensionAPI) {
  if (inactive) return;

  const pane = process.env.HERDR_PANE_ID ?? String(process.pid);
  const paneKey = pane.replace(UNSAFE_FILENAME, "_");

  // One instance per session: this set only ever holds this session's file.
  const active = new Set<string>();
  let meter = createMeter();
  let sessionKey = "";
  let reporterFile = "";
  let reported = ""; // last payload written to the reporter file
  let timer: unknown;

  // A live agent writes every tick as the freshness heartbeat; an idle reporter
  // writes nothing while its content stays empty, so finished subagent sessions stop
  // rewriting their file. The stale empty file is ignored by the aggregation.
  function report(now: number, rate: number, force = false) {
    if (reporterFile === "") return;
    const rounded = Math.round(rate * 10) / 10;
    const current = JSON.stringify([...active, rounded]);
    if (!force && current === reported) return;
    writeAtomic(
      reporterFile,
      JSON.stringify({ pane, pid: process.pid, session: sessionKey, ts: now, active: [...active], rate: rounded }),
    );
    reported = current;
  }

  const tick = () => {
    const now = Date.now();
    // OMP's badge holds its last reading between turns; the global sum must not,
    // so an idle session reports 0 and only a running agent contributes.
    const rate = active.size > 0 ? (meter.rate(now) ?? 0) : 0;
    report(now, rate, active.size > 0);
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

    const reports = readReports();
    const agents = countActive(reporterEntries(reports, now, STALE_MS), now, STALE_MS);
    const sum = sumRates(reports, now, STALE_MS);
    writeAtomic(stateFile, `${formatStatus(sum, agents)}\n${now}\npid=${process.pid}\n`);
    // The state tick is the display heartbeat; the lock of the writer's session is the ownership.
    writeAtomic(lockFile, JSON.stringify({ pid: process.pid, pane, session: sessionKey, ts: now }));
  };

  pi.on("session_start", (_event, ctx) => {
    sessionKey = ctx.sessionManager.getSessionId().replace(UNSAFE_FILENAME, "_");
    reporterFile = path.join(agentsDir, `${paneKey}__${sessionKey}.json`);
    meter = createMeter();
    if (timer !== undefined) ctx.clearTimer(timer);
    timer = ctx.setInterval(tick, 1000);
    tick();
  });

  // Same wiring as OMP's own meter (agent-session: message_start/update/end).
  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") meter.begin(event.message.timestamp);
  });

  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;
    const delta = event.assistantMessageEvent;
    if (delta.type === "text_delta" || delta.type === "thinking_delta" || delta.type === "toolcall_delta") {
      meter.push(delta.delta);
    }
  });

  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    const end = message.duration !== undefined ? message.timestamp + message.duration : undefined;
    meter.end(message.usage?.output, end);
  });

  // One agent loop = streaming plus tool runs; between prompts nobody is active.
  // The identity is the session file: <parent>/<Name>.jsonl for task subagents.
  // Both events publish immediately; the tick only refreshes the heartbeat.
  pi.on("agent_start", (_event, ctx) => {
    const file = ctx.sessionManager.getSessionFile();
    if (file) active.add(file);
    report(Date.now(), meter.rate() ?? 0, true);
  });

  pi.on("agent_end", (_event, ctx) => {
    const file = ctx.sessionManager.getSessionFile();
    if (file) active.delete(file);
    else active.clear();
    report(Date.now(), 0, true);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (timer !== undefined) {
      ctx.clearTimer(timer);
      timer = undefined;
    }
    active.clear();
    if (reporterFile !== "") {
      // Empty first, then remove so a failed unlink leaves an idle reporter, never a ghost.
      writeAtomic(
        reporterFile,
        JSON.stringify({ pane, pid: process.pid, session: sessionKey, ts: Date.now(), active: [], rate: 0 }),
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
