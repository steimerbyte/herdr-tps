// Port of OMP's TokenRateMeter (packages/coding-agent/src/utils/token-rate.ts).
// Same constants and arithmetic, so a session's reading matches the native badge:
// a kernel-weighted rate over stream time (half-lives 5/20/80 s), where streamed
// text is tokenized per 250 ms bucket and the provider's billed output corrects
// the hidden (never streamed) tokens at message end.
// shortcut: the extension has no provider tokenizer, so streamed text is counted
// at 3.6 characters per token; billed corrections dominate the settled reading.
const MIN_DURATION_MS = 100;
const HALF_LIVES_MS = [5_000, 20_000, 80_000];
const MIN_TOKENS = 200;
const MIN_TIME_MS = 4_000;
const BUCKET_MS = 250;
const CARRY_MAX_CHARS = 32;
const HIDDEN_DECAY = 0.8;
const HIDDEN_PRIOR_MS = 10_000;
const LN2 = Math.LN2;

class DecayedSums {
  constructor(halfLifeMs) {
    this.halfLifeMs = halfLifeMs;
    this.tokens = 0;
    this.time = 0;
  }

  advance(dtMs, inflight, hiddenRate) {
    if (dtMs <= 0) return;
    const f = 2 ** (-dtMs / this.halfLifeMs);
    this.tokens *= f;
    this.time *= f;
    if (inflight) {
      const integral = (this.halfLifeMs / LN2) * (1 - f);
      this.time += integral;
      this.tokens += hiddenRate * integral;
    }
  }

  reset() {
    this.tokens = 0;
    this.time = 0;
  }
}

class TokenRateMeter {
  #count;
  #history = HALF_LIVES_MS.map(ms => new DecayedSums(ms));
  #inflight = HALF_LIVES_MS.map(ms => new DecayedSums(ms));
  #startedAt = null;
  #advancedTo = 0;
  #inflightLocal = 0;
  #inflightHiddenRate = 0;
  #pendingIndex = -1;
  #pending = '';
  #pendingTokens = -1;
  #hiddenTokens = 0;
  #hiddenSpanMs = 0;

  constructor(count) {
    this.#count = count;
  }

  begin(nowMs = Date.now()) {
    this.#clearInflight();
    this.#startedAt = nowMs;
    this.#advancedTo = nowMs;
    this.#inflightHiddenRate = Math.max(0, this.#hiddenTokens / (this.#hiddenSpanMs + HIDDEN_PRIOR_MS));
  }

  push(text, nowMs = Date.now()) {
    if (text.length === 0) return;
    if (this.#startedAt === null) this.begin(nowMs);
    const index = Math.floor((nowMs - (this.#startedAt ?? nowMs)) / BUCKET_MS);
    if (index !== this.#pendingIndex) {
      this.#flushPending(true, nowMs);
      this.#pendingIndex = index;
    }
    this.#pending += text;
    this.#pendingTokens = -1;
  }

  end(outputTokens, nowMs = Date.now()) {
    if (this.#startedAt === null) return;
    this.#flushPending(false, nowMs);
    this.#advance(nowMs);
    const spanMs = nowMs - this.#startedAt;
    const billed = outputTokens !== undefined && Number.isFinite(outputTokens) && outputTokens > 0;
    let extra = 0;
    if (billed) {
      const hidden = outputTokens - this.#inflightLocal;
      this.#hiddenTokens = this.#hiddenTokens * HIDDEN_DECAY + hidden;
      this.#hiddenSpanMs = this.#hiddenSpanMs * HIDDEN_DECAY + spanMs;
      extra = hidden - this.#inflightHiddenRate * spanMs;
    }
    for (let k = 0; k < this.#history.length; k++) {
      const live = this.#inflight[k];
      const corrected = live.tokens + (spanMs > 0 ? (extra * live.time) / spanMs : 0);
      this.#history[k].tokens += Math.max(0, corrected);
      this.#history[k].time += live.time;
    }
    this.#clearInflight();
  }

  reset() {
    this.#clearInflight();
    for (const sums of this.#history) sums.reset();
  }

  seed(outputTokens, durationMs) {
    if (!Number.isFinite(outputTokens) || outputTokens <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) {
      this.reset();
      return;
    }
    this.#clearInflight();
    const scale = Math.max(1, MIN_TOKENS / outputTokens, MIN_TIME_MS / durationMs);
    for (const sums of this.#history) {
      sums.tokens = outputTokens * scale;
      sums.time = durationMs * scale;
    }
  }

  rate(nowMs = Date.now()) {
    const dtMs = this.#startedAt === null ? 0 : nowMs - this.#advancedTo;
    const pendingTokens = this.#countPending();
    let tokens = 0;
    let time = 0;
    let evidenceTokens = 0;
    let evidenceTime = 0;
    for (let k = 0; k < this.#history.length; k++) {
      const f = 2 ** (-dtMs / HALF_LIVES_MS[k]);
      const integral = (HALF_LIVES_MS[k] / LN2) * (1 - f);
      evidenceTokens =
        (this.#history[k].tokens + this.#inflight[k].tokens) * f +
        this.#inflightHiddenRate * integral +
        pendingTokens;
      evidenceTime = (this.#history[k].time + this.#inflight[k].time) * f + integral;
      tokens += evidenceTokens;
      time += evidenceTime;
    }
    if (evidenceTokens < MIN_TOKENS || evidenceTime < MIN_TIME_MS) return null;
    return (tokens * 1000) / time;
  }

  #advance(nowMs) {
    const dtMs = nowMs - this.#advancedTo;
    if (dtMs <= 0) return;
    this.#advancedTo = nowMs;
    for (let k = 0; k < this.#history.length; k++) {
      this.#history[k].advance(dtMs, false, 0);
      this.#inflight[k].advance(dtMs, true, this.#inflightHiddenRate);
    }
  }

  #clearInflight() {
    for (const sums of this.#inflight) sums.reset();
    this.#startedAt = null;
    this.#inflightLocal = 0;
    this.#inflightHiddenRate = 0;
    this.#pendingIndex = -1;
    this.#pending = '';
    this.#pendingTokens = -1;
  }

  #countPending() {
    if (this.#pending.length === 0) return 0;
    if (this.#pendingTokens < 0) this.#pendingTokens = this.#count(this.#pending);
    return this.#pendingTokens;
  }

  #flushPending(carry, nowMs) {
    if (this.#pendingIndex < 0 || this.#pending.length === 0) return;
    let text = this.#pending;
    let tail = '';
    if (carry) {
      const cut = Math.max(text.lastIndexOf(' '), text.lastIndexOf('\n'));
      if (cut > 0 && text.length - cut <= CARRY_MAX_CHARS) {
        tail = text.slice(cut);
        text = text.slice(0, cut);
      }
    }
    this.#pending = tail;
    this.#pendingTokens = -1;
    if (text.length === 0) return;
    this.#advance(nowMs);
    const tokens = this.#count(text);
    for (const sums of this.#inflight) sums.tokens += tokens;
    this.#inflightLocal += tokens;
  }
}

// OMP counts streamed text with the provider's tokenizer; an extension cannot
// reach it, so the count follows the usual ~3.6 characters per token.
function approximateCount(text) {
  return Math.round(text.length / 3.6);
}

function createMeter() {
  return new TokenRateMeter(approximateCount);
}

module.exports = { createMeter, TokenRateMeter, approximateCount, MIN_DURATION_MS };
