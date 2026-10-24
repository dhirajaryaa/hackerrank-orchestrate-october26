"""Evidence parsers, one per on-disk dialect."""

from __future__ import annotations

import os
from typing import Callable, List

from ..model import Record
from ..tables import EvidenceFile
from . import (
    image_doc,
    json_records,
    log_events,
    pdf_doc,
    sql_snapshot,
    text_report,
)

# Ordered dispatch table: (suffix predicate, parser, label)
SUFFIX_PARSERS: List[tuple] = [
    ((".sql",), sql_snapshot.parse, "sql_snapshot"),
    ((".json",), json_records.parse, "json_records"),
    ((".log",), log_events.parse, "log_events"),
    ((".txt",), text_report.parse, "text_report"),
    ((".pdf",), pdf_doc.parse, "pdf_doc"),
    ((".png", ".jpg", ".jpeg"), image_doc.parse, "image_doc"),
]


def parse_evidence(evidence: EvidenceFile, store) -> List[Record]:
    """Parse one manifest entry into normalized records."""
    suffix = evidence.suffix
    parser: Callable = None
    label = "unsupported"
    for suffixes, func, name in SUFFIX_PARSERS:
        if suffix in suffixes:
            parser, label = func, name
            break

    if parser is None:
        store.log_file(evidence.file_id, evidence.file_path, "none", 0,
                       status="skipped", detail=f"unsupported suffix {suffix!r}")
        return []

    if not os.path.exists(evidence.absolute_path):
        store.log_file(evidence.file_id, evidence.file_path, label, 0,
                       status="missing", detail="file not found on disk")
        return []

    try:
        records, detail = parser(evidence)
    except Exception as exc:  # keep the pipeline alive, surface the failure
        store.log_file(evidence.file_id, evidence.file_path, label, 0,
                       status="error", detail=f"{type(exc).__name__}: {exc}")
        return []

    for record in records:
        if not record.parser:
            record.parser = label
        if not record.source_path:
            record.source_path = evidence.file_path
    store.extend(records)
    store.log_file(evidence.file_id, evidence.file_path, label, len(records),
                   status="ok", detail=detail)
    return records
