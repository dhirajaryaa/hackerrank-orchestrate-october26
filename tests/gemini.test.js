import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyIntentWithGemini, IntentSchema } from '../code/lib/gemini.js';
import { usage } from '../code/lib/usage.js';

function mockGemini(payload) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  })));
}

describe('Gemini structured intent fallback', () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-key';
    usage.reset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GEMINI_API_KEY;
    usage.reset();
  });

  it('accepts a schema-valid structured response and records usage', async () => {
    mockGemini({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              is_deletion: true,
              label: 'deletion',
              confidence: 0.98,
              action: 'delete',
              reason: 'Explicit erasure request.',
            }),
          }],
        },
      }],
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 24 },
    });

    const result = await classifyIntentWithGemini('Please erase my account.', { caseId: 'case_test' });
    expect(result.ok).toBe(true);
    expect(result.intent.label).toBe('deletion');
    expect(result.intent.source).toBe('gemini');
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 24, latencyMs: expect.any(Number) });
    expect(usage.summary().totals.calls).toBe(1);
    expect(usage.summary().totals.input_tokens).toBe(120);
  });

  it('rejects a response that does not match the structured schema', async () => {
    mockGemini({
      candidates: [{ content: { parts: [{ text: '{"is_deletion":"yes"}' }] } }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4 },
    });

    const result = await classifyIntentWithGemini('Please erase my account.');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('schema validation failed');
    expect(usage.summary().totals.calls).toBe(0);
  });

  it('does not call the model without an API key', async () => {
    delete process.env.GEMINI_API_KEY;
    const result = await classifyIntentWithGemini('Please erase my account.');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('GEMINI_API_KEY');
  });

  it('defines a strict intent schema', () => {
    expect(IntentSchema.safeParse({
      is_deletion: false,
      label: 'not_deletion',
      confidence: 0.9,
      action: 'access',
      reason: 'Access request.',
    }).success).toBe(true);
    expect(IntentSchema.safeParse({ label: 'deletion' }).success).toBe(false);
  });
});
