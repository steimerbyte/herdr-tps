#!/bin/sh
# Herdr ui.tab_bar_right command entry: print the TPS line the OMP extension wrote.
# Stale values (no OMP writer for >10 s) print nothing, so the entry disappears.
file="${HERDR_TPS_STATE_FILE:-$HOME/.cache/herdr-tps/tps}"
[ -r "$file" ] || exit 0
value=$(sed -n 1p "$file")
stamp=$(sed -n 2p "$file")
# "98 tok/s" or "98 tok/s (12 rsn/s)"; anything else is not ours and hides the entry.
case "$value" in [0-9]*" tok/s"*) ;; *) exit 0 ;; esac
case "$stamp" in ''|*[!0-9]*) exit 0 ;; esac
age=$(( $(date +%s) * 1000 - stamp ))
[ "$age" -ge -1000 ] && [ "$age" -le 10000 ] && printf '%s\n' "$value"
