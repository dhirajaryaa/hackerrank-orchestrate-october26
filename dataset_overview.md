# Dataset Overview — Ghost Data Still Exists

> Scope: this report was built only from participant-facing files under `dataset/` and the public challenge documents. No organizer-only truth, golden answers, or generator internals were inspected. Row counts exclude CSV headers. All timestamps are UTC.

## 0. Repository state (inspection only; no files changed)

- The worktree is clean on branch `main`. The latest commit is `21b6189 overview of code done`.
- Existing implementation: `code/main.py` is a **Python** CLI with `build`, `predict`, `score`, `list-cases`, and `case` commands. `code/ghostdata/` contains table loaders, an identity resolver, evidence parsers (SQL/JSON/log/TXT/PDF/PNG), a linker, a per-case context builder, and a deterministic planner.
- `code/evaluation/main.py` exists but is empty (0 bytes).
- There is **no** `package.json`, no `config/` directory, no `.env`, no JS/TS source file, and no test suite yet. The requested JavaScript stack is therefore not scaffolded.
- `dataset/output.csv` is the blank header-only template; root-level `output.csv` does not exist yet.
- Some Python `__pycache__/*.pyc` files are tracked by git. They should be excluded from the final `code.zip`.
- The existing Python code was **not deleted, modified, or executed** during this inspection. It is preserved as prior work.

## 1. Challenge in simple Hinglish

Challenge ka core simple hai, lekin trap bada hai: company ka deletion workflow **"Complete"** bol sakta hai, par user ka data databases, replicas, logs, support attachments, exports, search index, analytics, archives ya backups mein bach sakta hai. Aapko har request pe pehle decide karna hai ki person ne deletion maanga bhi hai ya nahi — access, correction, export, ya marketing opt-out ho to **NOT_APPLICABLE**. Agar deletion authorized hai, to current aur historical email/phone/hash se user ke saare records dhundo, `audit_at` tak ki evidence se true state banao, aur `deletion_rules.csv` lagao: kuch records delete honge, kuch redact, kuch anonymize, kuch retain, aur account tombstone mein sirf stable `user_id` rahega. Agar koi copy bachi hai ya sync/restore wapas la sakta hai, to **INCOMPLETE** do — findings, safe ordered remediation (pehle data flows/restore block, phir records), aur verification checks. Agar sab policy-compliant hai, to **COMPLETE** do — sirf evidence-backed verification steps. Workflow status aur activity ke `SUCCESS` claims proof nahi hain; evidence se state prove karni hoti hai.

## 2. CSV inventory

| File | Rows | Columns | Purpose / notes |
|---|---:|---|---|
| `deletion_requests.csv` | 518 | `case_id, email, requested_at, reported_status, reported_at, audit_at, request_text` | The evaluation requests to answer. 517 distinct emails; one address is reused by `case_33` and `case_52` at different dates. `reported_status`: COMPLETE 254, PARTIALLY_COMPLETE 152, NOT_STARTED 112. Requests span 2026-01-05 to 2026-09-24; `audit_at` spans 2026-01-29 to 2026-10-01. |
| `sample_deletion_requests.csv` | 32 | `case_id, email, requested_at, reported_status, reported_at, audit_at, request_text` | Public sample inputs. 32 unique emails. All 32 sample texts relate to deletion; none is a pure access, export, correction, or marketing opt-out request. |
| `sample_output.csv` | 32 | `case_id, deletion_status, steps_json` | Correct sample answers: 10 COMPLETE, 22 INCOMPLETE, 0 NOT_APPLICABLE. Demonstrates the required serialization. |
| `user_identities.csv` | 850 | `user_id, name, email, phone, email_hash, updated_at` | Current identity snapshot, one row per user. `user_id` is the stable subject reference. |
| `user_audit_log.csv` | 306 | `audit_id, user_id, event_time, field_name, old_value, new_value` | Historical identity changes across 196 users: email 107, email_hash 107, phone 92. Used to recover identifiers that older systems may still contain. |
| `system_activity.csv` | 4,011 | `activity_id, event_time, event_type, source_system, target_system, resource_id, reported_result, details` | Global event stream. 17 event types, 3,948 distinct `resource_id`s, 33 source→target pairs. Results: SUCCESS 2,914, FAILED 721, PARTIAL 376. Events span 2026-01-04 to 2026-10-01. Treat these as claims, not proof. |
| `deletion_rules.csv` | 15 | `rule_id, data_category, condition, required_action` | Policy matrix. Actions: DELETE 7, REDACT 3, RETAIN 3, ANONYMIZE 2. Covers profiles, secondary identifiers, search, cache, support, analytics, telemetry, exports, marketing, email logs, security audit, legal hold, backups, and account tombstones. |
| `evidence_files.csv` | 94 | `file_id, file_path, origin, captured_at` | Manifest for the 94 evidence files. 30 distinct origins. `file_path` is written relative to `dataset/` (for example `evidence/logs/...`). `file_id` is the value used as `evidence_id` in output steps. |
| `output.csv` | 0 | `case_id, deletion_status, steps_json` | Blank submission template with header only. The final answer must be written to root-level `output.csv`, not this file. |

Important input fields:

- `email` may be a current or a historical address; identity resolution must combine `user_identities.csv` with `user_audit_log.csv`.
- `reported_status` is only the existing workflow's claim.
- `audit_at` is the decision cutoff. Evidence captured after `audit_at` must not change that case's answer.
- `request_text` is multilingual and may describe a non-deletion action; the action must be classified before any audit work.

## 3. Evidence directory structure

`dataset/evidence/` contains 94 files (about 3.0 MiB) in five subdirectories:

| Directory | Files | Formats | What is inside |
|---|---:|---|---|
| `databases/` | 24 | `.sql` | Point-in-time SQLite-compatible snapshots. Includes primary, read replicas, regional replicas (EU/AP), reporting replica, failover replicas, periodic inventories, and a search primary. Files contain `CREATE TABLE` + `INSERT` statements and often a `snapshot_scope` table with `origin_system` and `captured_at`. |
| `documents/` | 4 | `.pdf` | Business documents: account history report, delivery correction attachment, legal retention register, and security retention extract. |
| `images/` | 11 | `.png` | Console screenshots: account admin, analytics profile, backup/restore, connector management, customer export, deleted-account reference, marketing profile, object storage, search index inspector, security audit explorer, support ticket. |
| `logs/` | 26 | `.log` | Service event streams, application traces, resource lookup traces, syslog archives, operations streams, notification delivery, and support replica logs. |
| `records/` | 29 | 28 `.json`, 1 `.txt` | Snapshot bundles, service resource exports, connector configurations, analytics report, export jobs/manifest, security audit ledger, and a shift handover text file. |

Evidence details that matter:

- **Global, not case-scoped.** A single file can contain rows for many unrelated people. For example, `evidence_03` is a shift handover with checks for dozens of accounts; a case must select only its own rows. The manifest does not say which case a file belongs to.
- **Capture time is part of the evidence.** `captured_at` in the manifest must be compared with the case's `audit_at`. The manifest spans 2026-01-29T11:44:59Z to 2026-10-01T12:00:00Z.
- **SQL files expose topology.** `customer_accounts_failover_replica_20260902.sql`, for example, contains separate `customer_profiles_primary` and `customer_profiles_failover_replica` tables. Primary/replica differences are meaningful; a stale replica can still contain a deleted user.
- **Images and PDFs are ordinary artifacts.** They contain account references, retention entries, support details, export/job state, and console readbacks; they do not contain an explicit deletion verdict.
- **JSON records mirror service readbacks.** Snapshot bundles and service resource exports show whether a resource exists, whether direct identifiers remain, and whether retained audit records are present.

## 4. `sample_output.csv` structure

The file has 32 data rows and exactly three columns:

```text
case_id,deletion_status,steps_json
```

`steps_json` is a JSON array serialized inside a CSV field. Quotes are doubled by CSV escaping, and the JSON object key order varies between sample rows; the grader ignores key order. Every step contains exactly these seven fields:

```json
{
  "step_no": 1,
  "phase": "FINDING",
  "system_id": "account_service",
  "resource_id": "account_005",
  "operation": "REPORT_REMAINING_RECORD",
  "state": "PRESENT",
  "evidence_id": "evidence_01"
}
```

Status distribution and claim accuracy in the 32 samples:

| `reported_status` | Actual COMPLETE | Actual INCOMPLETE | Actual NOT_APPLICABLE |
|---|---:|---:|---:|
| COMPLETE | 6 | 11 | 0 |
| PARTIALLY_COMPLETE | 1 | 4 | 0 |
| NOT_STARTED | 3 | 7 | 0 |
| **Total** | **10** | **22** | **0** |

This is the central lesson of the dataset: 11 cases reported COMPLETE are actually INCOMPLETE, and 3 cases reported NOT_STARTED are actually COMPLETE.

Shape of the two statuses in the samples:

- **COMPLETE (10 cases):** every step is `VERIFICATION`; there are no findings or remediation steps, and every step cites an evidence ID. Step counts range from 1 to 6.
- **INCOMPLETE (22 cases):** steps begin with `FINDING`, then `REMEDIATION`, then `VERIFICATION`. Findings cite evidence; remediation and post-remediation verification use `evidence_id: ""`. Step counts range from 3 to 14.
- **NOT_APPLICABLE:** no sample row exists. The required form is `case_id,NOT_APPLICABLE,[]`; the spec says no deletion or verification is authorized.

Operation counts across the 32 sample outputs:

| Phase | Operations observed |
|---|---|
| FINDING | `REPORT_REMAINING_RECORD` 21, `REPORT_EXPOSED_PII` 11, `REPORT_ACTIVE_DATA_FLOW` 6, `REPORT_RESTORE_RISK` 3 |
| REMEDIATION | `DELETE_RECORD` 21, `REDACT_RECORD` 6, `ANONYMIZE_RECORD` 5, `DISABLE_DATA_FLOW` 6, `BLOCK_RESTORE` 3 |
| VERIFICATION | `VERIFY_RECORD_ABSENT` 50, `VERIFY_RECORD_PRESENT` 24, `VERIFY_RECORD_ANONYMIZED` 12, `VERIFY_RECORD_REDACTED` 10, `VERIFY_DATA_FLOW_DISABLED` 9, `VERIFY_RESTORE_BLOCKED` 6 |

Sample COMPLETE row (`case_01`), abbreviated to the step array:

```json
[
  {
    "step_no": 1,
    "phase": "VERIFICATION",
    "system_id": "account_service",
    "resource_id": "account_001",
    "operation": "VERIFY_RECORD_ABSENT",
    "state": "ABSENT",
    "evidence_id": "evidence_54"
  }
]
```

Sample INCOMPLETE row (`case_05`):

```json
[
  {
    "step_no": 1,
    "phase": "FINDING",
    "system_id": "account_service",
    "resource_id": "account_005",
    "operation": "REPORT_REMAINING_RECORD",
    "state": "PRESENT",
    "evidence_id": "evidence_54"
  },
  {
    "step_no": 2,
    "phase": "REMEDIATION",
    "system_id": "account_service",
    "resource_id": "account_005",
    "operation": "DELETE_RECORD",
    "state": "ABSENT",
    "evidence_id": ""
  },
  {
    "step_no": 3,
    "phase": "VERIFICATION",
    "system_id": "account_service",
    "resource_id": "account_005",
    "operation": "VERIFY_RECORD_ABSENT",
    "state": "ABSENT",
    "evidence_id": ""
  }
]
```

## 5. Three representative sample cases

### Case `case_01` — COMPLETE (simple absence proof)

**Input.** `amina.elmasri@gmail.com`, requested 2026-08-18, workflow reported COMPLETE on 2026-08-20, `audit_at` 2026-09-03T11:30:00Z. The text asks to close the account and remove the profile and personal details, so deletion is authorized.

**Evidence.** `activity_3342` records a `DELETE_RECORD` on `account_service` / `account_001` as SUCCESS at 2026-08-20T16:41:43Z. The cited proof is `evidence_54` (`customer_accounts_failover_replica_20260902.sql`), captured 2026-09-02T23:00:00Z. Its `customer_profiles_primary` table has no `account_001` row, and its `customer_profiles_failover_replica` table also has no `account_001` row.

**Policy.** `rule_01`: `USER_PROFILE` with condition `Always` requires `DELETE`.

**Expected output.** COMPLETE with one step: `VERIFY_RECORD_ABSENT` for `account_service / account_001`, state `ABSENT`, evidence `evidence_54`.

**Connection.** The workflow claim and the snapshot agree at the audit cutoff. Because the required treatment is already achieved, the answer contains only the evidence-backed verification step; no remediation is proposed.

### Case `case_05` — INCOMPLETE (replica still has the profile)

**Input.** `leila.haddad@yahoo.com`, requested 2026-08-27, workflow reported COMPLETE on 2026-08-28, `audit_at` 2026-09-08T13:40:00Z. The text says the email is still recognized and asks to remove any remaining copy.

**Evidence.** `activity_3482` says `DELETE_RECORD` on `account_005` succeeded at 2026-08-28T09:11:01Z. Seconds later, `activity_3483` says `SYNC_RECORD` from `account_service` to `account_failover_replica` for `account_005` succeeded. `evidence_54` (captured 2026-09-02T23:00:00Z) shows the split: `customer_profiles_primary` has no `account_005`, but `customer_profiles_failover_replica` still contains `account_005` with name, email, and phone, status `ACTIVE`.

**Policy.** `rule_01`: `USER_PROFILE` requires `DELETE`.

**Expected output.** INCOMPLETE with three steps: finding `REPORT_REMAINING_RECORD` (`PRESENT`, evidence `evidence_54`), remediation `DELETE_RECORD` (`ABSENT`, empty evidence), and verification `VERIFY_RECORD_ABSENT` (`ABSENT`, empty evidence).

**Connection.** The delete claim is true for the primary table but false for the failover copy. The remaining replica row is the "ghost data" finding; the expected plan deletes it and then verifies absence. This case shows why `reported_status` cannot be trusted and why primary/replica comparisons matter.

### Case `case_32` — INCOMPLETE (tombstone still exposes PII, audit record must stay)

**Input.** `addo.kofi@gmail.com`, requested 2026-09-03, workflow reported PARTIALLY_COMPLETE on 2026-09-06, `audit_at` 2026-09-15T12:00:00Z. The text says the account is gone but an internal deleted-account record still shows personal details; it asks to keep only the reference needed for retained records.

**Evidence.** `activity_3692` records `REDACT_RECORD` on `identity_service` / `tombstone_9178` as FAILED at 2026-09-06T13:00:07Z. `evidence_51` (`customer_data_snapshot_bundle_20260915.json`, captured 2026-09-15T12:00:00Z) shows:
- `account_service` collection `customer_profiles`: empty;
- `identity_service` collection `deleted_customer_references`: `tombstone_9178`, subject `user_542`, still has name, email, phone, and email hash, status `DELETED`;
- `security_service` collection `security_audit_events`: `audit_record_7068` still references `user_542`.

The same snapshot also shows `tombstone_440` already redacted with null name/email/phone/email hash, which illustrates the compliant tombstone shape.

**Policy.** `rule_15`: `ACCOUNT_TOMBSTONE` where the account is deleted and only the stable internal `user_id` is needed to preserve references requires `REDACT`. `rule_12`: `SECURITY_AUDIT_LOG` within the supplied retention period requires `RETAIN`. `rule_01` would require deleting a `USER_PROFILE`, but the account collection is already empty. The snapshot does not expose a `retention_until` for `audit_record_7068`; the expected answer treats that audit record as retained and only verifies its presence.

**Expected output.** INCOMPLETE with five steps:
1. finding `REPORT_EXPOSED_PII` on `identity_service / tombstone_9178` (`PRESENT`, evidence `evidence_51`);
2. remediation `REDACT_RECORD` (`REDACTED`, empty evidence);
3. verification `VERIFY_RECORD_ABSENT` for `account_service / account_8858`;
4. verification `VERIFY_RECORD_PRESENT` for `security_service / audit_record_7068`;
5. verification `VERIFY_RECORD_REDACTED` for `identity_service / tombstone_9178`.

**Connection.** The tombstone must not be deleted: `user_542` is the stable reference needed by the retained security audit record. Only the direct identifiers must be removed. The failed redaction activity explains why the PII is still present; the snapshot proves the state at `audit_at`. The answer therefore combines redaction, retention verification, and absence verification rather than a blanket delete.

## 6. Practical takeaways

- **Claims are not state.** Sample cases include 11 false COMPLETE claims and 3 false NOT_STARTED claims. Activity `SUCCESS` and workflow status are starting points, not conclusions.
- **Identity resolution is historical.** 107 email changes and 107 email-hash changes exist in the audit log; the request email may be the old value, and evidence may contain either form.
- **Evidence is shared and time-bounded.** Filter multi-user files by identifiers and never cite a file captured after the case's `audit_at`.
- **Policy is not "delete everything".** Security audit records, legal holds, backups, support conversations, analytics profiles, and account tombstones each have different required treatments.
- **No public NOT_APPLICABLE example exists.** The format is specified (`[]`), but no sample row demonstrates it; non-deletion requests in the evaluation set must be classified from their text rather than from `reported_status`.
- **Only the provided data supports conclusions.** Where a file does not expose a fact (for example, a tombstone audit record's exact retention expiry), the report should state what is evidenced and avoid inventing the missing detail.

## 7. Uncertainties and risks to investigate

1. **Stack mismatch is the main decision.** The repository already contains a substantial Python implementation, while the requested stack is JavaScript. Porting it line-by-line is expensive; building a minimal JS pipeline from scratch is cleaner but must still cover the same parsing, identity, policy, and ordering rules. Do not overwrite the Python code until this choice is approved.
2. **Only 32 public examples for 518 evaluation cases.** The samples are useful for regression testing but are not a representative validation set. Custom cases are needed for non-deletion intent, historical-email-only matches, active flows, restore risk, tombstones, and multi-system evidence.
3. **No NOT_APPLICABLE sample.** Intent classification must be tested separately. A request for access, correction, export, or marketing opt-out must produce `NOT_APPLICABLE` and `[]`, even if the person exists and has records.
4. **Evidence extraction quality.** Eleven PNGs need OCR and four PDFs need PDF text extraction. Console screenshots and table layouts can lose identifiers; OCR/PDF parsing must be checked against the sample cases and against known resource IDs before trusting it.
5. **Temporal filtering must be per observation, not just per file.** A file's `captured_at` is a file-level timestamp, but logs and SQL snapshots can contain events at different times. The decision must use only observations at or before `audit_at`.
6. **SQL topology and replication drift.** Primary, read, regional, reporting, and failover snapshots can disagree. The implementation needs a generic table/row abstraction rather than hardcoded table names, and must compare the relevant snapshot(s) without assuming the primary is authoritative for every case.
7. **Identity resolution edge cases.** Historical email changes, email hashes, phone changes, `LINK_RESOURCE_IDENTITY` activity rows, and lookup keys all need normalized matching. Name-only matches are risky and should not be treated as proof of identity.
8. **Policy ambiguity.** `SUPPORT_MESSAGE` versus `SUPPORT_ATTACHMENT`, `PRODUCT_TELEMETRY`, legal holds, and tombstones require care. Some evidence does not expose a retention expiry (for example, `audit_record_7068`), so the implementation must use the policy condition that is evidenced and avoid inventing missing dates.
9. **Active-flow and restore-risk detection.** `SYNC_RECORD`, `INDEX_RECORD`, `CREATE_EXPORT`, `CHECK_DATA_FLOW`, `CHECK_RESTORE_ACCESS`, and backup rows must be converted into risks only when the evidence shows an active path at `audit_at`. Remediation order must put `DISABLE_DATA_FLOW`/`BLOCK_RESTORE` before dependent record changes.
10. **Output contract validation.** The final file needs exactly 518 rows, sorted `case_id`, valid JSON arrays, consecutive `step_no`, phase order `FINDING → REMEDIATION → VERIFICATION`, operation order inside each phase, empty `evidence_id` for future steps, and valid evidence IDs for findings/COMPLETE verification. This should be a deterministic validator, not an LLM check.
11. **Cost and latency.** Sending every case plus all evidence to Gemini would be wasteful. Deterministic parsing/linking should narrow each case to a small evidence bundle; the model should be used only for ambiguous intent, conflicting evidence, or unstructured artifact interpretation. Token usage must be logged for `code/evaluation/usage_report.md`.
12. **Dependency risk.** `better-sqlite3` is native and can complicate installs; PDF/OCR libraries vary in quality; `tesseract.js` is slower than a system binary. Add dependencies only after confirming they handle the actual evidence formats, and keep a deterministic fallback where possible.
