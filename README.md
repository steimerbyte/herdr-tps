# herdr-tps

Globale Output-Tokens/s über alle OMP-Sessions in der Herdr-Tab-Leiste —
gerechnet mit einer Portierung von OMPs eigenem `TokenRateMeter`, also dieselbe
Zahl wie das native `tok/s`-Badge.

**Statuszeile (OMP-Extension):** kernel-gewichtete Rate über die Stream-Zeit
(Halbwertszeiten 5/20/80 s). Gestreamte Deltas werden pro 250-ms-Bucket gezählt;
am Message-Ende korrigiert die vom Provider abgerechnete `usage.output` die nie
gestreamten Tokens (Reasoning, Tool-Envelope). Die globale Zahl ist die Summe
der laufenden Sessions, idle trägt 0 bei. `meter.js` ist die Portierung von
`packages/coding-agent/src/utils/token-rate.ts` mit denselben Konstanten;
Unterschied zum Original: der Provider-Tokenizer fehlt einer Extension, das
Port rät gestreamten Text mit 3,6 Zeichen/Token (gemessen an einem echten
Lauf: 3,54 Zeichen/Token inkl. Thinking und Tool-Call-Argumenten).

**Pane/CLI (`tps.js`):** unabhängig davon, rollierendes 8-s-Fenster über die
JSONL-Usage-Records (`usage.output`), Subagenten eingeschlossen, idle = 0.

## Rechenmodell

3 Leads mit je 3 Subagents = 9 aktive Agenten; jeder 100 tps ⇒ 900 tok/s.
Die globale Zahl ist die Summe der Per-Session-Raten; jede Session rechnet mit
demselben Meter wie ihr eigenes OMP-Badge. Ein Subagent ist eine eigene Session
und trägt seine eigene Rate bei.

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

Die OMP-Extension `herdr-tps-status.ts` schreibt jede Sekunde drei Zeilen nach
`~/.cache/herdr-tps/tps` (überschreibbar mit `HERDR_TPS_STATE_FILE`):

```
412.0 tok/s · 3 Agenten
1795260585661
pid=4242
```

Zeile 1 ist die Anzeige, Zeile 2 der Tick in Epoch-Millisekunden, Zeile 3 die PID
des Writers. `show-tps.sh` liest Zeile 1+2 als `command`-Eintrag in der
Tab-Leiste (rechts, oben — `ui.tab_bar_position` bleibt beim Default `"top"`)
und blendet sie aus, wenn der Schreiber länger als 10 s weg ist:

```toml
[ui]
tab_bar_right = [
  { type = "command", command = "/home/steimer/workspace/herdr-tps/show-tps.sh", interval_seconds = 1, timeout_seconds = 1 },
]
```

**Extension-Änderungen greifen erst nach einem Neustart der OMP-Panes**: der
Loader lädt die Datei einmal pro Prozess.

## Aktive Agenten

OMP instanziiert die Extension **einmal pro Session** — Root-Session und jeder
`task`-Subagent haben ihre eigene Instanz mit eigenen Closures. Eine Instanz
sieht nur die Events ihrer Session; `ctx.sessionManager.getSessionFile()`
liefert dabei den eigenen Pfad (`<parent>/<Name>.jsonl` beim Subagenten). Ein
gemeinsamer In-Memory-Zustand zwischen den Instanzen existiert nicht, deshalb
wird der Reporter pro Session gespeichert.

**Aktiv** ist ein Agent von `agent_start` bis `agent_end` (der komplette Loop
inklusive Tool-Läufen). Nur dann schreibt die Session ihre Rate in den Reporter;
danach meldet sie 0. Daraus folgt die Invariante `tok/s > 0 ⇒ Agenten ≥ 1`.
Die 10-s-Grenze ist nur Cleanup für Reporter-Dateien und Locks, keine
Definitionsgrenze.

Jede Instanz schreibt ihre eigene Datei atomar (tmp + rename) nach
`~/.cache/herdr-tps/agents/<pane>__<sessionId>.json`: `agent_start`/`agent_end`
sofort, danach jede Sekunde als Heartbeat, solange ein Agent läuft, mit der
eigenen Meter-Rate. Ein idle Reporter schreibt nicht weiter; seine Datei bleibt
mit `active: []` liegen und fällt über die 10-s-Frische aus der Aggregation.
`session_shutdown` schreibt `active: []` und löscht die Datei.

```json
{ "pane": "wA:p1", "pid": 4242, "session": "2026-11-21T10-00-00_z_ab12", "ts": 1795260585661, "active": ["/…/Sub-A.jsonl"], "rate": 258.5 }
```

Ein früherer Entwurf mit einer Datei pro Pane war falsch: Die Instanzen
überschrieben sich gegenseitig (`agents/<pane>.json` flippte im Sekundentakt
zwischen Root- und Subagenten-Pfad, die Anzeige blieb bei `· 1 Agent`).

Der Writer zählt die **distinct** `active`-Pfade der frischen Reporter-Dateien
und summiert ihre `rate`-Felder; ein gekillter Prozess fällt nach 10 s raus.
Idle heißt 0 Agenten und 0 tok/s; die Zahl steht immer in der Zeile:

```
412.0 tok/s · 3 Agenten
88.5 tok/s · 1 Agent
0.0 tok/s · 0 Agenten
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
Lock mit eigener `pid` **und** `session`.

Fällt der Writer weg, übernimmt die nächste Instanz beim folgenden Tick; ohne
weitere Instanz blendet `show-tps.sh` die Zeile nach 10 s aus.

## Ressourcen

Die Statuszeile liest nur die Reporter-Dateien im Cache-Verzeichnis (~3 Zeilen
pro Sekunde), der Meter rechnet im Event-Stream mit. Der Pane-Modus (`tps.js`)
nutzt weiterhin `tail.js`, event-getrieben (`fs.watch` rekursiv): Ein Idle-Poll
macht **keine** Datei-Syscalls (Median 0,03 ms). Zahlen und Messaufbau:
`MESSUNG.md` Abschnitt 6. Syscall-Zähler bei Bedarf über `node tps.js --stats`.

### Grenze des Pane-Modus

Usage-Records entstehen erst **am Ende** einer Nachricht; das 8-s-Fenster über
fertige Records zeigt deshalb Bursts. Die Statuszeile hat diese Grenze nicht —
sie läuft auf denselben Stream-Deltas wie das native Badge.

Die Extension lädt `meter.js`/`agents.js` aus `HERDR_TPS_ROOT`
(Default `/home/steimer/workspace/herdr-tps`). Sie ist inaktiv (kein Timer,
keine Reporter-Datei) in verschachtelten OMP-Sessions (`OMPCODE=1`), mit
`HERDR_TPS_DISABLE=1` und außerhalb von Herdr (`HERDR_ENV != 1`).

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
