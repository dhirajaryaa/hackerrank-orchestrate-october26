"""Log evidence parser covering every dialect shipped in `dataset/evidence/logs`.

Seven physical formats carry the same logical event stream:

===========================  ==================================================
dialect                      example prefix
===========================  ==================================================
``logfmt``                   ``2026-09-15T08:51:45Z level=DEBUG service=...``
``pipe``                     ``2026-07-03T07:51:30Z | DEBUG | service | tr | event |``
``bracket``                  ``2026-07-28T05:51:16Z [DEBUG] [service] [tr] ev:``
``cloudruntime``             ``2026-09-30T11:51:01Z requestId=... message="..."``
``json``                     ``2026-04-19T06:51:11Z {"severity":"DEBUG",...}``
``syslog``                   ``2026-03-25T08:51:13Z <15>1 node-8 service tr - - level=``
``flat``                     ``2026-03-15T07:00:00Z INFO service=... event=record_lookup``
===========================  ==================================================

All of them normalize to ``(timestamp, service, event, fields)``. Only events
that assert a resource state become :class:`Record` objects; connection retries,
pool waits and shard timing stay out of the index. ``lookup_key`` values seen on
a matching ``*_started`` line are back-propagated so every state record keeps the
explicit identifier that ties it to a person.
"""

from __future__ import annotations

import json
import re
from typing import Dict, List, Optional, Tuple

from ..config import LOG_EVENT_KINDS, STATE_ABSENT, STATE_PRESENT
from ..model import Record, guess_record_type, guess_system
from ..tables import EvidenceFile
from ..util import parse_ts, split_kv

TS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)")
PIPE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\S+)\s*\|\s*(\w+)\s*\|\s*([^\s|]+)\s*\|\s*([^\s|]+)\s*\|\s*([^\s|]+)\s*\|(.*)$")
BRACKET_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\S+)\s*\[(\w+)\]\s*\[([^\]]+)\]\s*\[([^\]]+)\]\s*([A-Za-z0-9_]+):?(.*)$")
SYSLOG_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\S+)\s*<\d+>\d\s+\S+\s+([^\s]+)\s+([^\s]+)\s+-\s+-(.*)$")
CLOUD_RE = re.compile(r'^(\d{4}-\d{2}-\d{2}T\S+)\s+(?:requestId=\S+\s+)?level=\w+\s+function=([^\s]+)\s+(.*)$')
FLAT_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\S+)\s+(INFO|DEBUG|WARN|ERROR)\s+service=([^\s]+)\s+(.*)$")

PERSON_FIELDS = (
    "email", "phone", "email_hash", "customer_reference", "subject_reference",
    "requester_name", "requester_email", "requester_phone", "owner_email",
    "owner_phone", "customer_email", "display_name", "full_name", "user_id",
)

# Events that assert a record state and therefore produce a Record.
STATE_EVENTS = {
    "profile_lookup_completed": "account_service",
    "index_query_completed": "search_service",
    "analytics_profile_read": "analytics_platform",
    "analytics_profile_read_completed": "analytics_platform",
    "analytics_profile_scan_completed": "analytics_platform",
    "analytics_identity_scan": "analytics_platform",
    "support_ticket_read_completed": "support_platform",
    "support_attachment_read_completed": "support_platform",
    "message_pii_scan": "support_platform",
    "attachment_pii_scan": "support_platform",
    "audit_record_read_completed": "security_service",
    "connector_config_read_completed": "integration_service",
    "connector_heartbeat": "integration_service",
    "restore_policy_read_completed": "backup_service",
    "restore_candidate_evaluated": "backup_service",
    "contact_query_completed": "support_platform",
    "contact_lookup_completed": "analytics_platform",
    "export_job_read_completed": "export_service",
    "export_metadata_read_completed": "export_service",
    "export_download_check_completed": "export_service",
    "marketing_profile_read_completed": "marketing_platform",
    "email_log_read_completed": "email_delivery_service",
    "cache_entry_read_completed": "cache_service",
    "tombstone_read_completed": "identity_service",
    "record_lookup": None,
}

# Events that report exposed identifiers rather than plain existence.
EXPOSURE_EVENTS = {
    "message_pii_scan": "SUPPORT_MESSAGE",
    "attachment_pii_scan": "SUPPORT_ATTACHMENT",
    "analytics_identity_scan": "ANALYTICS_PROFILE",
}

# Every field that can carry an explicit key tying a resource to a person.
LINK_KEY_FIELDS = (
    "lookup_key", "correlation_key", "subject_key", "scan_key", "owner_key",
    "match_key", "subject_ref", "matched_value", "subject_reference",
)

NOISE_EVENTS = {
    "export_started", "export_completed", "connection_acquired", "pool_acquired",
    "dependency_retry", "dependency_recovered", "shard_scan", "cache_lookup",
    "batch_started", "batch_completed", "message_scan_started",
    "attachment_scan_started", "restore_policy_check_started",
    "export_download_check_started", "analytics_profile_scan_started",
    "index_query_started", "profile_lookup_started", "audit_record_read_started",
    "audit_record_query_started", "connector_config_read_started",
    "analytics_profile_read_started", "support_ticket_read_started",
    "export_metadata_read_started", "contact_query_started",
    "deletion_marker_check", "deletion_marker_created", "connector_heartbeat_ok",
    "cache_refresh", "consumer_lag", "timer_tick", "disk_latency",
    "certificate_checked", "lease_extended", "checkpoint_saved",
    "delivery_abandoned", "thumbnail_failed",
}


def _dialect(line: str) -> Tuple[str, dict]:
    """Return (dialect, normalized skeleton) for one log line."""
    stripped = line.strip()
    if not stripped:
        return "blank", {}

    match = PIPE_RE.match(stripped)
    if match:
        ts, level, service, trace, event, rest = match.groups()
        return "pipe", {"ts": ts, "level": level, "service": service,
                        "trace": trace, "event": event, "fields": split_kv(rest)}

    match = BRACKET_RE.match(stripped)
    if match:
        ts, level, service, trace, event, rest = match.groups()
        return "bracket", {"ts": ts, "level": level, "service": service,
                           "trace": trace, "event": event, "fields": split_kv(rest)}

    # JSON payload after an ISO timestamp.
    brace = stripped.find("{")
    if brace > 0 and stripped[0].isdigit():
        ts_match = TS_RE.match(stripped)
        if ts_match:
            try:
                payload = json.loads(stripped[brace:])
            except ValueError:
                payload = None
            if isinstance(payload, dict):
                fields = {k: v for k, v in payload.items()
                          if k not in ("severity", "logger", "service", "instance",
                                       "pod", "region", "event")}
                return "json", {"ts": ts_match.group(1),
                                "level": payload.get("severity"),
                                "service": payload.get("service") or payload.get("logger"),
                                "trace": payload.get("trace_id"),
                                "event": payload.get("event"),
                                "fields": fields}

    match = SYSLOG_RE.match(stripped)
    if match:
        ts, service, trace, rest = match.groups()
        fields = split_kv(rest)
        return "syslog", {"ts": ts, "level": fields.get("level"), "service": service,
                          "trace": trace, "event": fields.get("event"),
                          "fields": fields}

    match = CLOUD_RE.match(stripped)
    if match:
        ts, function, rest = match.groups()
        fields = split_kv(rest)
        message = fields.get("message")
        if message:
            fields.update(split_kv(message))
        return "cloudruntime", {"ts": ts, "level": fields.get("level"),
                                "service": function, "trace": fields.get("requestId"),
                                "event": fields.get("event"), "fields": fields}

    match = FLAT_RE.match(stripped)
    if match:
        ts, level, service, rest = match.groups()
        fields = split_kv(rest)
        return "flat", {"ts": ts, "level": level, "service": service,
                        "trace": fields.get("trace_id"),
                        "event": fields.get("event"), "fields": fields}

    ts_match = TS_RE.match(stripped)
    if ts_match:
        fields = split_kv(stripped[ts_match.end():])
        return "logfmt", {"ts": ts_match.group(1), "level": fields.get("level"),
                          "service": fields.get("service"),
                          "trace": fields.get("trace_id"),
                          "event": fields.get("event"), "fields": fields}
    return "unknown", {}


def parse(evidence: EvidenceFile) -> Tuple[List[Record], str]:
    with open(evidence.absolute_path, encoding="utf-8", errors="replace") as handle:
        lines = handle.read().splitlines()

    parsed = []
    dialect_counts: Dict[str, int] = {}
    for line in lines:
        dialect, skeleton = _dialect(line)
        if dialect in ("blank", "unknown") or not skeleton.get("event"):
            continue
        skeleton["dialect"] = dialect
        parsed.append(skeleton)
        dialect_counts[dialect] = dialect_counts.get(dialect, 0) + 1

    # Back-propagate lookup keys: (service, resource_id) -> lookup_key.
    lookup_keys: Dict[Tuple[str, str], str] = {}
    trace_keys: Dict[str, str] = {}
    for event in parsed:
        fields = event["fields"]
        key = None
        for field_name in LINK_KEY_FIELDS:
            if fields.get(field_name):
                key = fields[field_name]
                break
        resource_id = fields.get("resource_id")
        if not key:
            continue
        if resource_id:
            lookup_keys.setdefault((event["service"], resource_id), key)
            lookup_keys.setdefault((None, resource_id), key)
        if event.get("trace"):
            trace_keys.setdefault(event["trace"], key)

    records: List[Record] = []
    for event in parsed:
        record = _to_record(evidence, event, lookup_keys, trace_keys)
        if record is not None:
            records.append(record)

    detail = " ".join(f"{k}={v}" for k, v in sorted(dialect_counts.items()))
    return records, f"lines={len(lines)} {detail}"


def _to_record(evidence: EvidenceFile, event: dict,
               lookup_keys: Dict[Tuple[str, str], str],
               trace_keys: Dict[str, str]) -> Optional[Record]:
    name = event["event"]
    if name in NOISE_EVENTS or name not in STATE_EVENTS:
        return None
    fields = event["fields"]
    resource_id = fields.get("resource_id")
    if not resource_id:
        return None

    service = event["service"] or ""
    system = (fields.get("system") or STATE_EVENTS.get(name)
              or guess_system(resource_id))
    record_type = guess_record_type(
        system,
        explicit=fields.get("record_type"),
        collection=None,
    )
    if name in EXPOSURE_EVENTS:
        record_type = EXPOSURE_EVENTS[name]

    identifiers = {}
    for key in PERSON_FIELDS:
        value = fields.get(key)
        if value not in (None, "", "null"):
            identifiers[key] = value
    subject_reference = fields.get("subject_reference")
    if subject_reference and "subject_reference" not in identifiers:
        identifiers["subject_reference"] = subject_reference

    # `matched_value` is the identifier the scanner found on the record.
    matched = fields.get("matched_value")
    if matched:
        if "@" in matched:
            identifiers.setdefault("email", matched)
        elif matched.startswith("+"):
            identifiers.setdefault("phone", matched)
        else:
            identifiers.setdefault("matched_value", matched)
    if name in EXPOSURE_EVENTS:
        identifiers.setdefault("detector", fields.get("detector"))

    state = _state(name, fields)
    link_keys = []
    explicit_key = fields.get("lookup_key") or fields.get("query")
    if explicit_key and explicit_key != "null":
        link_keys.append(explicit_key)
    for candidate in ((service, resource_id), (None, resource_id)):
        if candidate in lookup_keys:
            key = lookup_keys[candidate]
            if key and key != "null" and key not in link_keys:
                link_keys.append(key)
    if event.get("trace") and event["trace"] in trace_keys:
        key = trace_keys[event["trace"]]
        if key and key != "null" and key not in link_keys:
            link_keys.append(key)

    return Record(
        evidence_id=evidence.file_id,
        evidence_kind="manifest",
        captured_at=evidence.captured_at,
        observed_at=event["ts"],
        system=system,
        resource_id=resource_id,
        record_type=record_type,
        state=state,
        identifiers=identifiers,
        link_keys=link_keys,
        payload={k: v for k, v in fields.items() if k not in PERSON_FIELDS},
        parser="log_events",
        source_path=evidence.file_path,
        notes=[f"event={name}", f"dialect={event.get('dialect')}"],
    )


def _state(name: str, fields: dict) -> str:
    if name in EXPOSURE_EVENTS:
        return "IDENTIFIABLE" if fields.get("matched_value") or str(
            fields.get("direct_identifiers", "")) not in ("", "0") else "REDACTED"
    if name == "record_lookup":
        token = str(fields.get("result") or "").upper()
        return STATE_ABSENT if token in ("NOT_FOUND", "MISS", "ABSENT") else STATE_PRESENT
    if name == "profile_lookup_completed":
        if str(fields.get("http_status")) == "404":
            return STATE_ABSENT
        if str(fields.get("rows")) == "0":
            return STATE_ABSENT
        return STATE_PRESENT
    if name == "index_query_completed":
        return STATE_ABSENT if str(fields.get("result", "")).lower() == "miss" else STATE_PRESENT
    if name == "analytics_profile_read":
        return "IDENTIFIABLE" if str(fields.get("direct_identifiers", "0")) not in ("0", "") else "ANONYMIZED"
    if name == "contact_lookup_completed":
        return STATE_ABSENT if str(fields.get("rows", "1")) == "0" else STATE_PRESENT
    if name == "connector_config_read_completed":
        return "ACTIVE" if str(fields.get("enabled", "")).lower() == "true" else "DISABLED"
    if name == "connector_heartbeat":
        return "ACTIVE" if str(fields.get("enabled", "")).lower() == "true" else "DISABLED"
    if name == "restore_policy_read_completed":
        if str(fields.get("archive_present", "")).lower() == "false":
            return STATE_ABSENT
        return "ACTIVE" if str(fields.get("restore_allowed", "")).lower() == "true" else "BLOCKED"
    if name == "restore_candidate_evaluated":
        if str(fields.get("eligible", "")).lower() != "true":
            return "BLOCKED"
        return "BLOCKED" if str(fields.get("deletion_block", "")).lower() == "true" else "ACTIVE"
    if name in ("export_metadata_read_completed", "export_download_check_completed"):
        token = str(fields.get("available", "")).lower()
        return "DISABLED" if token == "false" else STATE_PRESENT
    if name == "audit_record_read_completed":
        return STATE_PRESENT if str(fields.get("rows", "1")) != "0" else STATE_ABSENT
    return STATE_PRESENT
