"""CSV table loaders: requests, identities, identity history, activity, rules."""

from __future__ import annotations

import csv
import os
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional

from . import config
from .util import norm_email, norm_name, norm_phone, parse_ts, ts_key


def _read(path: str) -> List[dict]:
    with open(path, newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def _dataset_path(name: str) -> str:
    return os.path.join(config.DATASET_DIR, name)


# ---------------------------------------------------------------------------
# Requests
# ---------------------------------------------------------------------------

@dataclass
class Request:
    case_id: str
    email: str
    requested_at: str
    reported_status: str
    reported_at: str
    audit_at: str
    request_text: str

    def to_dict(self) -> dict:
        return {
            "case_id": self.case_id,
            "email": self.email,
            "requested_at": self.requested_at,
            "reported_status": self.reported_status,
            "reported_at": self.reported_at,
            "audit_at": self.audit_at,
            "request_text": self.request_text,
        }


def load_requests(sample: bool = False) -> List[Request]:
    name = config.FILE_SAMPLE_REQUESTS if sample else config.FILE_REQUESTS
    rows = _read(_dataset_path(name))
    requests = []
    for row in rows:
        requests.append(Request(
            case_id=row["case_id"].strip(),
            email=row.get("email", "").strip(),
            requested_at=row.get("requested_at", "").strip(),
            reported_status=row.get("reported_status", "").strip(),
            reported_at=row.get("reported_at", "").strip(),
            audit_at=row.get("audit_at", "").strip(),
            request_text=row.get("request_text", "").strip(),
        ))
    requests.sort(key=lambda r: r.case_id)
    return requests


def load_sample_output() -> Dict[str, dict]:
    path = _dataset_path(config.FILE_SAMPLE_OUTPUT)
    if not os.path.exists(path):
        return {}
    out = {}
    for row in _read(path):
        out[row["case_id"].strip()] = row
    return out


# ---------------------------------------------------------------------------
# Identities
# ---------------------------------------------------------------------------

@dataclass
class Identity:
    user_id: str
    name: str
    email: str
    phone: str
    email_hash: str
    updated_at: str

    def identifiers(self) -> Dict[str, str]:
        return {
            "user_id": self.user_id,
            "name": self.name,
            "email": self.email,
            "phone": self.phone,
            "email_hash": self.email_hash,
        }

    def to_dict(self) -> dict:
        return self.identifiers() | {"updated_at": self.updated_at}


def load_identities() -> Dict[str, Identity]:
    rows = _read(_dataset_path(config.FILE_IDENTITIES))
    out: Dict[str, Identity] = {}
    for row in rows:
        identity = Identity(
            user_id=row["user_id"].strip(),
            name=row.get("name", "").strip(),
            email=row.get("email", "").strip(),
            phone=row.get("phone", "").strip(),
            email_hash=row.get("email_hash", "").strip(),
            updated_at=row.get("updated_at", "").strip(),
        )
        out[identity.user_id] = identity
    return out


@dataclass
class AuditEntry:
    audit_id: str
    user_id: str
    event_time: str
    field_name: str
    old_value: str
    new_value: str

    def to_dict(self) -> dict:
        return {
            "audit_id": self.audit_id,
            "user_id": self.user_id,
            "event_time": self.event_time,
            "field_name": self.field_name,
            "old_value": self.old_value,
            "new_value": self.new_value,
        }


def load_audit_log() -> List[AuditEntry]:
    rows = _read(_dataset_path(config.FILE_AUDIT_LOG))
    entries = []
    for row in rows:
        entries.append(AuditEntry(
            audit_id=row["audit_id"].strip(),
            user_id=row["user_id"].strip(),
            event_time=row.get("event_time", "").strip(),
            field_name=row.get("field_name", "").strip(),
            old_value=row.get("old_value", "").strip(),
            new_value=row.get("new_value", "").strip(),
        ))
    entries.sort(key=lambda e: (ts_key(e.event_time), e.audit_id))
    return entries


# ---------------------------------------------------------------------------
# System activity
# ---------------------------------------------------------------------------

@dataclass
class Activity:
    activity_id: str
    event_time: str
    event_type: str
    source_system: str
    target_system: str
    resource_id: str
    reported_result: str
    details: str

    def to_dict(self) -> dict:
        return {
            "activity_id": self.activity_id,
            "event_time": self.event_time,
            "event_type": self.event_type,
            "source_system": self.source_system,
            "target_system": self.target_system,
            "resource_id": self.resource_id,
            "reported_result": self.reported_result,
            "details": self.details,
        }


def load_activity() -> List[Activity]:
    rows = _read(_dataset_path(config.FILE_ACTIVITY))
    events = []
    for row in rows:
        events.append(Activity(
            activity_id=row["activity_id"].strip(),
            event_time=row.get("event_time", "").strip(),
            event_type=row.get("event_type", "").strip(),
            source_system=row.get("source_system", "").strip(),
            target_system=row.get("target_system", "").strip(),
            resource_id=row.get("resource_id", "").strip(),
            reported_result=row.get("reported_result", "").strip(),
            details=row.get("details", "").strip(),
        ))
    events.sort(key=lambda e: (ts_key(e.event_time), e.activity_id))
    return events


# ---------------------------------------------------------------------------
# Deletion rules
# ---------------------------------------------------------------------------

@dataclass
class Rule:
    rule_id: str
    data_category: str
    condition: str
    required_action: str

    def to_dict(self) -> dict:
        return {
            "rule_id": self.rule_id,
            "data_category": self.data_category,
            "condition": self.condition,
            "required_action": self.required_action,
        }


def load_rules() -> List[Rule]:
    rows = _read(_dataset_path(config.FILE_RULES))
    rules = [Rule(
        rule_id=row["rule_id"].strip(),
        data_category=row["data_category"].strip(),
        condition=row.get("condition", "").strip(),
        required_action=row["required_action"].strip(),
    ) for row in rows]
    rules.sort(key=lambda r: r.rule_id)
    return rules


def rules_by_category(rules: Iterable[Rule]) -> Dict[str, Rule]:
    return {rule.data_category: rule for rule in rules}


# ---------------------------------------------------------------------------
# Evidence manifest
# ---------------------------------------------------------------------------

@dataclass
class EvidenceFile:
    file_id: str
    file_path: str          # relative to dataset/
    origin: str
    captured_at: str

    @property
    def absolute_path(self) -> str:
        return os.path.join(config.DATASET_DIR, self.file_path)

    @property
    def suffix(self) -> str:
        return os.path.splitext(self.file_path)[1].lower()

    def to_dict(self) -> dict:
        return {
            "file_id": self.file_id,
            "file_path": self.file_path,
            "origin": self.origin,
            "captured_at": self.captured_at,
        }


def load_manifest() -> List[EvidenceFile]:
    rows = _read(_dataset_path(config.FILE_MANIFEST))
    files = [EvidenceFile(
        file_id=row["file_id"].strip(),
        file_path=row["file_path"].strip(),
        origin=row.get("origin", "").strip(),
        captured_at=row.get("captured_at", "").strip(),
    ) for row in rows]
    files.sort(key=lambda f: f.file_id)
    return files
