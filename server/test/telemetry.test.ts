import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelemetryTracker } from '../src/utils/telemetry';

test('uses Ollama eval_count / eval_duration for tokens and TPS', () => {
  const t = new TelemetryTracker();
  t.recordToken();
  const m = t.finish({ eval_count: 100, eval_duration: 2e9, total_duration: 3e9, prompt_eval_count: 40 });
  assert.equal(m.totalTokens, 100);
  assert.equal(m.tps, 50);
  assert.equal(m.totalDurationMs, 3000);
  assert.equal(m.promptTokens, 40);
  assert.equal(m.status, 'completed');
});

test('chunk count is never used as token count', () => {
  const t = new TelemetryTracker();
  for (let i = 0; i < 25; i++) t.recordToken();
  const m = t.finish(); // no metadata
  assert.equal(m.totalTokens, 0);
  assert.equal(m.tps, 0);
});

test('malformed metadata is ignored, not propagated', () => {
  const t = new TelemetryTracker();
  const m = t.finish({
    eval_count: NaN, eval_duration: -5, total_duration: Infinity, prompt_eval_count: '12' as any,
  });
  assert.equal(m.totalTokens, 0);
  assert.equal(m.tps, 0);
  assert.ok(Number.isFinite(m.totalDurationMs) && m.totalDurationMs >= 0);
  assert.equal(m.promptTokens, undefined);
});

test('zero or negative eval_duration gives tps 0 (no division blow-up)', () => {
  for (const d of [0, -1]) {
    const m = new TelemetryTracker().finish({ eval_count: 50, eval_duration: d });
    assert.equal(m.tps, 0);
    assert.equal(m.totalTokens, 50);
  }
});

test('no token arrived => ttft 0; token arrived => ttft measured', async () => {
  assert.equal(new TelemetryTracker().finish({ prompt_eval_duration: 9e9 }).ttftMs, 0);
  const t = new TelemetryTracker();
  await new Promise((r) => setTimeout(r, 20));
  t.recordToken();
  assert.ok(t.finish().ttftMs >= 15);
});

test('status is carried through', () => {
  assert.equal(new TelemetryTracker().finish(undefined, 'cancelled').status, 'cancelled');
  assert.equal(new TelemetryTracker().finish(undefined, 'failed').status, 'failed');
});