# Messung — herdr-tps

Datum: 2026-11-21, Herdr 0.9.5, OMP-Sessions unter `~/.omp/agent/sessions`
(1.604 Session-`.jsonl`, 2,7 GB). Alle Zahlen sind auf dieser Maschine gemessen.

**Metrik:** vom Provider gestreamte **Output**-Tokens (`usage.output`), Fenster **8 s**,
globale Rate = Summe der Per-Agent-Raten = Output-Tokens im Fenster / 8 s.
Ein Agent ohne Output im Fenster trägt 0 bei. `input`, `cacheRead`, `cacheWrite` zählen nicht;
`reasoningTokens` ist eine Teilmenge von `output` und wird separat ausgewiesen.

**Rechenmodell (Nutzer):** 3 Leads × 3 Subagents = 9 aktive Agenten à 100 tps ⇒ 900 tok/s.
Die globale Zahl ist additiv über alle Agenten; Agentenzahl und Rate stehen gemeinsam in
der Zeile: `412 tok/s (199 rsn/s) · 3 Agenten`.

## 1. Fläche: `ui.tab_bar_right` (dokumentiert)

Config-Referenz Herdr 0.9.5:

> `ui.tab_bar_right` array default `[]` — Configure ordered right-aligned tab bar entries.
> Supported types are zoom, hostname, datetime, text, and command.

> Command entries run immediately and then at `interval_seconds` without blocking rendering or
> overlapping a previous run. The interval can be 1–31,536,000 seconds and the timeout can be
> 1–3,600 seconds. Herdr uses the last line of successful output, removes ESC-prefixed terminal
> control sequences instead of interpreting styles, clears the entry after failure, empty output,
> or `timeout_seconds`, and provides the same active workspace, tab, pane, socket, binary, and
> working-directory context as custom command keybindings. Commands are supported on Linux, macOS,
> and Windows, using `/bin/sh -lc` on Linux and macOS and `cmd.exe /d /c` on Windows.

Display-only-Seite (keine Rechnung in Herdr): `show-tps.sh` druckt Zeile 1 der State-Datei,
solange der Tick ≤ 10 s alt ist. Rechnung: OMP-Extension.

## 2. Live-Beleg (gerenderte Herdr-Oberfläche)

`wezterm cli get-text --pane-id 0` (Herdr läuft in WezTerm, Pane 0), Tab-Leiste oben rechts,
finaler Stand der Extension. Während zwei `task`-Subagenten liefen (`wW:p1`, je ~500 Wörter),
1,5-s-Abtastung:

```
1276 tok/s (982 rsn/s) · 1 Agent          # Root generiert
 245 tok/s (128 rsn/s) · 3 Agenten        # Root + 2 Subagenten
 453 tok/s  (98 rsn/s) · 3 Agenten
1515 tok/s (424 rsn/s) · 2 Agenten        # erster Subagent fertig
1173 tok/s (343 rsn/s) · 1 Agent
   0 tok/s · 1 Agent                     # Agent wartet auf ein Tool, keine neuen Records
1081 tok/s (346 rsn/s) · 0 Agenten
```

Die Anzeige hinkt der State-Datei um ≤ 1,5 s nach (Abfrageintervall 1 s). Die Rate in der
Statuszeile stammt aus der State-Datei, die Agentenzahl ebenso — Herdr rendert nur.

## 3. Gegenrechnung (identisches Fenster, unabhängige Implementierung)

`recount.py` (Python, liest die Session-Dateien vollständig) gegen die Anzeige; Fensterende
= der in der State-Datei gespeicherte Tick, damit beide exakt dasselbe 8-s-Fenster treffen:

| Tick (UTC) | Anzeige | Recount | Output-Tokens | Reasoning | aktive Sessions | Abweichung |
|---|---|---|---|---|---|---|
| 11:29:50.661 | 348 tok/s | 348 | 2.784 | 2.064 | 1 | 0,00 % |
| 11:29:54.662 | 479 tok/s | 479 | 3.835 | 2.302 | 2 | 0,00 % |
| 11:29:58.662 | 131 tok/s | 131 | 1.051 | 238 | 2 | 0,00 % |
| 11:30:06.663 | 44 tok/s | 44 | 355 | 126 | 1 | 0,00 % |
| 11:30:18.665 | 335 tok/s | 335 | 2.680 | 903 | 1 | 0,00 % |
| 11:30:26.668 | 112 tok/s | 112 | 892 | 543 | 1 | 0,00 % |

10 Proben über 41 s: min/median/max = 0,00 % / 0,00 % / 0,00 %.

Deterministische Zweitprüfung über zwei feste Fenster (`node tps.js --at` vs. `python3 recount.py`):

```
node tps.js --at 2026-11-21T11:26:49Z   → 759.1 tok/s · 8 s · 6073 tok · 3770 rsn
recount.py   2026-11-21T11:26:49Z       → output_tokens 6073, output_tokens_per_s 759.125,
                                          reasoning_tokens 3770, active_sessions 2, records 9
node tps.js --at 2026-11-21T11:20:00Z   → 180.4 tok/s · 8 s · 1443 tok · 1184 rsn
recount.py   2026-11-21T11:20:00Z       → output_tokens 1443, output_tokens_per_s 180.375,
                                          reasoning_tokens 1184, active_sessions 1
```

Die Zahlen blieben nach dem Umbau auf `fs.watch` (Abschnitt 6) unverändert.

## 3a. Rechenmodell als Fixture (Test)

`test/model.test.js` baut 3 Leads + 3×3 Subagenten (jeder 800 `output`, 200 `reasoningTokens`)
und prüft die globale Summe:

```
node tps.js --at <fixture>  → 900.0 tok/s · 8 s · 7200 tok · 1800 rsn
```

Zwei Fallen sind im Fixture mitgeprüft: ein Record mit `totalTokens: 999999` (alte Metrik)
wird ignoriert, ein doppelter Record mit gleicher `id@timestamp` zählt einmal.

## 3b. Subagenten im echten Korpus (Beleg, dass sie mitzählen)

Zwei unabhängige Proben unter `~/.omp/agent/sessions`:

1. `BurstProbe.jsonl` (Subagent, `session.parentSession` gesetzt) unter
   `-workspace-herdr-tps/2026-11-21T11-07-41-…/BurstProbe.jsonl`: genau ein Usage-Record
   `{"type":"message","timestamp":"2026-11-21T11:32:56.717Z", "usage":{"output":10728,"reasoningTokens":5395}}`.
2. Zwei parallele Subagenten `LeuchtturmA.jsonl` / `LeuchtturmB.jsonl` unter
   `-tmp-tps-ext/2026-11-21T11-33-54-…/`: `A` = 1791/932, 414/214, 53/0, 53/0, 63/0 `output/rsn`;
   `B` = 935/0, 616/405, 55/0, 53/0.

Beide Dateien liegen in `<parent-session-dir>/<Name>.jsonl`, also im Tail-Bereich des
Tailers (`<slug>/<ISO>/<Name>.jsonl`). Die Subagenten-Tokens sind damit in der globalen
Summe enthalten — kein separater Datenpfad, keine zweite Quelle.

## 4. Latenz und Bursts (Grenze der Live-Zahl)

Usage-Records entstehen **am Ende** einer Nachricht; `message_update` trägt `usage` nicht
fortlaufend (921 Updates gemessen, alle mit `usage`, aber nur ein Wert am Stream-Ende).
Das 8-s-Fenster über fertige Records zeigt deshalb Bursts.

Messreihe `burst-probe-2026-11-21.csv` (266 Samples à 0,25 s: Dateigröße von
`BurstProbe.jsonl` + Anzeigezeile, Spalten `t,anzeige,tick_ms,dateigroessen`). Die Datei springt bei t = 57,49 s von 25.399 auf 69.761 B (ein Record,
10.728 Output-Tokens); die Anzeige:

| t (s) | Anzeige | Ursache |
|---|---|---|
| 56,70 | 796 tok/s | andere Agenten |
| 57,49 | 983 tok/s | Record landet (8-s-Fenster teilgefüllt) |
| 58,53 | **2.186 tok/s** | 10.728 Tokens im 8-s-Fenster ⇒ +1.341 tok/s |
| 59,57 | 1.824 tok/s | Burst altert |
| 63,48 | 1.663 tok/s | |
| 66,38 | 169 tok/s | Burst 8 s nach dem Einschlag aus dem Fenster |

Grenze: Während einer laufenden Generierung zeigt die Zahl für diesen Agenten 0; die
Latenz bis zur Sichtbarkeit ist Nachrichtenlänge + ≤ 1 s Tick + bis zu 8 s Fensterabbau.
Die Agentenzahl folgt derselben Definition wie die Rate (Abschnitt 5), deshalb wirkt ein
Burst dort 8 s nach und `tok/s > 0 ⇒ Agenten ≥ 1` gilt immer.

## 5. Aktive Agenten: Definition, Live-Beleg, Single-Writer

**Definition:** aktiv ist ein Agent, wenn er **im selben 8-s-Fenster Output erzeugt hat
oder** sein `agent_start` noch ohne `agent_end` offen ist (kompletter Loop inkl. Tool-Läufe).
Die 10-s-Grenze ist nur Cleanup für Reporter-Dateien und Locks, keine Definitionsgrenze.
Daraus folgt die Invariante **`tok/s > 0 ⇒ Agenten ≥ 1`**: Ein Burst zählt 8 s als Agent
nach, ein stiller laufender Loop zählt ohne neue Tokens. Root und `task`-Subagenten sind
gleichgestellt; die Zahl ist die Vereinigung der offenen Läufe (aus den Reportern) mit den
Session-Dateien, die im Fenster Output hatten (aus dem Tailer, `onRecord` liefert `file`).

Gemessen auf dem finalen Stand:

- 150 Proben à 0,3 s über einen Prompt mit einem Subagenten: **0 Verstöße** gegen die
  Invariante, max. 4 Agenten (Root + Subagent + zwei fremde Sessions im Fenster).
- Zwei Proben im Abstand von 2,1 s nach dem Burst:

  | t | Anzeige |
  |---|---|
  | 20,1 s | `735 tok/s (317 rsn/s) · 4 Agenten` |
  | 22,2 s | `691 tok/s (338 rsn/s) · 4 Agenten` |

- Künstlicher Burst (Test/Harness): `100 tok/s · 1 Agent`, 8,6 s später `0 tok/s · 0 Agenten`.
- Der zuvor gemeldete Zustand `969 tok/s · 0 Agenten` ist damit strukturell unmöglich; die
  Zahl stammt aus demselben Fenster wie die Rate.

Die Event-Folge der offenen Loops bleibt (ein Prompt mit 2 Subagenten, offene Läufe):
`1 Agent` (Root) → `3 Agenten` → `2` → `1` → `0`; unter der neuen Definition klingt die Zahl
danach noch bis zu 8 s mit dem Output nach.

OMP instanziiert die Extension **einmal pro Session**; jede Instanz
schreibt ihren eigenen Reporter `~/.cache/herdr-tps/agents/<pane>__<sessionId>.json`
(`active: [eigener Session-Dateipfad]`). Anzeige = distinct Pfade aller Reporter mit
`ts` ≤ 10 s alt, vereinigt mit den Output-Pfaden des Fensters.

**Fehlentwurf, gefunden und behoben:** Reporter pro *Pane* (`agents/<pane>.json`) mit
In-Memory-`Set` pro Extension-Instanz. Da Root- und Subagenten-Instanz dieselbe Datei
schreiben, flippte sie im Sekundentakt zwischen Root- und Subagenten-Pfad, die Zahl blieb
bei 1 (40 s gemessen: abwechselnd `[Root.jsonl]` / `[NebelEssay.jsonl]`). Reporter pro
Session behebt das; README dokumentiert es.

**Single-Writer:** zwei OMP-Panes (`wT:p1`, `wV:p1`), 10 s beobachtet:

```
t0  polls=10  pid=72837
t1  polls=20  pid=72837     # 10 Polls in 10 s, nicht 20
```

Takeover: Writer-Pane geschlossen → nach **1,0 s** schreibt die andere Instanz
(`pid=72836`, `polls` beginnt neu bei 1). Lock: `open(…,"wx")`, Heartbeat = State-Tick,
Stale-Takeover nach 10 s, `releaseLock` nur bei eigener `pid` + `session`.

**Grenze:** Nur Prozesse mit dieser Extension melden Agenten. Panes, die vor der
Installation gestartet wurden, sind unsichtbar, bis sie neu starten; Subagenten laufen im
Prozess ihres Leads und werden von dessen Extension-Instanz gemeldet.

## 6. Ressourcen: Tailer vorher/nachher

Vorher: jeder 1-Hz-Poll listete alle Verzeichnisse neu und statete jede Datei.
Nachher: `fs.watch(root, {recursive:true})` markiert geänderte Dateien, ein Poll verarbeitet
nur diese; `fs.watch`-Lücke → Verzeichnis-Reconcile einmal pro 60 s (bewusster Kompromiss,
ein teurer Poll pro Minute). Kaltstart unverändert über mtime-Prefilter + Rückwärts-Scan.

| Messung | vorher | nachher |
|---|---|---|
| kalt `--once --stats` (1 Poll) | readdir 288, stat 1.453, open 2, read 4, 612.411 B, 17,0 ms | readdir 288, stat 1.743, open 3, read 9, 868.010 B, 48,2 ms, `fullScans 0` |
| Idle-Poll (Median aus 9 Polls à 1 s) | 288 readdir + 1.453 stat + 0,5 open, 14,1 ms | **0 Syscalls, 0 Bytes, 0,029 ms** (max 0,061 ms) |
| 60-s-Reconcile | – | ein Poll/Minute mit ~300 Syscalls |
| `fullScans` auf 2,7 GB | 0 | 0 (kein 8-MB-Rückwärts-Scan nötig) |

Der Kaltstart ist teurer (48 statt 17 ms) — einmalig, für Verzeichnis-Cache und
Watch-Setup; die laufenden Polls kosten nichts. Der 60-s-Reconcile ist der Preis für
`fs.watch`-Zuverlässigkeit ohne dauerhaftes Staten.

## 7. Verworfene Flächen und Metriken (belegt)

- **Sidebar-Token** (`pane.report_metadata` + `ui.sidebar.agents.rows_by_agent` mit `$tps`):
  funktioniert und rendert (Capture: eigene Zeile `1234 tok/s` unter dem Agentennamen), ist aber
  redundant zur Statuszeile und braucht eine Sidebar-Layout-Änderung → entfernt, Config zurückgesetzt.
- **`pane.report_agent --message`**: wird akzeptiert, ist aber in `PaneInfo`/`AgentInfo` nicht
  enthalten (kein Feld) und laut Doku nur "to explain a block" → keine Statusfläche.
- **`ui.status_indicators`**: nur `dots`/`symbols`, kein Text.
- **Alte Metrik `usage.totalTokens`** (inkl. `cacheRead`, 60-s-Fenster): ergab 50.000–75.000 tok/s,
  also Cache-Reads statt gestreamter Ausgabe. Ersetzt; alte Zahlen in diesem Dokument sind ungültig.

## 8. Reproduktion

```
node --test test/                                   # 40 Tests
node tps.js --at 2026-11-21T11:26:49Z               # 759.1 tok/s · 8 s · 6073 tok · 3770 rsn
python3 recount.py 2026-11-21T11:26:49Z             # output_tokens 6073
node tps.js --once --stats                          # Syscall-Zähler
sh show-tps.sh                                      # Anzeigezeile aus der State-Datei
```

Installation, Config-Block und Reload-Befehl (`herdr server reload-config`) stehen im README.

## 9. Herdr-seitig unverändert

`~/.omp/agent/extensions/herdr-omp-agent-state.ts` (20.11. 16:15) und
`~/.config/herdr/config.toml`-Bestand außer dem `ui.tab_bar_right`-Eintrag (kein
`tab_bar_position`, Tab-Leiste bleibt oben, keine Sidebar-Änderung).
