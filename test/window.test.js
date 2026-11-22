const test = require('node:test');
const assert = require('node:assert/strict');
const { createWindow } = require('../window.js');

const T0 = Date.parse('2026-11-21T11:09:00.000Z');
const MIN = 60_000;

test('sums records from several sessions', () => {
  const w = createWindow(MIN);
  w.add(100, T0);
  w.add(200, T0 + 1000);
  w.add(300, T0 + 2000);
  assert.equal(w.total(T0 + 2000), 600);
});

test('a gap with no records in the window totals 0', () => {
  const w = createWindow(MIN);
  w.add(100, T0);
  assert.equal(w.total(T0 + MIN + 1), 0);
});

test('window edges: start inclusive, just before and future excluded', () => {
  const w = createWindow(MIN);
  const now = T0 + MIN;
  w.add(10, now - MIN);
  w.add(20, now - MIN - 1);
  w.add(30, now + 1);
  w.add(40, now);
  assert.equal(w.total(now), 50);
});

test('prune drops aged-out records but keeps future ones', () => {
  const w = createWindow(1000);
  w.add(10, T0);
  w.add(20, T0 + 1000);
  w.add(30, T0 + 5000);
  w.prune(T0 + 1000);
  assert.equal(w.total(T0 + 1000), 30);
  assert.equal(w.total(T0 + 5000), 30);
});

test('ignores non-numeric input', () => {
  const w = createWindow(MIN);
  w.add('12', T0);
  w.add(50, 'now');
  w.add(NaN, T0);
  w.add(70, T0 + 1);
  assert.equal(w.total(T0 + 1), 70);
});
