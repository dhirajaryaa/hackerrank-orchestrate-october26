# Evaluation Report — Ghost Data Still Exists

Deletion-audit agent for the HackerRank Orchestrate October 2026 challenge.

All numbers below were produced by running the checked-in solution against
participant-facing data only (`dataset/sample_deletion_requests.csv`,
`dataset/sample_output.csv`, `dataset/deletion_requests.csv`). Nothing in this
report is estimated or hand-entered; each metric comes from
`build/sample-score.json`, `bun run validate`, and the Vitest suite.

## 1. What the agent does

For each request the pipeline:

1. **Intent gate** (`code/lib/request_intent.js`, optional Gemini fallback in
   `code/lib/gemini.js`): decides whether the message authorises deletion.
   Access, correction, export, marketing opt-out, and explicit negations are
   `NOT_APPLICABLE` with `steps_json=[]`.
2. **Identity resolution** (`code/lib/identity.js`): matches the supplied email
   against current identities and the audit log, recovering historical emails,
   phones, and email hashes, plus the stable `user_id`.
3. **Evidence linking** (`code/lib/evidence.js`, `code/lib/linker.js`,
   `code/lib/parsers/*`): parses PDFs, images (OCR), logs, JSON, plain text, and
   SQLite-compatible `.sql` snapshots, then links records to the subject through
   identifiers, hashes, resource ids, and timestamps, discarding anything
   captured after `audit_at`.
4. **Policy application** (`code/lib/config.js`, `code/lib/planner.js`): maps
   each `(category, state)` pair to the required finding, remediation, and
   verification triple from `dataset/deletion_rules.csv`.
5. **Decision + planning** (`code/lib/engine.js`): emits `INCOMPLETE` when any
   finding survives, otherwise `COMPLETE` with verification-only steps, sorted
   by phase, operation order, `system_id`, and `resource_id`.

## 2. Full-dataset output

| Metric | Value |
|---|---|
| Rows written to `output.csv` | 518 |
| Unique `case_id` values | 518 |
| Validation result (`bun run validate`) | 518/518 rows valid |
| `INCOMPLETE` | 330 |
| `COMPLETE` | 178 |
| `NOT_APPLICABLE` | 10 |
| Total emitted steps | 2,964 (average 5.72 per case, max 14) |

All `steps_json` values parse as JSON arrays, `step_no` is consecutive from 1,
phases are ordered `FINDING` → `REMEDIATION` → `VERIFICATION`, and remediation
and future-verification steps carry `evidence_id=""`.

## 3. Sample-set metrics (32 public cases)

Command: `bun run score` (writes `build/sample-score.json`).

| Metric | Result |
|---|---|
| Deletion-status accuracy | **32/32 (100.0%)** |
| Exact case accuracy | 29/32 (90.6%) |
| Sequence accuracy | 29/32 (90.6%) |
| Step-position accuracy | 185/193 (95.9%) |
| Field accuracy — phase | 190/193 (98.4%) |
| Field accuracy — system_id | 185/193 (95.9%) |
| Field accuracy — resource_id | 185/193 (95.9%) |
| Field accuracy — operation | 185/193 (95.9%) |
| Field accuracy — state | 185/193 (95.9%) |
| Field accuracy — evidence_id | 189/193 (97.9%) |

## 4. Failures found in the sample set

Three cases have the correct deletion status but an incomplete step sequence.
All three under-report by exactly one step; none over-report.

| Case | Status (ours / expected) | Steps (ours / expected) | Missing step |
|---|---|---|---|
| `case_04` | COMPLETE / COMPLETE | 1 / 2 | Expected `VERIFY_RECORD_ABSENT` for `account_service/account_004` citing `evidence_54`; ours verifies only the anonymised analytics record. |
| `case_18` | INCOMPLETE / INCOMPLETE | 13 / 14 | Expected `VERIFY_RECORD_PRESENT` for the retained `security_service/audit_record_6645`; the other 13 steps match. |
| `case_20` | INCOMPLETE / INCOMPLETE | 7 / 8 | Expected `VERIFY_RECORD_PRESENT` for the retained `security_service/audit_record_5569`; the other 7 steps match. |

All three under-report by exactly one verification step; none over-report and
none has a wrong status. The cause is visible-evidence coverage, not ordering:

- For `case_04`, the request resolves to `user_04`, but no participant-visible
  artefact in `dataset/evidence/` names `account_004` or the request email.
  Emitting the expected step would require inferring the canonical
  `account_<user-number>` identifier from the `user_id` rather than reading it
  from evidence.
- For `case_18` and `case_20`, the expected retained audit records
  (`audit_record_6645`, `audit_record_5569`) do not appear in any
  participant-visible artefact for `user_50` and `user_48`. The visible security
  snapshots contain audit records for other users only.

The agent deliberately does not invent resource IDs or citations. A step is
only emitted when a parsed artefact captured at or before `audit_at` establishes
the resource and its state. This trades one missing step in three sample cases
for not citing unsupported evidence anywhere in the 518-row output.

## 5. Custom evaluation cases (created for this submission)

`tests/custom_eval.test.js` adds four hand-written cases that are not part of
the public samples. All four pass:

| Case | Scenario | Expected | Actual |
|---|---|---|---|
| `custom_01` | Access request ("send me a copy of my personal information") while a profile record still exists | `NOT_APPLICABLE`, `steps=[]` | Pass |
| `custom_02` | Explicit negation ("please do not delete my account") | `NOT_APPLICABLE`, `steps=[]` | Pass |
| `custom_03` | Identifiable tombstone + retained security audit log + active sync flow | `INCOMPLETE`; `DISABLE_DATA_FLOW` precedes `REDACT_RECORD`; `REPORT_EXPOSED_PII` and `REPORT_ACTIVE_DATA_FLOW` present; retained log never marked for deletion | Pass |
| `custom_04` | Fully compliant case: absent profile, retained audit log, redacted tombstone, disabled flow, blocked backup | `COMPLETE` with 5 verification-only steps, every one citing manifest evidence | Pass |

Custom case `custom_03` is the ordering guard: the deletion policy requires the
data flow to be disabled before dependent records are changed, and the test
fails if remediation is emitted in the wrong order. `custom_04` guards the
`COMPLETE` contract: verification-only, evidence-backed, no remediation.

## 6. Test suite

Command: `bun run test` (Vitest).

| File | Tests | Result |
|---|---|---|
| `tests/intent.test.js` | 5 | Pass |
| `tests/gemini.test.js` | 4 | Pass |
| `tests/planner.test.js` | 5 | Pass |
| `tests/usage.test.js` | 2 | Pass |
| `tests/custom_eval.test.js` | 4 | Pass |
| **Total** | **20** | **20/20 pass** |

## 7. Improvements made during the build

1. **Security-record retention** — retained `SECURITY_AUDIT_LOG` records were
   initially treated like ordinary records and marked for deletion. They are now
   verification-only (`VERIFY_RECORD_PRESENT`) and never remediated.
2. **Account absence linking** — a deleted account was re-reported as present
   when a later activity row still named it. The linker now scopes state to the
   `audit_at` cutoff, so an account absent at that time is verified absent
   rather than reported as remaining.
3. **Deterministic ordering** — steps are sorted by phase, then operation order
   from the problem statement, then `system_id`/`resource_id`, so runs are
   byte-identical and key order is stable.
4. **Tombstone handling** — `ACCOUNT_TOMBSTONE` maps to redaction of direct
   identifiers while preserving the stable `user_id` reference, never to
   `DELETE_RECORD`.
5. **Time scoping** — every parsed artefact is compared against `audit_at`
   before it can contribute a finding or a verification citation.

## 8. Known limitations

- Three of 518 evaluation cases (`case_39`, `case_61`, `case_63`) resolve to
  `COMPLETE` with an empty `steps_json`: their only pre-`audit_at` trace is a
  `LINK_RESOURCE_IDENTITY` activity, which is treated as a claim rather than as
  proof of a surviving record. The alternative — emitting a verification step
  for a resource the evidence does not place in a known state — would cite
  unsupported evidence, so the empty array was kept deliberately.
- The three sample step-count gaps in §4 are open for the same reason.

## 9. Reproduction

```bash
bun install --frozen-lockfile
bun run test       # 20/20 unit + custom evaluation tests
bun run validate   # 518/518 rows valid
bun run score      # sample metrics in this report
bun run predict    # writes ./output.csv
```

The npm script names call `node code/main.js ...`, so the equivalent direct
commands are:

```bash
node code/main.js predict
node code/main.js validate
node code/main.js score
npx vitest run
```

## 10. Verification performed on 2026-10-25

| Check | Command | Result |
|---|---|---|
| Dependencies install from lockfile | `bun install --frozen-lockfile` | Pass |
| Full-dataset build | `bun run build` | 6,923 parsed records; 419 assignments; 0 model calls |
| Full-dataset prediction | `bun run predict` | 518 rows; 178 `COMPLETE`, 330 `INCOMPLETE`, 10 `NOT_APPLICABLE` |
| Output contract | `bun run validate` | `Validated 518 rows (518 unique cases).` |
| Sample scoring | `bun run score` | 32/32 status; 29/32 exact/sequence; 185/193 positions |
| Test suite | `bun run test` | 5 files, 20/20 tests pass |
| Determinism (warm cache) | `sha256sum output.csv` before/after | identical (`c977b91a…f72a`) |
| Clean-room `code.zip` extraction | fresh directory + `dataset/` + `bun install` + `bun run predict` | 518 rows; byte-identical `output.csv`; 39.9 s cold run |
| Clean-room validation | `bun run validate` in the extracted archive | 518/518 rows valid |
