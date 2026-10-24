"""PDF evidence parser.

The PDFs are ordinary business artifacts (customer statements, delivery
correction requests, retention registers, compliance journal extracts) rendered
as labelled key/value blocks plus a couple of tabular sections. The parser
converts the PDF to layout-preserving text with ``pdftotext`` (falling back to
``pypdf`` when the binary is unavailable) and then lands everything in the same
normalized index:

* one ``DOCUMENT`` record carrying the harvested facts, and
* one ``REFERENCED`` record per resource id / subject mentioned in the text.

Nothing here decides a verdict; the output is a grounded fact bag plus an
evidence reference so downstream reasoning has something to cite.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from typing import Dict, List, Tuple

from ..model import Record, guess_system
from ..tables import EvidenceFile
from ..util import find_emails, find_phones, find_resource_ids, find_user_refs

LABEL_RE = re.compile(r"^\s*(Record|Detail)\s{2,}(.+?)\s*$")
REGISTER_RE = re.compile(r"^\s*\d+\s{2,}([A-Z]{2,}-\S+)\s*\|\s*(user_\d+)\s*\|(.+)$")
REFERENCE_RE = re.compile(r"\b(?:CJX|CS|NST|ORD|SWF)-[0-9A-Z\-]+\b")


def _extract_text(path: str) -> Tuple[str, str]:
    if shutil.which("pdftotext"):
        try:
            completed = subprocess.run(
                ["pdftotext", "-layout", path, "-"],
                check=True, capture_output=True, text=True, timeout=60,
            )
            return completed.stdout, "pdftotext"
        except (subprocess.SubprocessError, OSError):
            pass
    try:  # optional fallback
        from pypdf import PdfReader  # type: ignore
        reader = PdfReader(path)
        return "\n".join(page.extract_text() or "" for page in reader.pages), "pypdf"
    except Exception:
        return "", "unavailable"


def parse(evidence: EvidenceFile) -> Tuple[List[Record], str]:
    text, engine = _extract_text(evidence.absolute_path)
    if not text.strip():
        return [], f"engine={engine} no-text"

    labels: Dict[str, List[str]] = {}
    keys: List[str] = []
    for line in text.splitlines():
        match = LABEL_RE.match(line)
        if not match:
            continue
        label, value = match.group(1).lower(), match.group(2).strip()
        labels.setdefault(label, []).append(value)
        if label == "record":
            keys.append(value)

    register_rows = []
    for line in text.splitlines():
        match = REGISTER_RE.match(line)
        if match:
            register_rows.append({
                "order_id": match.group(1),
                "subject_reference": match.group(2),
                "detail": match.group(3).strip(),
            })

    resource_ids = find_resource_ids(text)
    emails = find_emails(text)
    phones = find_phones(text)
    user_refs = find_user_refs(text)
    references = sorted(set(REFERENCE_RE.findall(text)))

    payload = {
        "engine": engine,
        "title": text.splitlines()[0].strip() if text.splitlines() else "",
        "key_records": keys,
        "labels": labels,
        "register_rows": register_rows,
        "resource_ids": resource_ids,
        "emails": emails,
        "phones": phones,
        "user_refs": user_refs,
        "references": references,
        "characters": len(text),
    }

    records: List[Record] = [Record(
        evidence_id=evidence.file_id,
        evidence_kind="manifest",
        captured_at=evidence.captured_at,
        observed_at=evidence.captured_at,
        system="evidence_document",
        resource_id=evidence.file_id,
        record_type="DOCUMENT",
        state="REFERENCED",
        identifiers={"emails": emails, "phones": phones, "user_refs": user_refs},
        link_keys=emails + user_refs,
        payload=payload,
        parser="pdf_doc",
        source_path=evidence.file_path,
    )]

    for resource_id in sorted(set(resource_ids)):
        records.append(Record(
            evidence_id=evidence.file_id,
            evidence_kind="manifest",
            captured_at=evidence.captured_at,
            observed_at=evidence.captured_at,
            system=guess_system(resource_id),
            resource_id=resource_id,
            record_type="REFERENCE",
            state="REFERENCED",
            identifiers={},
            payload={"source": "pdf_doc", "file_id": evidence.file_id},
            parser="pdf_doc",
            source_path=evidence.file_path,
        ))

    detail = (f"engine={engine} chars={len(text)} labels={len(keys)} "
              f"resources={len(set(resource_ids))} subjects={len(emails) + len(user_refs)}")
    return records, detail
