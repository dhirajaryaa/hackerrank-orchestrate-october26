"""Plain-text shift-handover parser.

`customer_account_handover_20261001.txt` is the most compact evidence format in
the dataset: a title, a snapshot timestamp, and one pipe-delimited check per
line::

    - <timestamp> | <system> | <resource_id> | <record_type> | <state> | <subject>

`<subject>` is either a direct identifier (email / phone / hash), a stable
``user_NN`` reference, or the literal ``no direct identifier`` for already
anonymized rows.
"""

from __future__ import annotations

import re
from typing import List, Tuple

from ..config import RAW_STATE
from ..model import Record, guess_record_type, guess_system
from ..tables import EvidenceFile

SNAPSHOT_RE = re.compile(r"Snapshot:\s*(\S+)")
ROW_RE = re.compile(
    r"^-\s*(?P<ts>\S+)\s*\|\s*(?P<system>[^|]+)\|\s*(?P<resource>[^|]+)\|"
    r"\s*(?P<type>[^|]+)\|\s*(?P<state>[^|]+)\|\s*(?P<subject>.+?)\s*$"
)


def _state(token: str) -> str:
    token = token.strip().upper()
    if token in RAW_STATE:
        return RAW_STATE[token]
    if token in ("ANONYMIZED", "ANONYMISED"):
        return "ANONYMIZED"
    return token or "PRESENT"


def parse(evidence: EvidenceFile) -> Tuple[List[Record], str]:
    with open(evidence.absolute_path, encoding="utf-8") as handle:
        lines = handle.read().splitlines()

    snapshot = evidence.captured_at
    for line in lines:
        match = SNAPSHOT_RE.search(line)
        if match:
            snapshot = match.group(1)
            break

    records: List[Record] = []
    for line in lines:
        match = ROW_RE.match(line.strip())
        if not match:
            continue
        system = match.group("system").strip()
        resource_id = match.group("resource").strip()
        record_type = guess_record_type(system, explicit=match.group("type").strip())
        subject = match.group("subject").strip()
        identifiers = {}
        if subject and subject.lower() != "no direct identifier":
            if subject.startswith("user_"):
                identifiers["subject_reference"] = subject
            else:
                identifiers["email"] = subject
        records.append(Record(
            evidence_id=evidence.file_id,
            evidence_kind="manifest",
            captured_at=evidence.captured_at,
            observed_at=match.group("ts").strip(),
            system=system or guess_system(resource_id),
            resource_id=resource_id,
            record_type=record_type,
            state=_state(match.group("state")),
            identifiers=identifiers,
            link_keys=[subject] if subject and subject.lower() != "no direct identifier" else [],
            payload={"raw_subject": subject},
            parser="text_report",
            source_path=evidence.file_path,
        ))
    return records, f"snapshot={snapshot} rows={len(records)}"
