# herdr-tps

Globale Output-Tokens/s über alle OMP-Sessions als Herdr-Pane bzw. Status-Eintrag,
rollierendes Fenster.

**Metrik:** die vom Provider gestreamten Output-Tokens, also `usage.output` pro
Usage-Record. Die globale Rate ist die Summe der Per-Agent-Raten über das
Fenster; ein Agent ohne Output im Fenster trägt 0 bei. `input`, `cacheRead` und
`cacheWrite` zählen ausdrücklich **nicht** mit (`usage.totalTokens` ist nicht die
Metrik). `reasoningTokens` ist eine Teilmenge von `output` und wird nur separat
ausgewiesen, nie auf `output` addiert.

Fensterlänge: `TPS_WINDOW_SECONDS` (Default **8 s**), damit Idle die Rate nicht
verdünnt. Gezählt werden `message`- und `model_usage`-Records aus
`sessions/<slug>/*.jsonl` und `sessions/<slug>/<ISO>_<uuid>/*.jsonl`; `blobs/`,
`local/` und `changes.jsonl` nicht. Ein Record zählt genau einmal (Schlüssel
`id@timestamp`).

## Rechenmodell

3 Leads mit je 3 Subagents = 9 aktive Agenten; jeder 100 tps ⇒ 900 tok/s.
Die globale Zahl ist die Summe der Per-Agent-Output-Raten, Subagenten
eingeschlossen, idle = 0.

## Installation

```
herdr plugin link /home/steimer/workspace/herdr-tps
herdr plugin pane open --plugin herdr-tps --entrypoint tps --placement split --direction down
```

Deinstallieren:

```
herdr plugin unlink herdr-tps
```

## Aufruf

```
node tps.js                 # Live-Anzeige, 1 Hz, eine Zeile, in-place
node tps.js --once          # eine Zeile für das Fenster, das jetzt endet
node tps.js --at <ISO8601>  # eine Zeile für das Fenster, das zu diesem Zeitpunkt endet
node tps.js --stats         # zusätzlich Syscall-/Byte-Zähler als JSON auf stderr
```

Die Zeile nennt Output-Rate, Fensterlänge und Rohsumme, bei Reasoning zusätzlich
die Reasoning-Summe:

```
$ node tps.js --at 2026-11-21T11:26:49Z
759.1 tok/s · 8 s · 6073 tok · 3770 rsn
```

Sessions-Root: `TPS_SESSIONS_ROOT` (Default `~/.omp/agent/sessions`). Node ≥ 20,
keine Dependencies.

Gegenrechnung mit derselben Definition (muss exakt dieselben Output-Tokens
zeigen):

```
$ python3 recount.py 2026-11-21T11:26:49Z
{"window_s": 8.0, ..., "active_sessions": 2, "records": 9, "tokens": 6073,
 "tokens_per_s": 759.125, "output_tokens": 6073,
 "output_tokens_per_s": 759.125, "reasoning_tokens": 3770, ...}
```

## Statuszeile (aus OMP)

Die OMP-Extension `herdr-tps-status.ts` schreibt jede Sekunde vier Zeilen nach
`~/.cache/herdr-tps/tps` (überschreibbar mit `HERDR_TPS_STATE_FILE`):

```
412 tok/s (199 rsn/s) · 3 Agenten
1795260585661
polls=3471
pid=4242
```

Zeile 1 ist die Anzeige (`<n> tok/s`, Reasoning-Suffix nur wenn
`reasoningTokens > 0`, Agentenzahl immer), Zeile 2 der Tick in
Epoch-Millisekunden (damit die Gegenrechnung dasselbe Fenster treffen kann),
Zeile 3 die Polls des Writers, Zeile 4 seine PID. `show-tps.sh` liest Zeile 1+2
als `command`-Eintrag in der Tab-Leiste (rechts, oben — `ui.tab_bar_position`
bleibt beim Default `"top"`) und blendet sie aus, wenn der Schreiber länger als
10 s weg ist:

```toml
[ui]
tab_bar_right = [
  { type = "command", command = "/home/steimer/workspace/herdr-tps/show-tps.sh", interval_seconds = 1, timeout_seconds = 1 },
]
```

## Aktive Agenten

OMP instanziiert die Extension **einmal pro Session** — Root-Session und jeder
`task`-Subagent haben ihre eigene Instanz mit eigenen Closures. Eine Instanz
sieht nur die Events ihrer Session; `ctx.sessionManager.getSessionFile()`
liefert dabei den eigenen Pfad (`<parent>/<Name>.jsonl` beim Subagenten). Ein
gemeinsamer In-Memory-Zustand zwischen den Instanzen existiert nicht, deshalb
wird der Reporter pro Session gespeichert.

**Aktiv** ist ein Agent, wenn er im selben 8-s-Fenster wie die Rate Output
erzeugt hat **oder** sein `agent_start` noch ohne `agent_end` offen ist (der
komplette Loop inklusive Tool-Läufen). Daraus folgt die Invariante
`tok/s > 0 ⇒ Agenten ≥ 1`: Ein Burst wirkt 8 s als Agent nach, ein laufender
Loop zählt auch ohne neue Tokens. Die 10-s-Grenze ist nur Cleanup für
Reporter-Dateien und Locks, keine Definitionsgrenze.

Jede Instanz schreibt ihre eigene Datei atomar (tmp + rename) nach
`~/.cache/herdr-tps/agents/<pane>__<sessionId>.json`: `agent_start`/`agent_end`
sofort, danach jede Sekunde als Heartbeat, solange ein Agent läuft. Ein idle
Reporter schreibt nicht weiter; seine Datei bleibt mit `active: []` liegen und
fällt über die 10-s-Frische aus der Aggregation. `session_shutdown` schreibt
`active: []` und löscht die Datei.

```json
{ "pane": "wA:p1", "pid": 4242, "session": "2026-11-21T10-00-00_z_ab12", "ts": 1795260585661, "active": ["/…/Sub-A.jsonl"] }
```

Ein früherer Entwurf mit einer Datei pro Pane war falsch: Die Instanzen
überschrieben sich gegenseitig (`agents/<pane>.json` flippte im Sekundentakt
zwischen Root- und Subagenten-Pfad, die Anzeige blieb bei `· 1 Agent`).

Der Writer vereinigt die `active`-Pfade der frischen Reporter-Dateien (offene
Loops) mit den Session-Dateien, aus denen im Fenster ein Usage-Record kam, und
zählt **distinct** Pfade — derselbe Agent in beiden Mengen zählt einmal, ein
gekillter Prozess fällt nach 10 s raus. Idle heißt 0 Agenten; die Zahl steht
immer in der Zeile:

```
412 tok/s (199 rsn/s) · 3 Agenten
88 tok/s · 1 Agent
0 tok/s · 0 Agenten
```

## Single-Writer

Nur eine Instanz pollt die Session-Dateien und schreibt die State-Datei; alle
anderen melden ausschließlich ihre Agenten. Die Wahl läuft **nur über das
Lock** `~/.cache/herdr-tps/writer.lock`, atomar per `open(…, "wx")` mit
`{pid, pane, session, ts}`. Jede Instanz ohne Lock versucht es jede Sekunde;
ein Lock mit `ts` älter als 10 s (oder eine unlesbare Datei, die älter als 10 s
ist) gilt als verwaist und wird entfernt, der Versuch läuft einmal neu.

Der Tick in Zeile 2 der State-Datei ist **kein** Wahlkriterium: Nach einem
sauberen Shutdown der Writer-Session ist der Tick noch bis zu 10 s frisch, das
Lock aber sofort weg — die nächste Instanz übernimmt beim folgenden Tick, ohne
eingefrorene Anzeige. Der Writer prüft pro Tick `ownsLock(lockFile, pid,
session)` und fällt sonst auf Reporter-only zurück. Sein Heartbeat ist der
State-Tick, den er zusätzlich ins Lock spiegelt; `releaseLock` löscht nur ein
Lock mit eigener `pid` **und** `session`. Alle 10 s schreibt er
`~/.cache/herdr-tps/stats.json` mit den Syscall-Zählern aus `tail.js` plus
`agents` und `writer`.

Fällt der Writer weg, übernimmt die nächste Instanz beim folgenden Tick; ohne
weitere Instanz blendet `show-tps.sh` die Zeile nach 10 s aus.

## Ressourcen

`tail.js` ist event-getrieben (`fs.watch` rekursiv): Ein Idle-Poll macht **keine**
Datei-Syscalls (Median 0,03 ms), der Kaltstart einmalig ~48 ms und ~870 KB, ein
Verzeichnis-Reconcile einmal pro 60 s (~300 Syscalls). Zahlen und Messaufbau:
`MESSUNG.md` Abschnitt 6. Syscall-Zähler bei Bedarf über `node tps.js --stats`.

### Grenze der Live-Zahl

Usage-Records entstehen erst **am Ende** einer Nachricht; während des Streams
gibt es keine monoton wachsenden Deltas. Das 8-s-Fenster über fertige Records
zeigt deshalb Bursts: Eine lange Antwort schlägt mit ihrer Gesamtzahl ein, statt
eine laufende Stream-Rate zu zeigen. Die Agentenzahl dagegen ist live.

Die Extension lädt `window.js`/`tail.js`/`format.js`/`agents.js` aus `HERDR_TPS_ROOT`
(Default `/home/steimer/workspace/herdr-tps`) und respektiert
`TPS_WINDOW_SECONDS`. Sie ist inaktiv (kein Timer, keine Reporter-Datei) in
verschachtelten OMP-Sessions (`OMPCODE=1`), mit `HERDR_TPS_DISABLE=1` und
außerhalb von Herdr (`HERDR_ENV != 1`).

Installation: `herdr-tps-status.ts` nach
`~/.omp/agent/extensions/herdr-tps-status.ts` kopieren oder linken, dann die
OMP-Session neu starten. Config nach dem Eintragen anwenden:

```
herdr server reload-config        # oder im Herdr-Menü: reload config, oder prefix+shift+r
```

Deinstallation: Extension-Datei löschen, den `ui.tab_bar_right`-Eintrag aus
`~/.config/herdr/config.toml` entfernen, `herdr server reload-config`.
Der `writer`/`command`-Pfad ist absolut, also `show-tps.sh` nicht verschieben
(oder den Pfad in der Config mitziehen).
