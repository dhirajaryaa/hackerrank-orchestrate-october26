const PRICING = {
  'gemini-3.5-flash-lite': {
    inputPerMillion: 0.1,
    outputPerMillion: 0.4,
  },
};

class UsageTracker {
  constructor() {
    this.calls = [];
  }

  record(call) {
    const inputTokens = Number(call.inputTokens || 0);
    const outputTokens = Number(call.outputTokens || 0);
    const pricing = PRICING[call.model] || { inputPerMillion: 0, outputPerMillion: 0 };
    const estimatedCostUsd = call.estimatedCostUsd
      ?? (inputTokens / 1000000) * pricing.inputPerMillion
      + (outputTokens / 1000000) * pricing.outputPerMillion;
    this.calls.push({
      provider: call.provider || 'google',
      model: call.model || 'unknown',
      purpose: call.purpose || 'intent_fallback',
      case_id: call.caseId || '',
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      estimated_cost_usd: Number(estimatedCostUsd.toFixed(8)),
      latency_ms: Number(call.latencyMs || 0),
    });
  }

  summary() {
    const totals = {
      calls: this.calls.length,
      input_tokens: 0,
      output_tokens: 0,
      estimated_cost_usd: 0,
    };
    const byModel = {};
    for (const call of this.calls) {
      totals.input_tokens += call.input_tokens;
      totals.output_tokens += call.output_tokens;
      totals.estimated_cost_usd += call.estimated_cost_usd;
      const key = `${call.provider}/${call.model}`;
      if (!byModel[key]) {
        byModel[key] = {
          provider: call.provider,
          model: call.model,
          calls: 0,
          input_tokens: 0,
          output_tokens: 0,
          estimated_cost_usd: 0,
        };
      }
      byModel[key].calls += 1;
      byModel[key].input_tokens += call.input_tokens;
      byModel[key].output_tokens += call.output_tokens;
      byModel[key].estimated_cost_usd += call.estimated_cost_usd;
    }
    totals.estimated_cost_usd = Number(totals.estimated_cost_usd.toFixed(8));
    for (const value of Object.values(byModel)) {
      value.estimated_cost_usd = Number(value.estimated_cost_usd.toFixed(8));
    }
    return { totals, byModel, calls: this.calls };
  }

  reset() {
    this.calls = [];
  }
}

const usage = new UsageTracker();

export { usage, UsageTracker, PRICING };
