"""`system_activity.csv` -> normalized claim records.

The activity stream is a claim log, not proof: `DELETE_RECORD / SUCCESS` says the
workflow *reported* success. The spec is explicit that reported statuses and
operation results are claims, so every record produced here is tagged
``evidence_kind="activity"`` and carries ``claim=True`` in its notes.

Two event families carry structure rather than noise:

* ``LINK_RESOURCE_IDENTITY`` — the only activity rows that state which person a
  resource belongs to, so they are promoted to identity links.
* ``CLASSIFY_REQUEST`` — the privacy intake's own statement that a request was
  *not* a deletion request.
"""

from __future__ import annotations

from typing import Dict, List, Tuple

from .config import PREFIX_TO_SYSTEM
from .model import Record, guess_record_type, guess_system
from .tables import Activity
from .util import find_emails, find_user_refs, first_of

# event_type -> (record_type, state_on_success, state_on_failure)
EVENT_MAP: Dict[str, Tuple[str, str, str]] = {
    "DELETE_RECORD": ("__same__", "ABSENT", "PRESENT"),
    "REDACT_RECORD": ("__same__", "REDACTED", "PRESENT"),
    "ANONYMIZE_RECORD": ("__same__", "ANONYMIZED", "PRESENT"),
    "DISABLE_DATA_FLOW": ("DATA_FLOW", "DISABLED", "ACTIVE"),
    "BLOCK_RESTORE": ("BACKUP_ARCHIVE", "BLOCKED", "ACTIVE"),
    "RETAIN_RECORD": ("__same__", "RETAINED", "RETAINED"),
    "RESTORE_BACKUP": ("BACKUP_ARCHIVE", "ACTIVE", "ACTIVE"),
    "SYNC_RECORD": ("__same__", "ACTIVE", "ACTIVE"),
    "INDEX_RECORD": ("SEARCH_INDEX_ENTRY", "ACTIVE", "ACTIVE"),
    "CREATE_EXPORT": ("USER_EXPORT", "ACTIVE", "ACTIVE"),
    "UPDATE_RECORD": ("__same__", "PRESENT", "PRESENT"),
    "CHECK_DATA_FLOW": ("DATA_FLOW", "ACTIVE", "DISABLED"),
    "CHECK_RESTORE_ACCESS": ("BACKUP_ARCHIVE", "ACTIVE", "BLOCKED"),
    "SEND_EMAIL": ("EMAIL_DELIVERY_LOG", "PRESENT", "PRESENT"),
    "REFRESH_CACHE": ("CACHE_ENTRY", "PRESENT", "PRESENT"),
    "LINK_RESOURCE_IDENTITY": ("__same__", "REFERENCED", "REFERENCED"),
    "CLASSIFY_REQUEST": ("__same__", "REFERENCED", "REFERENCED"),
}

RECORD_TYPE_BY_SYSTEM = {
    "search_service": "SEARCH_INDEX_ENTRY",
    "analytics_platform": "ANALYTICS_PROFILE",
    "support_platform": "SUPPORT_MESSAGE",
    "email_delivery_service": "EMAIL_DELIVERY_LOG",
    "cache_service": "CACHE_ENTRY",
    "object_store": "SUPPORT_ATTACHMENT",
    "object_storage": "SUPPORT_ATTACHMENT",
    "archive_service": "BACKUP_ARCHIVE",
    "backup_service": "BACKUP_ARCHIVE",
    "export_service": "USER_EXPORT",
    "integration_service": "DATA_FLOW",
    "identity_service": "ACCOUNT_TOMBSTONE",
    "marketing_platform": "MARKETING_PROFILE",
    "account_service": "USER_PROFILE",
    "account_replication_cluster": "USER_PROFILE",
    "account_failover_replica": "USER_PROFILE",
    "security_service": "SECURITY_AUDIT_LOG",
    "legal_service": "LEGAL_HOLD_RECORD",
}


def record_type_for(system: str, event_type: str) -> str:
    mapped = EVENT_MAP.get(event_type, (None, None, None))[0]
    if mapped and mapped != "__same__":
        return mapped
    return RECORD_TYPE_BY_SYSTEM.get(system) or guess_record_type(system)


# Only these activity rows assert something about a *record's* state. The rest
# (sync, index refresh, cache refresh, email send, export creation, restore) are
# background operations: they describe traffic, not the record's existence, and
# must not overwrite a manifest observation.
STATE_BEARING_EVENTS = {
    "DELETE_RECORD",
    "REDACT_RECORD",
    "ANONYMIZE_RECORD",
    "DISABLE_DATA_FLOW",
    "BLOCK_RESTORE",
    "RETAIN_RECORD",
    "RESTORE_BACKUP",
    "CHECK_DATA_FLOW",
    "CHECK_RESTORE_ACCESS",
}


def is_state_bearing(record: Record) -> bool:
    if record.evidence_kind != "activity":
        return True
    event_type = (record.payload or {}).get("event_type")
    return event_type in STATE_BEARING_EVENTS


def build_activity_records(events: List[Activity]) -> List[Record]:
    """Convert activity rows into claim records."""
    out: List[Record] = []
    for event in events:
        if event.event_type not in EVENT_MAP:
            continue
        system = event.target_system or event.source_system
        resource_id = event.resource_id
        success = event.reported_result.upper() == "SUCCESS"
        partial = event.reported_result.upper() == "PARTIAL"
        _, on_success, on_failure = EVENT_MAP[event.event_type]
        if partial:
            state = "UNCERTAIN"
        else:
            state = on_success if success else on_failure

        link_keys: List[str] = []
        identifiers: Dict[str, str] = {}
        if event.event_type == "LINK_RESOURCE_IDENTITY":
            emails = find_emails(event.details)
            users = find_user_refs(event.details)
            if emails:
                link_keys.append(emails[0])
                identifiers["email"] = emails[0]
            if users:
                link_keys.append(users[0])
                identifiers["subject_reference"] = users[0]

        out.append(Record(
            evidence_id=event.activity_id,
            evidence_kind="activity",
            captured_at=event.event_time,
            observed_at=event.event_time,
            system=system,
            resource_id=resource_id,
            record_type=record_type_for(system, event.event_type),
            state=state,
            identifiers=identifiers,
            link_keys=link_keys,
            payload=event.to_dict(),
            parser="activity",
            source_path="system_activity.csv",
            notes=["claim", f"event_type={event.event_type}",
                   f"reported_result={event.reported_result}"],
        ))
    return out


def classify_requests(events: List[Activity]) -> Dict[str, dict]:
    """``resource_id -> intake classification note`` from CLASSIFY_REQUEST."""
    out: Dict[str, dict] = {}
    for event in events:
        if event.event_type != "CLASSIFY_REQUEST":
            continue
        out[event.resource_id] = {
            "activity_id": event.activity_id,
            "event_time": event.event_time,
            "details": event.details,
        }
    return out
