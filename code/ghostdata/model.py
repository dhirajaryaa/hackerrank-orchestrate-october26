"""Normalized data model: one `Record` per observation of one resource."""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional

from .config import (
    COLLECTION_TO_RECORD_TYPE,
    PREFIX_TO_SYSTEM,
    RECORD_TYPE_TO_CATEGORY,
    SYSTEM_TO_CATEGORY,
)
from .util import ts_key


@dataclass
class Record:
    """A single observed state of a single resource.

    A Record is intentionally flat and JSON-serializable: it is the unit that
    gets embedded into a per-case prompt or written to `build/records.jsonl`.
    """

    evidence_id: str            # file_id / activity_id / audit_id
    evidence_kind: str          # "manifest" | "activity" | "identity_audit"
    captured_at: Optional[str]  # when the evidence was captured
    observed_at: Optional[str]  # when the resource state was observed
    system: str
    resource_id: str
    record_type: str
    state: str
    identifiers: Dict[str, Any] = field(default_factory=dict)
    subject_refs: List[str] = field(default_factory=list)
    link_keys: List[str] = field(default_factory=list)   # explicit lookup keys
    payload: Dict[str, Any] = field(default_factory=dict)
    parser: str = ""
    source_path: str = ""
    notes: List[str] = field(default_factory=list)
    # Filled in by `linker.Linker`.
    subject_users: List[str] = field(default_factory=list)
    link_method: str = "none"

    # -- derived -----------------------------------------------------------
    @property
    def category(self) -> str:
        if self.record_type in RECORD_TYPE_TO_CATEGORY:
            return RECORD_TYPE_TO_CATEGORY[self.record_type]
        return SYSTEM_TO_CATEGORY.get(self.system, "UNKNOWN")

    @property
    def sort_key(self):
        return (ts_key(self.observed_at or self.captured_at), self.system,
                self.resource_id, self.evidence_id)

    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data["category"] = self.category
        return data


def guess_system(resource_id: str, default: str = "unknown_system") -> str:
    if not resource_id:
        return default
    prefix = resource_id.rsplit("_", 1)[0]
    if prefix in PREFIX_TO_SYSTEM:
        return PREFIX_TO_SYSTEM[prefix]
    for key, system in PREFIX_TO_SYSTEM.items():
        if resource_id.startswith(key + "_"):
            return system
    return default


# Identifier fields that make a record directly attributable to a person. A
# surviving stable ``user_NN`` reference is deliberately absent: a compliant
# tombstone keeps exactly that.
DIRECT_IDENTIFIER_FIELDS = (
    "email", "phone", "email_hash", "full_name", "name", "display_name",
    "requester_email", "requester_phone", "requester_name", "owner_email",
    "owner_phone", "customer_email", "matched_value",
)


def direct_identifiers(record: "Record") -> Dict[str, Any]:
    found = {}
    for key, value in (record.identifiers or {}).items():
        if key in DIRECT_IDENTIFIER_FIELDS and value not in (None, "", "null"):
            found[key] = value
        elif isinstance(value, dict):
            for sub_key, sub_value in value.items():
                if sub_key in DIRECT_IDENTIFIER_FIELDS and sub_value not in (None, "", "null"):
                    found[f"{key}.{sub_key}"] = sub_value
    return found


def refine_state(record: "Record") -> str:
    """Derive the *policy-relevant* state of a record from its category.

    Source systems report existence ("FOUND", ``rows=1``, HTTP 200) but the
    deletion policy cares about identifier exposure. A support message that
    still exists with no requester identifiers is already ``REDACTED``; an
    analytics profile that still exists with no identifiers is already
    ``ANONYMIZED``. Deriving this here keeps every parser simple and makes the
    same rule apply to SQL, JSON, logs, and text evidence alike.
    """
    state = record.state
    category = record.category
    has_direct = bool(direct_identifiers(record))
    # `ACTIVE` on a plain record system only means "the sync touched it"; the
    # record itself just exists. Reserve ACTIVE for processes and archives.
    if state == "ACTIVE" and category not in ("DATA_FLOW", "BACKUP_ARCHIVE"):
        state = "PRESENT"
    if category in ("SUPPORT_MESSAGE",):
        if state in ("PRESENT", "IDENTIFIABLE"):
            return "IDENTIFIABLE" if has_direct else "REDACTED"
    elif category in ("ANALYTICS_PROFILE", "PRODUCT_TELEMETRY"):
        if state in ("PRESENT", "IDENTIFIABLE"):
            return "IDENTIFIABLE" if has_direct else "ANONYMIZED"
    elif category in ("EMAIL_DELIVERY_LOG", "ACCOUNT_TOMBSTONE"):
        if state == "PRESENT":
            return "IDENTIFIABLE" if has_direct else "REDACTED"
    return state


def guess_record_type(system: str, collection: Optional[str] = None,
                      explicit: Optional[str] = None) -> str:
    if explicit:
        token = str(explicit).strip().upper()
        if token in RECORD_TYPE_TO_CATEGORY:
            return token
    if collection:
        for name, rtype in COLLECTION_TO_RECORD_TYPE.items():
            if name == collection or collection.startswith(name):
                return rtype
    return SYSTEM_TO_CATEGORY.get(system, "UNKNOWN")


class ObservationStore:
    """In-memory index of every parsed Record."""

    def __init__(self) -> None:
        self.records: List[Record] = []
        self.parse_log: List[Dict[str, Any]] = []

    # -- mutation ----------------------------------------------------------
    def add(self, record: Record) -> None:
        self.records.append(record)

    def extend(self, records) -> None:
        for record in records:
            self.add(record)

    def log_file(self, file_id: str, path: str, parser: str, count: int,
                 status: str = "ok", detail: str = "") -> None:
        self.parse_log.append({
            "file_id": file_id,
            "path": path,
            "parser": parser,
            "records": count,
            "status": status,
            "detail": detail,
        })

    # -- queries -----------------------------------------------------------
    def sorted_records(self) -> List[Record]:
        return sorted(self.records, key=lambda r: r.sort_key)

    def by_resource(self) -> Dict[tuple, List[Record]]:
        index: Dict[tuple, List[Record]] = {}
        for record in self.records:
            index.setdefault((record.system, record.resource_id), []).append(record)
        for bucket in index.values():
            bucket.sort(key=lambda r: r.sort_key)
        return index

    def stats(self) -> Dict[str, Any]:
        systems: Dict[str, int] = {}
        types: Dict[str, int] = {}
        states: Dict[str, int] = {}
        parsers: Dict[str, int] = {}
        for record in self.records:
            systems[record.system] = systems.get(record.system, 0) + 1
            types[record.record_type] = types.get(record.record_type, 0) + 1
            states[record.state] = states.get(record.state, 0) + 1
            parsers[record.parser] = parsers.get(record.parser, 0) + 1
        return {
            "records": len(self.records),
            "distinct_resources": len({(r.system, r.resource_id) for r in self.records}),
            "by_system": dict(sorted(systems.items(), key=lambda kv: -kv[1])),
            "by_record_type": dict(sorted(types.items(), key=lambda kv: -kv[1])),
            "by_state": dict(sorted(states.items(), key=lambda kv: -kv[1])),
            "by_parser": dict(sorted(parsers.items(), key=lambda kv: -kv[1])),
        }
