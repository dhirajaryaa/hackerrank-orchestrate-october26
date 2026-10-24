import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { usage } from './usage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'intent_guard.txt');
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const TIMEOUT_MS = 30000;

const IntentSchema = z.object({
  is_deletion: z.boolean(),
  label: z.enum(['deletion', 'not_deletion', 'unclear']),
  confidence: z.number().min(0).max(1),
  action: z.enum(['delete', 'access', 'correction', 'export', 'marketing_opt_out', 'other']),
  reason: z.string().max(400),
});

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    is_deletion: { type: 'boolean' },
    label: { type: 'string', enum: ['deletion', 'not_deletion', 'unclear'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    action: {
      type: 'string',
      enum: ['delete', 'access', 'correction', 'export', 'marketing_opt_out', 'other'],
    },
    reason: { type: 'string', maxLength: 400 },
  },
  required: ['is_deletion', 'label', 'confidence', 'action', 'reason'],
};

function prompt() {
  try {
    return fs.readFileSync(PROMPT_PATH, 'utf8').trim();
  } catch {
    return 'Decide whether the customer message authorizes deletion. Return only the requested JSON object.';
  }
}

function candidateText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('').trim();
}

async function classifyIntentWithGemini(requestText, { caseId = '' } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, error: 'GEMINI_API_KEY is not set' };

  const body = {
    systemInstruction: { parts: [{ text: prompt() }] },
    contents: [{
      role: 'user',
      parts: [{ text: `Customer message:\n${String(requestText || '').slice(0, 4000)}` }],
    }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 300,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  const started = Date.now();
  let response;
  try {
    response = await fetch(`${ENDPOINT}/${encodeURIComponent(MODEL)}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, error: `request failed: ${error.message}` };
  }
  const latencyMs = Date.now() - started;
  if (!response.ok) {
    return { ok: false, error: `HTTP ${response.status}`, latencyMs };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return { ok: false, error: `invalid response JSON: ${error.message}`, latencyMs };
  }

  const text = candidateText(payload);
  if (!text) return { ok: false, error: 'empty candidate text', latencyMs };

  let parsed;
  try {
    parsed = IntentSchema.parse(JSON.parse(text));
  } catch (error) {
    return { ok: false, error: `schema validation failed: ${error.message}`, latencyMs };
  }

  const promptTokens = Number(payload?.usageMetadata?.promptTokenCount || 0);
  const outputTokens = Number(payload?.usageMetadata?.candidatesTokenCount || 0);
  usage.record({
    provider: 'google',
    model: MODEL,
    purpose: 'intent_fallback',
    caseId,
    inputTokens: promptTokens,
    outputTokens,
    latencyMs,
  });

  return {
    ok: true,
    intent: {
      is_deletion: parsed.is_deletion,
      label: parsed.label,
      matched_terms: [],
      matched_negations: [],
      non_deletion_action: parsed.action === 'delete' ? '' : parsed.action,
      confidence: parsed.confidence,
      reason: parsed.reason,
      source: 'gemini',
    },
    usage: { inputTokens: promptTokens, outputTokens, latencyMs },
  };
}

export { classifyIntentWithGemini, IntentSchema, MODEL as GEMINI_MODEL };
