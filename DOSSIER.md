# DOSSIER — herdr-tps: globales Tokens/s im Herdr

## Ziel

Ein Herdr-Plugin, das **live die globalen Tokens pro Sekunde über alle OMP-Sessions**
anzeigt: rollierendes Fenster (Default 60 s), Refresh ≤ 2 s, eine Zahl plus Fensterlänge.

## Kontext (gemessen, nicht neu erheben)

- Herdr 0.9.5. Config `~/.config/herdr/config.toml`; Server spricht NDJSON über einen
  Unix-Socket (`HERDR_SOCKET_PATH`, `HERDR_ENV=1`, `HERDR_PANE_ID`).
- Bestehende OMP-Integration: `~/.omp/agent/extensions/herdr-omp-agent-state.ts`
  (12,4 KB, **von Herdr verwaltet — nicht ändern**). Sie sendet JSON-Requests über den
  Socket; das Schema lässt sich dort ablesen.
- `~/.config/herdr/.plugins.lock` existiert ⇒ Herdr hat ein Plugin-Konzept. **Wo Plugins
  liegen, wie sie installiert und wie sie gerendert werden, ist UNBEKANNT und muss belegt
  werden** (Doku/Repo/Binary-Strings/Config), nicht geraten.
- OMP-Sessions: `~/.omp/agent/sessions/<cwd-slug>/*.jsonl`. Ob dort pro Nachricht
  Token-Usage steht und welche Felder (prompt/completion/cache), ist zu belegen.
  Extension-API (Events, `pi.registerTool`, `ctx`) über `omp://`-Doku im Harness prüfen.
- **`bash` ist für `herdr` global gesperrt** (`~/.omp/agent/config.yml`, `bash.patterns`,
  approval deny). Herdr ausschließlich über das `herdr`-Tool bedienen. Braucht die
  Installation einen Herdr-CLI-Befehl, dokumentierst du ihn als Nutzerbefehl und führst
  ihn nicht aus.
- Netz ist für dieses Projekt erlaubt (Doku-Recherche zur Plugin-API), aber keine
  Zugangsdaten, keine fremden Dienste.

## Aufgaben

1. **Recherche mit Beleg:** Was kann ein Herdr-Plugin (Statuszeile? Pane-Metadaten? eigener
   Prozess? Event-Hook?), welches Request-/Payload-Schema nimmt der Socket, und welche
   OMP-Quelle liefert Tokens live (Extension-Event vs. JSONL-`usage`). Je Frage eine Quelle
   (Datei:Zeile, Doku-URL, Messung).
2. **Design-Entscheidung** in 5 Zeilen: Push aus einer OMP-Extension vs. Pull/Tail eines
   Plugins — die kürzere Variante gewinnt. Verwerfe, was nicht gebraucht wird.
3. **Implementierung** kleinster vollständiger Stand im Repo-Verzeichnis; Installation und
   Deinstallation dokumentiert; keine Änderung herdr-verwalteter Dateien.
4. **Messung:** Live-Demo + unabhängige Gegenrechnung.

## Abnahme

- TPS in Herdr sichtbar (Text- oder Screenshot-Beleg), Refresh ≤ 2 s.
- Gegenrechnung aus denselben Rohdaten über dasselbe Fenster: Abweichung ≤ 5 % über 60 s,
  mit Rohzahlen (Token-Summe, Fenster, Messzeitraum).
- Tests für die Aggregation (mehrere Sessions, Lücken, Session-Neustart) grün.
- Keine herdr-verwaltete Datei geändert; Deinstallation beschrieben.

## Nicht-Ziele

Kostenrechnung, Modell-Breakdown, Dashboard, Änderungen an OMP oder Herdr selbst,
grafische Spielereien.

## Bericht

Max. 10 Zeilen an Meta: `herdr agent prompt w8:p1 "<bericht>"`, Format
`LEAD herdr-tps | Stand: … | Beweis: <befehl> → <ergebnis> | Offen: … | Nächster: …`.
