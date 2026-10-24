"""SQLite-compatible SQL snapshot parser.

The dataset ships three SQL shapes:

1. ``customer_data_primary`` / ``customer_data_<topology>`` tables with a
   ``record_json`` column. Each row is a generic resource dump; the JSON payload
   carries the identifiers.
2. Per-system typed tables (``customer_profiles``, ``support_records``, ...) used
   by the inventory snapshots.
3. ``customer_profiles_primary`` / ``customer_profiles_<topology>`` replica
   pairs used to demonstrate replication drift.

The parser executes the script in an in-memory SQLite database, introspects the
resulting tables, and normalizes every row into a :class:`Record`. Topology is
read from the leading ``-- Database topology:`` comment so that a record found
only in a replica can be flagged as drift.
"""

from __future__ import annotations

import json
import re
import sqlite3
from typing import Dict, List, Tuple

from ..config import STATE_ABSENT, STATE_PRESENT
from ..model import Record, guess_record_type, guess_system
from ..tables import EvidenceFile
from ..util import first_of, parse_ts

TOPOLOGY_RE = re.compile(r"^--\s*Database topology:\s*(\S+)", re.MULTILINE)
CAPTURED_RE = re.compile(r"^--\s*Captured at:\s*(\S+)", re.MULTILINE)

# Columns that describe the person, not the record.
PERSON_COLUMNS = (
    "customer_reference", "user_id", "subject_reference", "full_name", "email",
    "phone", "email_hash", "requester_name", "requester_email", "requester_phone",
    "owner_email", "owner_phone", "customer_email", "display_name",
)

# Direct identifiers only: a surviving stable ``user_NN`` reference is what a
# compliant tombstone is *supposed* to keep.
DIRECT_IDENTIFIER_COLUMNS = (
    "full_name", "email", "phone", "email_hash", "requester_name",
    "requester_email", "requester_phone", "owner_email", "owner_phone",
    "customer_email", "display_name",
)

# Table-name suffix -> canonical system, for replica tables.
TABLE_SYSTEM_HINTS = {
    "customer_profiles": "account_service",
    "customer_data": "replicated_store",
    "search_documents": "search_service",
}


def _topology(text: str) -> str:
    match = TOPOLOGY_RE.search(text)
    if match:
        return match.group(1).strip()
    return "inventory"


def _split_table(name: str) -> Tuple[str, str]:
    """Return (base_collection, topology) for a possibly suffixed table name."""
    for suffix in ("failover_replica", "read_replica", "reporting_replica",
                   "regional_replicas", "replica_ap_south", "replica_eu_west",
                   "primary"):
        if name.endswith("_" + suffix):
            return name[: -(len(suffix) + 1)], suffix
        if name.endswith(suffix) and name != suffix:
            base = name[: -len(suffix)].rstrip("_")
            if base:
                return base, suffix
    return name, "primary"


def _identifiers(row: dict) -> Dict[str, str]:
    out = {}
    for column in PERSON_COLUMNS:
        value = row.get(column)
        if value in (None, "", "null"):
            continue
        out[column] = str(value)
    # Search documents and account snapshots nest the person fields one level
    # down under `document` / `profile`.
    for nested_key in ("document", "profile", "subject"):
        nested = row.get(nested_key)
        if isinstance(nested, dict):
            inner = {k: v for k, v in nested.items() if v not in (None, "", "null")}
            if inner:
                out[nested_key] = inner
    return out


def _has_direct(row: dict) -> bool:
    for column in DIRECT_IDENTIFIER_COLUMNS:
        value = row.get(column)
        if value not in (None, "", "null"):
            return True
    return False


def _state_from_row(row: dict) -> str:
    status = str(row.get("account_status") or "").upper()
    if status in ("DELETED", "TOMBSTONED"):
        # A tombstone with direct identifiers still present is reported PRESENT
        # only when those identifiers are actually there; keeping the stable
        # reference alone is compliant.
        return STATE_PRESENT if _has_direct(row) else "REDACTED"
    enabled = row.get("enabled")
    if enabled not in (None, ""):
        return "ACTIVE" if str(enabled) in ("1", "True", "true") else "DISABLED"
    restore = row.get("restore_allowed")
    if restore not in (None, ""):
        return "ACTIVE" if str(restore) == "1" else "BLOCKED"
    return STATE_PRESENT


def parse(evidence: EvidenceFile) -> Tuple[List[Record], str]:
    with open(evidence.absolute_path, encoding="utf-8") as handle:
        script = handle.read()

    topology = _topology(script)
    captured = CAPTURED_RE.search(script)
    captured_at = captured.group(1).strip() if captured else evidence.captured_at

    connection = sqlite3.connect(":memory:")
    try:
        connection.executescript(script)
        tables = [r[0] for r in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        records: List[Record] = []
        for table in tables:
            if table == "snapshot_scope":
                continue
            cursor = connection.execute(f'SELECT * FROM "{table}"')
            columns = [d[0] for d in cursor.description]
            for row_tuple in cursor.fetchall():
                row = dict(zip(columns, row_tuple))
                records.extend(_row_to_records(evidence, table, row,
                                               topology, captured_at))
        return records, f"topology={topology} tables={len(tables)}"
    finally:
        connection.close()


def _row_to_records(evidence: EvidenceFile, table: str, row: dict,
                    topology: str, captured_at: str) -> List[Record]:
    base, table_topology = _split_table(table)
    payload_json = row.get("record_json")
    if payload_json:
        try:
            payload = json.loads(payload_json)
        except (TypeError, ValueError):
            payload = {}
        resource_id = row.get("resource_id") or payload.get("resource_id")
        system = row.get("origin_system") or guess_system(resource_id or "")
        collection = row.get("collection_name") or ""
        record_type = guess_record_type(system, collection)
        observed_at = row.get("updated_at") or captured_at
        note = []
        if topology in ("read_replica", "reporting_replica", "regional_replicas",
                        "failover_replica"):
            note.append(f"topology={table_topology}")
        return [Record(
            evidence_id=evidence.file_id,
            evidence_kind="manifest",
            captured_at=evidence.captured_at,
            observed_at=observed_at,
            system=system,
            resource_id=resource_id or "",
            record_type=record_type,
            state=_state_from_row(payload) if payload else STATE_PRESENT,
            identifiers=_identifiers(payload),
            payload=payload,
            parser="sql_snapshot",
            source_path=evidence.file_path,
            notes=note,
        )]

    # Typed inventory table.
    resource_id = row.get("resource_id") or ""
    system = guess_system(resource_id)
    if base in TABLE_SYSTEM_HINTS:
        system = TABLE_SYSTEM_HINTS[base]
    if row.get("origin_system"):
        system = row["origin_system"]
    collection = base
    record_type = guess_record_type(system, collection)
    return [Record(
        evidence_id=evidence.file_id,
        evidence_kind="manifest",
        captured_at=evidence.captured_at,
        observed_at=row.get("updated_at") or captured_at,
        system=system,
        resource_id=resource_id,
        record_type=record_type,
        state=_state_from_row(row),
        identifiers=_identifiers(row),
        payload={k: v for k, v in row.items() if k not in PERSON_COLUMNS},
        parser="sql_snapshot",
        source_path=evidence.file_path,
        notes=[f"table={table}", f"topology={table_topology}"],
    )]
