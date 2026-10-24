"""JSON evidence parser.

Three JSON shapes appear in the dataset:

1. ``{"snapshots": [{"captured_at", "data_store", "collection", "records": [...]}]}``
   — records-assurance snapshot bundles.
2. ``{"service_exports": {"<system>": {"<collection>": [...]}}}``
   — the point-in-time readback export used for a batch of cases.
3. ``{"records": [...], "captured_at"|"exported_at"}``
   — single-collection stores (exports, analytics reports, connector configs).

In every case the payload keys are stable enough to normalize generically: a
``resource_id`` plus a handful of person-identifying fields.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Iterable, List, Tuple

from ..config import STATE_ABSENT, STATE_PRESENT
from ..model import Record, guess_record_type, guess_system
from ..tables import EvidenceFile
from ..util import norm_email, norm_name, norm_phone

PERSON_KEYS = (
    "customer_reference", "user_id", "subject_reference", "full_name", "name",
    "email", "phone", "email_hash", "requester_name", "requester_email",
    "requester_phone", "owner_email", "owner_phone", "customer_email",
    "display_name", "profile", "document", "subject_selector", "lookup_value",
)

# Fields that directly identify the person. A stable ``user_NN`` reference is
# deliberately excluded: an account tombstone that keeps only that reference is
# compliant, so it must not be read as "identifiers still present".
DIRECT_IDENTIFIER_KEYS = (
    "full_name", "name", "email", "phone", "email_hash", "requester_name",
    "requester_email", "requester_phone", "owner_email", "owner_phone",
    "customer_email", "display_name",
)

TEXT_KEYS = ("message_excerpt", "message_text", "body", "content", "note")

REDACTION_MARKERS = ("[redacted]", "<redacted>", "redacted", "***", "[deleted]")

STATE_KEYS = ("account_status", "result", "status_code", "enabled",
              "restore_allowed", "last_delivery_status", "state", "status")


def parse(evidence: EvidenceFile) -> Tuple[List[Record], str]:
    with open(evidence.absolute_path, encoding="utf-8") as handle:
        document = json.load(handle)

    captured_at = (document.get("captured_at") or document.get("exported_at")
                   or evidence.captured_at)
    records: List[Record] = []
    shapes = []

    snapshots = document.get("snapshots")
    if isinstance(snapshots, list):
        shapes.append(f"snapshots={len(snapshots)}")
        for snapshot in snapshots:
            records.extend(_parse_snapshot(evidence, snapshot,
                                           snapshot.get("captured_at") or captured_at))

    service_exports = document.get("service_exports")
    if isinstance(service_exports, dict):
        shapes.append(f"services={len(service_exports)}")
        for system, collections in service_exports.items():
            if not isinstance(collections, dict):
                continue
            for collection, rows in collections.items():
                if not isinstance(rows, list):
                    continue
                for row in rows:
                    records.extend(_row_records(evidence, system, collection, row,
                                                document.get("exported_at") or captured_at))

    rows = document.get("records")
    if isinstance(rows, list):
        shapes.append(f"records={len(rows)}")
        default_system = document.get("system") or ""
        for row in rows:
            system = row.get("system") or default_system
            collection = row.get("collection") or document.get("collection") or ""
            records.extend(_row_records(evidence, system, collection, row, captured_at))

    if not shapes:
        shapes.append("unrecognized")
    return records, " ".join(shapes)


def _parse_snapshot(evidence: EvidenceFile, snapshot: dict, captured_at: str) -> List[Record]:
    system = snapshot.get("data_store") or ""
    collection = snapshot.get("collection") or ""
    out = []
    for row in snapshot.get("records") or []:
        out.extend(_row_records(evidence, system, collection, row, captured_at))
    return out


def _identifiers(row: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for key in PERSON_KEYS:
        value = row.get(key)
        if isinstance(value, dict):
            nested = {k: v for k, v in value.items() if v not in (None, "")}
            if nested:
                out[key] = nested
        elif value not in (None, "", "null"):
            out[key] = value
    return out


def _has_direct_identifier(row: Dict[str, Any]) -> bool:
    for key in DIRECT_IDENTIFIER_KEYS:
        value = row.get(key)
        if value not in (None, "", "null"):
            return True
    for key in ("profile", "document"):
        nested = row.get(key)
        if isinstance(nested, dict):
            for sub in DIRECT_IDENTIFIER_KEYS:
                if nested.get(sub) not in (None, "", "null"):
                    return True
    return False


def _text_redacted(row: Dict[str, Any]) -> bool:
    for key in TEXT_KEYS:
        value = row.get(key)
        if isinstance(value, str):
            lowered = value.strip().lower()
            if any(marker in lowered for marker in REDACTION_MARKERS):
                return True
    return False


def _state(row: Dict[str, Any]) -> str:
    status = str(row.get("account_status") or "").upper()
    if status in ("DELETED", "TOMBSTONED"):
        # A tombstone is compliant only when the stable reference survives and
        # the direct identifiers are gone.
        return STATE_PRESENT if _has_direct_identifier(row) else "REDACTED"
    if _text_redacted(row):
        return "REDACTED"
    if "result" in row:
        token = str(row.get("result") or "").upper()
        if token in ("HIT", "FOUND", "PRESENT"):
            return STATE_PRESENT
        if token in ("MISS", "NOT_FOUND", "ABSENT"):
            return STATE_ABSENT
    if "hits" in row:
        total = (row.get("hits") or {}).get("total")
        if total in (0, "0"):
            return STATE_ABSENT
        return STATE_PRESENT
    if "status_code" in row:
        return STATE_ABSENT if str(row.get("status_code")) == "404" else STATE_PRESENT
    if "enabled" in row:
        return "ACTIVE" if row.get("enabled") in (True, 1, "1", "true") else "DISABLED"
    if "restore_allowed" in row:
        return "ACTIVE" if row.get("restore_allowed") in (True, 1, "1", "true") else "BLOCKED"
    if "last_delivery_status" in row:
        token = str(row.get("last_delivery_status") or "").lower()
        if token in ("stopped", "disabled"):
            return "DISABLED"
    return STATE_PRESENT


def _flatten_hits(row: Dict[str, Any]) -> Dict[str, Any]:
    """Promote ``hits.documents[0]`` so search hits keep their identifiers."""
    hits = row.get("hits")
    if not isinstance(hits, dict):
        return row
    documents = hits.get("documents") or []
    if not documents or not isinstance(documents[0], dict):
        return row
    merged = dict(documents[0])
    for key, value in row.items():
        if key != "hits":
            merged.setdefault(key, value)
    return merged


def _row_records(evidence: EvidenceFile, system: str, collection: str,
                 row: Dict[str, Any], captured_at: str) -> List[Record]:
    if not isinstance(row, dict):
        return []
    # `captured_at` is the manifest timestamp: evidence created after a case's
    # `audit_at` must never influence that case, even if the payload claims an
    # earlier observation time.
    row = _flatten_hits(row)
    resource_id = str(row.get("resource_id") or "")
    resolved_system = system or guess_system(resource_id)
    record_type = guess_record_type(resolved_system, collection,
                                    explicit=row.get("record_type"))
    observed_at = (row.get("observed_at") or row.get("recorded_at")
                   or row.get("updated_at") or captured_at)
    link_keys = row.get("lookup_key") or row.get("query") or row.get("lookup_value")
    return [Record(
        evidence_id=evidence.file_id,
        evidence_kind="manifest",
        captured_at=evidence.captured_at,
        observed_at=observed_at,
        system=resolved_system,
        resource_id=resource_id,
        record_type=record_type,
        state=_state(row),
        identifiers=_identifiers(row),
        link_keys=[link_keys] if isinstance(link_keys, str) else [],
        payload=row,
        parser="json_records",
        source_path=evidence.file_path,
    )]

