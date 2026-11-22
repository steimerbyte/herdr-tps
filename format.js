// Display form for the Herdr status entry.
function perSecond(tokens, windowSec) {
  const rate = windowSec > 0 ? tokens / windowSec : 0;
  return Math.round(Number.isFinite(rate) ? rate : 0);
}

function formatTps(tokens, windowSec) {
  return `${perSecond(tokens, windowSec)} tok/s`;
}

function formatReasoning(tokens, windowSec) {
  return `${perSecond(tokens, windowSec)} rsn/s`;
}

module.exports = { formatTps, formatReasoning };
