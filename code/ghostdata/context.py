"""Per-case context bundle.

The whole point of this module is token economy: instead of shipping the dataset
(≈5 MB of CSV + 94 evidence files) to a model, we ship one small JSON object per
case containing only what that case actually needs:

* the request + intent verdict,
* the resolved identity (current + historical identifiers),
* the **latest state at `audit_at`** for every resource that provably belongs to
  the subject,
* the activity claims touching those resources (clearly marked as claims),
* the applicable rows of `deletion_rules.csv`,
* evidence that exists but was captured after `audit_at` (excluded, but listed so
  the exclusion is auditable),
* the co-subjects and unattributed resources of the same evidence batch, which is
  what makes identity-by-elimination possible.

Bundles are stable, sorted, and self-contained.
"""

from __future__ import annotations

from typing import Dict, Iterable, List, Optional

from . import config
from .activity_index import is_state_bearing
from .identity import IdentityResolver
from .model import ObservationStore, Record, refine_state
from .planner import build_steps
from .request_intent import classify as classify_intent
from .tables import Request, Rule
from .util import parse_ts, ts_key

# kebab-case systems that should not be reported as the resource system
NON_RESOURCE_SYSTEMS = {"evidence_document", "evidence_screenshot", "unknown_system"}


def _before(value: Optional[str], cutoff: Optional[str]) -> bool:
    if cutoff is None:
        return True
    moment = parse_ts(value)
    limit = parse_ts(cutoff)
    if moment is None:
        return False
    return moment <= limit


def latest_states(records: Iterable[Record], cutoff: str) -> Dict[tuple, dict]:
    """Collapse every observation into the latest state per resource."""
    latest: Dict[tuple, dict] = {}
    for record in records:
        if record.system in NON_RESOURCE_SYSTEMS:
            continue
        if not _before(record.observed_at or record.captured_at, cutoff):
            continue
        if not is_state_bearing(record):
            continue
        state = refine_state(record)
        key = (record.system, record.resource_id)
        entry = latest.get(key)
        if entry is None:
            latest[key] = {
                "system": record.system,
                "resource_id": record.resource_id,
                "category": record.category,
                "record_type": record.record_type,
                "state": state,
                "raw_state": record.state,
                "observed_at": record.observed_at or record.captured_at,
                "evidence_id": record.evidence_id,
                "evidence_kind": record.evidence_kind,
                "link_method": record.link_method,
                "identifiers": record.identifiers,
                "history": [{
                    "state": state,
                    "raw_state": record.state,
                    "observed_at": record.observed_at or record.captured_at,
                    "evidence_id": record.evidence_id,
                    "kind": record.evidence_kind,
                }],
            }
            continue
        entry["history"].append({
            "state": state,
            "raw_state": record.state,
            "observed_at": record.observed_at or record.captured_at,
            "evidence_id": record.evidence_id,
            "kind": record.evidence_kind,
        })
        # Prefer the most recent observation; break ties in favour of manifest
        # evidence over an activity claim.
        current = entry["observed_at"]
        candidate_time = record.observed_at or record.captured_at
        newer = ts_key(candidate_time) > ts_key(current)
        same = ts_key(candidate_time) == ts_key(current)
        if newer or (same and entry["evidence_kind"] == "activity"
                     and record.evidence_kind == "manifest"):
            entry.update({
                "category": record.category,
                "record_type": record.record_type,
                "state": state,
                "raw_state": record.state,
                "observed_at": candidate_time,
                "evidence_id": record.evidence_id,
                "evidence_kind": record.evidence_kind,
                "link_method": record.link_method,
                "identifiers": record.identifiers,
            })
    for entry in latest.values():
        entry["history"].sort(key=lambda h: ts_key(h["observed_at"]))
    return latest


def build_case_context(request: Request, resolver: IdentityResolver,
                       store: ObservationStore, rules: List[Rule],
                       groups: Dict[str, List[Record]]) -> dict:
    resolution = resolver.resolve_case(request)
    intent = classify_intent(request.request_text)
    cutoff = request.audit_at

    user_records: List[Record] = []
    excluded: List[Record] = []
    if resolution.user_id:
        for record in store.records:
            if resolution.user_id not in record.subject_users:
                continue
            if _before(record.captured_at, cutoff) and _before(
                    record.observed_at or record.captured_at, cutoff):
                user_records.append(record)
            else:
                excluded.append(record)

    states = latest_states(user_records, cutoff)
    resources = sorted(states.values(), key=lambda r: (r["system"], r["resource_id"]))

    # Activity claims that touch the subject's resources.
    resource_ids = {r["resource_id"] for r in resources}
    claims = [
        record.payload for record in user_records
        if record.evidence_kind == "activity" and record.resource_id in resource_ids
    ]
    claims.sort(key=lambda c: (ts_key(c.get("event_time")), c.get("activity_id")))

    # Evidence-batch companions, used for elimination reasoning.
    evidence_ids = sorted({r.evidence_id for r in user_records})
    co_subjects = set()
    unattributed: Dict[str, List[str]] = {}
    for evidence_id in evidence_ids:
        siblings = groups.get(evidence_id, [])
        for sibling in siblings:
            others = set(sibling.subject_users) - {resolution.user_id}
            co_subjects |= others
            if not sibling.subject_users and sibling.record_type not in (
                    "DOCUMENT", "SCREENSHOT", "REFERENCE"):
                unattributed.setdefault(evidence_id, [])
                if sibling.resource_id not in unattributed[evidence_id]:
                    unattributed[evidence_id].append(sibling.resource_id)

    categories = sorted({r["category"] for r in resources})
    applicable_rules = [
        rule.to_dict() for rule in rules if rule.data_category in categories
    ]

    findings = [r for r in resources if _has_finding(r)]
    status = "NOT_APPLICABLE" if not intent.is_deletion else (
        "INCOMPLETE" if findings else "COMPLETE")

    plan_resources = [_plan_view(r) for r in resources]
    steps = build_steps(plan_resources, status)

    bundle = {
        "case": {
            "case_id": request.case_id,
            "audit_at": request.audit_at,
            "requested_at": request.requested_at,
            "reported_status": request.reported_status,
            "reported_at": request.reported_at,
            "email_supplied": request.email,
            "request_text": request.request_text,
        },
        "intent": intent.to_dict(),
        "identity": resolution.to_dict(),
        "state_at_audit": resources,
        "activity_claims": claims,
        "rules": applicable_rules,
        "evidence_batch": {
            "evidence_ids": evidence_ids,
            "co_subjects": sorted(co_subjects),
            "unattributed_resources": {k: v for k, v in sorted(unattributed.items())},
        },
        "excluded_after_audit": [
            {
                "evidence_id": r.evidence_id,
                "system": r.system,
                "resource_id": r.resource_id,
                "state": r.state,
                "captured_at": r.captured_at,
                "observed_at": r.observed_at,
            }
            for r in sorted(excluded, key=lambda r: r.sort_key)[:20]
        ],
        "draft": {
            "deletion_status": status,
            "steps_json": steps,
        },
    }
    return bundle


def _has_finding(resource: dict) -> bool:
    category = resource["category"]
    state = resource["state"]
    if category in ("SECURITY_AUDIT_LOG", "LEGAL_HOLD_RECORD"):
        return False
    if state in ("ABSENT", "REDACTED", "ANONYMIZED", "DISABLED", "BLOCKED",
                 "RETAINED"):
        return False
    return category in config.CATEGORY_ACTIONS and \
        config.CATEGORY_ACTIONS[category][0] is not None


def _plan_view(resource: dict) -> dict:
    return {
        "system": resource["system"],
        "resource_id": resource["resource_id"],
        "category": resource["category"],
        "state": resource["state"],
        "evidence_id": resource["evidence_id"]
        if resource["evidence_kind"] == "manifest" else "",
    }
