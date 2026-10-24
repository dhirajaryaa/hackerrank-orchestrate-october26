import { describe, expect, it } from 'vitest';
import { UsageTracker } from '../code/lib/usage.js';

describe('usage accounting', () => {
  it('totals model calls, tokens, and estimated cost', () => {
    const tracker = new UsageTracker();
    tracker.record({
      provider: 'google',
      model: 'gemini-3.5-flash-lite',
      caseId: 'case_test',
      inputTokens: 1000000,
      outputTokens: 1000000,
    });
    tracker.record({
      provider: 'google',
      model: 'gemini-3.5-flash-lite',
      caseId: 'case_test_2',
      inputTokens: 500000,
      outputTokens: 250000,
    });

    const summary = tracker.summary();
    expect(summary.totals.calls).toBe(2);
    expect(summary.totals.input_tokens).toBe(1500000);
    expect(summary.totals.output_tokens).toBe(1250000);
    expect(summary.totals.estimated_cost_usd).toBeCloseTo(0.65, 8);
    expect(summary.byModel['google/gemini-3.5-flash-lite'].calls).toBe(2);
  });

  it('supports a zero-call deterministic run', () => {
    const tracker = new UsageTracker();
    expect(tracker.summary().totals).toEqual({
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      estimated_cost_usd: 0,
    });
  });
});
