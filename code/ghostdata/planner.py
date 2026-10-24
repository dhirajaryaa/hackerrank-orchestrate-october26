"""Deterministic draft planner.

Given the resolved state of every resource attached to a subject at ``audit_at``,
this module emits the ordered ``steps_json`` array described by the challenge:

    FINDING  -> REMEDIATION -> VERIFICATION

Within a phase steps follow the operation order published in
``problem_statement.md``, then ``system_id``, then ``resource_id``.

The planner is intentionally mechanical: it encodes the mapping from
``deletion_rules.csv`` to the allowed operations, and nothing else. Any judgement
that needs an LLM (identity ambiguity, conflicting evidence, intent) happens
before this module runs.
"""

from __future__ import annotations

from typing import Dict, Iterable, List

from .config import (
    CATEGORY_ACTIONS,
    OPERATION_ORDER,
    PHASE_ORDER,
)

# Resource state -> (finding op, remediation op, verification op).
# A `None` finding means "nothing to report, verify only".
STATE_PLAN = {
    "USER_PROFILE": {
        "ABSENT": (None, None, "VERIFY_RECORD_ABSENT"),
        "PRESENT": ("REPORT_REMAINING_RECORD", "DELETE_RECORD", "VERIFY_RECORD_ABSENT"),
        "IDENTIFIABLE": ("REPORT_REMAINING_RECORD", "DELETE_RECORD", "VERIFY_RECORD_ABSENT"),
        "REDACTED": (None, None, "VERIFY_RECORD_ABSENT"),
    },
    "SEARCH_INDEX_ENTRY": {
        "ABSENT": (None, None, "VERIFY_RECORD_ABSENT"),
        "PRESENT": ("REPORT_REMAINING_RECORD", "DELETE_RECORD", "VERIFY_RECORD_ABSENT"),
    },
    "CACHE_ENTRY": {
        "ABSENT": (None, None, "VERIFY_RECORD_ABSENT"),
        "PRESENT": ("REPORT_REMAINING_RECORD", "DELETE_RECORD", "VERIFY_RECORD_ABSENT"),
    },
    "USER_EXPORT": {
        "ABSENT": (None, None, "VERIFY_RECORD_ABSENT"),
        "PRESENT": ("REPORT_REMAINING_RECORD", "DELETE_RECORD", "VERIFY_RECORD_ABSENT"),
    },
    "MARKETING_PROFILE": {
        "ABSENT": (None, None, "VERIFY_RECORD_ABSENT"),
        "PRESENT": ("REPORT_REMAINING_RECORD", "DELETE_RECORD", "VERIFY_RECORD_ABSENT"),
    },
    "SUPPORT_ATTACHMENT": {
        "ABSENT": (None, None, "VERIFY_RECORD_ABSENT"),
        "PRESENT": ("REPORT_REMAINING_RECORD", "DELETE_RECORD", "VERIFY_RECORD_ABSENT"),
    },
    "SUPPORT_MESSAGE": {
        "ABSENT": (None, None, "VERIFY_RECORD_ABSENT"),
        "REDACTED": (None, None, "VERIFY_RECORD_REDACTED"),
        "PRESENT": ("REPORT_EXPOSED_PII", "REDACT_RECORD", "VERIFY_RECORD_REDACTED"),
        "IDENTIFIABLE": ("REPORT_EXPOSED_PII", "REDACT_RECORD", "VERIFY_RECORD_REDACTED"),
    },
    "ANALYTICS_PROFILE": {
        "ABSENT": (None, None, "VERIFY_RECORD_ABSENT"),
        "ANONYMIZED": (None, None, "VERIFY_RECORD_ANONYMIZED"),
        "PRESENT": ("REPORT_EXPOSED_PII", "ANONYMIZE_RECORD", "VERIFY_RECORD_ANONYMIZED"),
        "IDENTIFIABLE": ("REPORT_EXPOSED_PII", "ANONYMIZE_RECORD", "VERIFY_RECORD_ANONYMIZED"),
    },
    "PRODUCT_TELEMETRY": {
        "ABSENT": (None, None, "VERIFY_RECORD_ABSENT"),
        "ANONYMIZED": (None, None, "VERIFY_RECORD_ANONYMIZED"),
        "PRESENT": ("REPORT_EXPOSED_PII", "ANONYMIZE_RECORD", "VERIFY_RECORD_ANONYMIZED"),
    },
    "EMAIL_DELIVERY_LOG": {
        "ABSENT": (None, None, "VERIFY_RECORD_ABSENT"),
        "REDACTED": (None, None, "VERIFY_RECORD_REDACTED"),
        "PRESENT": ("REPORT_EXPOSED_PII", "REDACT_RECORD", "VERIFY_RECORD_REDACTED"),
    },
    "SECURITY_AUDIT_LOG": {
        "PRESENT": (None, None, "VERIFY_RECORD_PRESENT"),
        "RETAINED": (None, None, "VERIFY_RECORD_PRESENT"),
    },
    "LEGAL_HOLD_RECORD": {
        "PRESENT": (None, None, "VERIFY_RECORD_PRESENT"),
        "RETAINED": (None, None, "VERIFY_RECORD_PRESENT"),
    },
    "BACKUP_ARCHIVE": {
        "ABSENT": (None, None, "VERIFY_RECORD_ABSENT"),
        "ACTIVE": ("REPORT_RESTORE_RISK", "BLOCK_RESTORE", "VERIFY_RESTORE_BLOCKED"),
        "BLOCKED": (None, None, "VERIFY_RESTORE_BLOCKED"),
    },
    "DATA_FLOW": {
        "ABSENT": (None, None, "VERIFY_RECORD_ABSENT"),
        "ACTIVE": ("REPORT_ACTIVE_DATA_FLOW", "DISABLE_DATA_FLOW", "VERIFY_DATA_FLOW_DISABLED"),
        "DISABLED": (None, None, "VERIFY_DATA_FLOW_DISABLED"),
    },
    "ACCOUNT_TOMBSTONE": {
        "ABSENT": (None, None, "VERIFY_RECORD_ABSENT"),
        "REDACTED": (None, None, "VERIFY_RECORD_REDACTED"),
        "PRESENT": ("REPORT_EXPOSED_PII", "REDACT_RECORD", "VERIFY_RECORD_REDACTED"),
        "IDENTIFIABLE": ("REPORT_EXPOSED_PII", "REDACT_RECORD", "VERIFY_RECORD_REDACTED"),
    },
    "SECONDARY_IDENTIFIER": {
        "ABSENT": (None, None, "VERIFY_RECORD_ABSENT"),
        "PRESENT": ("REPORT_REMAINING_RECORD", "DELETE_RECORD", "VERIFY_RECORD_ABSENT"),
    },
}


def _plan_for(category: str, state: str):
    table = STATE_PLAN.get(category)
    if table is None:
        fallback = CATEGORY_ACTIONS.get(category)
        if fallback is None:
            return None, None, None
        finding, remediation, verification = fallback
        if state in ("REDACTED",):
            finding, remediation = None, None
        elif state in ("ANONYMIZED",):
            finding, remediation = None, None
        elif state in ("DISABLED", "BLOCKED"):
            finding, remediation = None, None
        elif state == "ABSENT":
            finding, remediation = None, None
        return finding, remediation, verification
    return table.get(state, (None, None, None))


def build_steps(resources: Iterable[dict], status: str,
                evidence_for_verification: bool = True) -> List[dict]:
    """Turn resolved resources into an ordered step list.

    ``resources`` items need: ``system``, ``resource_id``, ``category``,
    ``state``, ``evidence_id``.
    """
    if status == "NOT_APPLICABLE":
        return []

    planned: List[dict] = []
    for resource in resources:
        category = resource.get("category", "UNKNOWN")
        state = resource.get("state", "PRESENT")
        finding, remediation, verification = _plan_for(category, state)
        if not verification:
            continue
        base = {
            "system_id": resource["system"],
            "resource_id": resource["resource_id"],
        }
        cite = resource.get("evidence_id", "") if status == "COMPLETE" else ""
        if finding:
            planned.append({**base, "phase": "FINDING", "operation": finding,
                            "state": "PRESENT" if finding.startswith("REPORT_REMAINING")
                            else ("ACTIVE" if finding.startswith("REPORT_ACTIVE")
                                  else ("ACTIVE" if finding == "REPORT_RESTORE_RISK" else "PRESENT")),
                            "evidence_id": resource.get("evidence_id", "")})
        if remediation:
            planned.append({**base, "phase": "REMEDIATION", "operation": remediation,
                            "state": _state_for(remediation), "evidence_id": ""})
        planned.append({**base, "phase": "VERIFICATION", "operation": verification,
                        "state": _state_for(verification),
                        "evidence_id": cite if evidence_for_verification else ""})

    planned.sort(key=lambda s: (
        PHASE_ORDER[s["phase"]],
        OPERATION_ORDER[s["operation"]],
        s["system_id"],
        s["resource_id"],
    ))
    for index, step in enumerate(planned, start=1):
        step["step_no"] = index
    return [{
        "step_no": step["step_no"],
        "phase": step["phase"],
        "system_id": step["system_id"],
        "resource_id": step["resource_id"],
        "operation": step["operation"],
        "state": step["state"],
        "evidence_id": step["evidence_id"],
    } for step in planned]


def _state_for(operation: str) -> str:
    return {
        "DISABLE_DATA_FLOW": "DISABLED",
        "BLOCK_RESTORE": "BLOCKED",
        "DELETE_RECORD": "ABSENT",
        "REDACT_RECORD": "REDACTED",
        "ANONYMIZE_RECORD": "ANONYMIZED",
        "VERIFY_RECORD_ABSENT": "ABSENT",
        "VERIFY_RECORD_PRESENT": "PRESENT",
        "VERIFY_RECORD_REDACTED": "REDACTED",
        "VERIFY_RECORD_ANONYMIZED": "ANONYMIZED",
        "VERIFY_DATA_FLOW_DISABLED": "DISABLED",
        "VERIFY_RESTORE_BLOCKED": "BLOCKED",
    }.get(operation, "PRESENT")
