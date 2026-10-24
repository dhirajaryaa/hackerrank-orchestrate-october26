#!/usr/bin/env python3
"""Ghost Data Still Exists — dataset parser and context builder.

Usage
-----
    python3 code/main.py build                 # parse dataset -> build/
    python3 code/main.py build --case case_11  # print one case bundle
    python3 code/main.py predict               # write output.csv from the draft planner
    python3 code/main.py score                 # compare draft against sample_output.csv
    python3 code/main.py list-cases            # one line per case: status + resources

The parser never writes into `dataset/`; everything goes to `build/` or the
repository-root `output.csv`.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from typing import Dict, List

from ghostdata import config
from ghostdata.activity_index import build_activity_records, classify_requests
from ghostdata.context import build_case_context
from ghostdata.identity import IdentityResolver
from ghostdata.linker import Linker
from ghostdata.model import ObservationStore, Record
from ghostdata.parsers import parse_evidence
from ghostdata import tables


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

def load_dataset(verbose: bool = True) -> dict:
    """Read every participant-facing file and build the observation index."""
    requests = tables.load_requests(sample=False)
    sample_requests = tables.load_requests(sample=True)
    identities = tables.load_identities()
    audit_log = tables.load_audit_log()
    activity = tables.load_activity()
    rules = tables.load_rules()
    manifest = tables.load_manifest()
    sample_output = tables.load_sample_output()

    resolver = IdentityResolver(identities, audit_log)
    store = ObservationStore()

    # 1. Evidence files (SQL / JSON / LOG / TXT / PDF / PNG)
    for evidence in manifest:
        parse_evidence(evidence, store)
        if verbose:
            last = store.parse_log[-1]
            print(f"  {evidence.file_id}  {last['parser']:<14} "
                  f"{last['records']:>4} records  {evidence.file_path}",
                  file=sys.stderr)

    # 2. Activity claims
    activity_records = build_activity_records(activity)
    store.extend(activity_records)
    store.log_file("system_activity.csv", "system_activity.csv", "activity",
                   len(activity_records), status="ok",
                   detail=f"rows={len(activity)}")

    # 3. Link everything to people
    link_counts = Linker(resolver, store).run()

    indexed = {
        "requests": requests,
        "sample_requests": sample_requests,
        "identities": identities,
        "audit_log": audit_log,
        "activity": activity,
        "rules": rules,
        "manifest": manifest,
        "sample_output": sample_output,
        "resolver": resolver,
        "store": store,
        "link_counts": link_counts,
        "classifications": classify_requests(activity),
    }
    return indexed


def group_by_evidence(records: List[Record]) -> Dict[str, List[Record]]:
    groups: Dict[str, List[Record]] = {}
    for record in records:
        groups.setdefault(record.evidence_id, []).append(record)
    return groups


def build_contexts(indexed: dict) -> Dict[str, dict]:
    store = indexed["store"]
    groups = group_by_evidence(store.records)
    contexts = {}
    for request in indexed["requests"] + indexed["sample_requests"]:
        contexts[request.case_id] = build_case_context(
            request, indexed["resolver"], store, indexed["rules"], groups)
    return contexts


# ---------------------------------------------------------------------------
# Writers
# ---------------------------------------------------------------------------

def write_build(indexed: dict, contexts: Dict[str, dict]) -> None:
    os.makedirs(config.BUILD_DIR, exist_ok=True)
    store = indexed["store"]

    with open(os.path.join(config.BUILD_DIR, "records.jsonl"), "w",
              encoding="utf-8") as handle:
        for record in store.sorted_records():
            handle.write(json.dumps(record.to_dict(), ensure_ascii=False) + "\n")

    context_dir = os.path.join(config.BUILD_DIR, "contexts")
    os.makedirs(context_dir, exist_ok=True)
    for case_id, bundle in contexts.items():
        with open(os.path.join(context_dir, f"{case_id}.json"), "w",
                  encoding="utf-8") as handle:
            json.dump(bundle, handle, ensure_ascii=False, indent=1)

    status_counts: Dict[str, int] = {}
    for bundle in contexts.values():
        status = bundle["draft"]["deletion_status"]
        status_counts[status] = status_counts.get(status, 0) + 1

    summary = {
        "dataset": {
            "requests": len(indexed["requests"]),
            "sample_requests": len(indexed["sample_requests"]),
            "users": len(indexed["identities"]),
            "identity_changes": len(indexed["audit_log"]),
            "activity_rows": len(indexed["activity"]),
            "rules": len(indexed["rules"]),
            "evidence_files": len(indexed["manifest"]),
        },
        "observations": store.stats(),
        "linking": indexed["link_counts"],
        "draft_status_counts": status_counts,
        "parse_log": store.parse_log,
        "evidence_coverage": _coverage(indexed, contexts),
    }
    with open(os.path.join(config.BUILD_DIR, "index_summary.json"), "w",
              encoding="utf-8") as handle:
        json.dump(summary, handle, ensure_ascii=False, indent=2)
    print(f"\nWrote {config.BUILD_DIR}/records.jsonl, contexts/ and index_summary.json",
          file=sys.stderr)


def _coverage(indexed: dict, contexts: Dict[str, dict]) -> dict:
    per_evidence: Dict[str, int] = {}
    for bundle in contexts.values():
        for evidence_id in bundle["evidence_batch"]["evidence_ids"]:
            per_evidence[evidence_id] = per_evidence.get(evidence_id, 0) + 1
    empty = [cid for cid, b in contexts.items() if not b["state_at_audit"]]
    return {
        "cases_with_state": len(contexts) - len(empty),
        "cases_without_state": len(empty),
        "first_cases_without_state": empty[:20],
        "cases_per_evidence_file": dict(sorted(per_evidence.items())),
    }


def write_output(contexts: Dict[str, dict], path: str = config.OUTPUT_CSV) -> None:
    rows = []
    for case_id in sorted(contexts):
        bundle = contexts[case_id]
        rows.append({
            "case_id": case_id,
            "deletion_status": bundle["draft"]["deletion_status"],
            "steps_json": json.dumps(bundle["draft"]["steps_json"],
                                     separators=(",", ":"), ensure_ascii=False),
        })
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["case_id", "deletion_status",
                                                    "steps_json"])
        writer.writeheader()
        writer.writerows(rows)
    print(f"Wrote {path} ({len(rows)} rows)", file=sys.stderr)


# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------

def score_sample(indexed: dict, contexts: Dict[str, dict]) -> int:
    sample = indexed["sample_output"]
    if not sample:
        print("no sample_output.csv found", file=sys.stderr)
        return 1

    status_hits = 0
    exact_steps = 0
    total = 0
    for case_id in sorted(sample):
        golden = sample[case_id]
        bundle = contexts.get(case_id)
        if bundle is None:
            continue
        total += 1
        predicted_status = bundle["draft"]["deletion_status"]
        golden_status = golden["deletion_status"].strip()
        if predicted_status == golden_status:
            status_hits += 1

        golden_steps = json.loads(golden["steps_json"])
        predicted_steps = bundle["draft"]["steps_json"]
        if _same_steps(golden_steps, predicted_steps):
            exact_steps += 1
            marker = "EXACT"
        else:
            marker = "DIFF "
        print(f"{case_id}: golden={golden_status:<15} predicted={predicted_status:<15} "
              f"steps {len(golden_steps):>2}/{len(predicted_steps):<2} {marker}")
        if marker == "DIFF ":
            _explain(golden_steps, predicted_steps)

    print(f"\nstatus accuracy: {status_hits}/{total}")
    print(f"exact step lists: {exact_steps}/{total}")
    return 0


def _same_steps(golden: List[dict], predicted: List[dict]) -> bool:
    if len(golden) != len(predicted):
        return False
    fields = ("phase", "system_id", "resource_id", "operation", "state", "evidence_id")
    for left, right in zip(golden, predicted):
        for field in fields:
            if str(left.get(field, "")) != str(right.get(field, "")):
                return False
    return True


def _explain(golden: List[dict], predicted: List[dict]) -> None:
    key = lambda s: (s.get("operation"), s.get("system_id"), s.get("resource_id"),
                     s.get("evidence_id"))
    golden_keys = {key(s) for s in golden}
    predicted_keys = {key(s) for s in predicted}
    missing = sorted(golden_keys - predicted_keys)
    extra = sorted(predicted_keys - golden_keys)
    if missing:
        print(f"        missing: {missing[:4]}")
    if extra:
        print(f"        extra  : {extra[:4]}")


def list_cases(contexts: Dict[str, dict]) -> None:
    for case_id in sorted(contexts):
        bundle = contexts[case_id]
        resources = bundle["state_at_audit"]
        systems = ",".join(sorted({r["system"] for r in resources})) or "-"
        print(f"{case_id}  {bundle['draft']['deletion_status']:<15} "
              f"resources={len(resources):<2} {systems}")


def print_case(contexts: Dict[str, dict], case_id: str) -> None:
    bundle = contexts.get(case_id)
    if bundle is None:
        print(f"unknown case {case_id}", file=sys.stderr)
        return
    print(json.dumps(bundle, ensure_ascii=False, indent=2))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="?", default="build",
                        choices=["build", "predict", "score", "list-cases", "case"])
    parser.add_argument("--case", dest="case_id", help="case id for `case` command")
    parser.add_argument("--quiet", action="store_true", help="suppress parse progress")
    args = parser.parse_args(argv)

    print("Parsing dataset...", file=sys.stderr)
    indexed = load_dataset(verbose=not args.quiet)
    print("Building per-case context bundles...", file=sys.stderr)
    contexts = build_contexts(indexed)
    write_build(indexed, contexts)

    if args.command == "predict":
        write_output(contexts)
    elif args.command == "score":
        return score_sample(indexed, contexts)
    elif args.command == "list-cases":
        list_cases(contexts)
    elif args.command == "case":
        if not args.case_id:
            print("--case is required", file=sys.stderr)
            return 2
        print_case(contexts, args.case_id)
    return 0


if __name__ == "__main__":
    sys.exit(main())
