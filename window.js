// Pure sliding-window token aggregation. No IO, no clock.
function createWindow(windowMs) {
  let entries = []; // [tokens, tsMs]

  return {
    add(value, tsMs) {
      if (!Number.isFinite(value) || !Number.isFinite(tsMs)) return;
      entries.push([value, tsMs]);
    },

    // Window is [nowMs - windowMs, nowMs]; both edges inclusive.
    total(nowMs) {
      const from = nowMs - windowMs;
      let sum = 0;
      for (const [tokens, tsMs] of entries) {
        if (tsMs >= from && tsMs <= nowMs) sum += tokens;
      }
      return sum;
    },

    // Future-dated records stay: they may enter the window once the clock catches up.
    prune(nowMs) {
      const from = nowMs - windowMs;
      entries = entries.filter(([, tsMs]) => tsMs >= from);
    },
  };
}

module.exports = { createWindow };
