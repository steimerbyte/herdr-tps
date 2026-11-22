const test = require('node:test');
const assert = require('node:assert/strict');
const { formatTps, formatReasoning } = require('../format.js');

test('formatTps renders whole tok/s over the window', () => {
  assert.equal(formatTps(0, 8), '0 tok/s');
  assert.equal(formatTps(7_250, 8), '906 tok/s');
  assert.equal(formatTps(1_234, 60), '21 tok/s');
  assert.equal(formatTps(1000, 1), '1000 tok/s');
});

test('formatTps rounds instead of truncating and survives a zero window', () => {
  assert.equal(formatTps(89, 60), '1 tok/s');
  assert.equal(formatTps(90, 60), '2 tok/s');
  assert.equal(formatTps(500, 0), '0 tok/s');
});

test('formatReasoning renders the separate subset rate', () => {
  assert.equal(formatReasoning(0, 8), '0 rsn/s');
  assert.equal(formatReasoning(3_136, 8), '392 rsn/s');
  assert.equal(formatReasoning(1000, 1), '1000 rsn/s');
});
