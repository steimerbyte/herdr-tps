const test = require('node:test');
const assert = require('node:assert/strict');
const { TokenRateMeter, createMeter } = require('../meter.js');

const T0 = 1_795_000_000_000;

test('seed makes a short completed turn readable immediately', () => {
  const m = createMeter();
  m.seed(1000, 5000);
  assert.equal(m.rate(T0), 200);
});

test('a billed message settles on tokens per span and holds between messages', () => {
  const m = createMeter();
  m.begin(T0);
  m.end(3000, T0 + 6000);
  const rate = m.rate(T0 + 6000);
  assert.ok(Math.abs(rate - 500) < 2, `rate ${rate}`);
  assert.equal(m.rate(T0 + 60_000), rate);
});

test('a counted stream converges on the billed rate', () => {
  const m = createMeter();
  m.begin(T0);
  for (let i = 0; i < 55; i++) m.push('x'.repeat(150), T0 + i * 100);
  m.end(3000, T0 + 6000);
  const rate = m.rate(T0 + 6000);
  assert.ok(Math.abs(rate - 500) < 15, `rate ${rate}`);
});

test('the evidence gate needs 200 tokens and 4 s of stream', () => {
  const m = createMeter();
  m.begin(T0);
  m.push('x'.repeat(100), T0 + 1000);
  m.end(100, T0 + 1500);
  assert.equal(m.rate(T0 + 1500), null);
});

test('streamed text counts immediately, before the message ends', () => {
  const m = new TokenRateMeter((text) => text.length);
  m.begin(T0);
  m.push('x'.repeat(1000), T0 + 1000);
  const rate = m.rate(T0 + 5000);
  assert.ok(rate > 100 && rate < 300, `rate ${rate}`);
});
