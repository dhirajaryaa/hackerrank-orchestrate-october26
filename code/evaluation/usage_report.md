# Usage Report — Final Full-Dataset Run

This report covers the run that produced the submitted `output.csv`
(518 evaluation requests from `dataset/deletion_requests.csv`).

## 1. Run summary

| Item | Value |
|---|---|
| Command | `bun run predict` |
| Entry point | `code/main.js` (`predict`) |
| Requests processed | 518 |
| Output | `output.csv` (518 data rows, sorted by `case_id`) |
| Wall-clock duration | 3.0 s warm OCR cache; 39.9 s cold clean-room run |
| Runtime | Node.js v26.8.1 (ES modules), invoked through Bun 1.4.3 script runner |
| AI mode | Deterministic path (AI fallback disabled by default) |
| Model calls | **0** |
| Input tokens | **0** |
| Output tokens | **0** |
| Total tokens | **0** |
| Estimated total cost | **$0.00** |
| Average tokens per request | **0** |
| Estimated cost per request | **$0.000000** |

These values are read directly from `build/usage.json`, written by
`code/lib/usage.js` at the end of the run:

```json
{
  "totals": { "calls": 0, "input_tokens": 0, "output_tokens": 0, "estimated_cost_usd": 0 },
  "byModel": {},
  "calls": []
}
```

## 2. Model providers and models

| Provider | Model | Role | Used in final run |
|---|---|---|---|
| Google (Gemini API) | `gemini-3.5-flash-lite` | Intent-guard fallback for ambiguous request text | No |

Configuration lives in `config/agent.json` (`provider`, `model`, prompt path,
30 s timeout, 4,000-character input cap, 300-token output cap). The API key is
read from the `GEMINI_API_KEY` environment variable only; no key is committed,
and `code/env.example` ships with an empty placeholder.

## 3. Why the final run used no model calls

The request-intent classifier is rule-based and deterministic
(`code/lib/request_intent.js`). It recognises deletion verbs in multiple
languages, hard negations, and the non-deletion intents that must map to
`NOT_APPLICABLE` (access, correction, export, marketing opt-out). Every one of
the 518 requests was resolved by those rules, so the Gemini fallback was never
invoked. The model path is opt-in (`bun run predict --ai`) and is exercised only
by unit tests with a mocked client, so no tokens were billed for this submission.

Consequence: the per-request token and cost figures are exactly zero, not an
estimate. The run is also fully reproducible — repeating `bun run predict`
produced a byte-identical `output.csv` (verified with `diff`).

## 4. Pricing reference for the configured model

Taken from `code/lib/usage.js` (`PRICING`), per million tokens:

| Model | Input | Output |
|---|---|---|
| `gemini-3.5-flash-lite` | $0.10 | $0.40 |

Cost formula applied by the tracker:

```text
cost = input_tokens / 1e6 * input_price + output_tokens / 1e6 * output_price
```

For transparency, the configuration caps bound a single fallback call at 4,000
input characters and 300 output tokens. At roughly four characters per token
that is at most about 1,000 input tokens and 300 output tokens, i.e. an upper
bound of about **$0.00022 per call** if the fallback were enabled. This is a
configuration-derived ceiling, not a measured value; the measured usage of the
submitted run is the zero row in §1.

## 5. Per-model and overall totals

| Model | Calls | Input tokens | Output tokens | Cost (USD) |
|---|---|---|---|---|
| `google/gemini-3.5-flash-lite` | 0 | 0 | 0 | 0.000000 |
| **Overall** | **0** | **0** | **0** | **0.000000** |

## 6. Work performed by the deterministic pipeline

Although no model tokens were spent, the run did substantial local work; these
figures come from the same run:

| Item | Value |
|---|---|
| Evidence artefacts parsed (PDF, image OCR, log, JSON, text, SQL) | 94 (28 JSON, 26 log, 24 SQL, 11 PNG, 4 PDF, 1 text) |
| Authorized cases with at least one linked resource | 505 |
| Cases with no linked resource | 8 (5 `NOT_APPLICABLE`, 3 `COMPLETE` with empty steps) |
| Steps emitted | 2,964 |
| Average steps per case | 5.72 |
| Maximum steps in one case | 14 |
| OCR cache | `build/ocr/*.txt` (reused across runs) |

## 7. Reproducing the measurement

```bash
bun install --frozen-lockfile
bun run predict          # writes output.csv and build/usage.json
cat build/usage.json     # measured call/token/cost totals
bun run validate         # 518/518 rows valid
```

The final warm-cache run took 3.0 s. The archive was also extracted into a fresh
directory containing only `dataset/` (no `node_modules/`, no `build/`, no OCR
cache). `bun install --frozen-lockfile` followed by `bun run predict` completed
in 39.9 s, produced 518 rows, and wrote a byte-identical `output.csv`
(SHA-256 `c977b91a107b8b834b2eec5d766b89cffb164763d0f02fbd73ba9df81e15f72a`).
`bun run validate` in that clean extraction reported 518/518 rows valid.

To measure the optional AI path instead, export `GEMINI_API_KEY` and run
`bun run predict --ai`; `build/usage.json` will then contain per-call provider,
model, token, latency, and cost entries. No such calls are part of the submitted
result.
