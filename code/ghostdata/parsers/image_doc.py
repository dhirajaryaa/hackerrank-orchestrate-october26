"""Screenshot parser (optional OCR).

The screenshots are admin-console views. Each header strip exposes the subject
of the screen (``Northstar Shop`` / ``user_11 - account_6762``), and the body
carries the customer identifiers. OCR is best-effort:

* ``tesseract`` if the binary exists,
* otherwise the file is recorded as unparsed so the gap is visible in the
  parse log instead of silently disappearing.

The parser emits one ``SCREENSHOT`` record with the OCR text and every
``user_NN`` / resource id / email / phone it can see, plus ``REFERENCED``
records for each detected resource id.
"""

from __future__ import annotations

import shutil
import subprocess
from typing import List, Tuple

from ..model import Record, guess_system
from ..tables import EvidenceFile
from ..util import find_emails, find_phones, find_resource_ids, find_user_refs


def _ocr(path: str) -> Tuple[str, str]:
    if not shutil.which("tesseract"):
        return "", "tesseract-missing"
    try:
        completed = subprocess.run(
            ["tesseract", path, "stdout", "--psm", "6"],
            check=True, capture_output=True, text=True, timeout=120,
        )
        return completed.stdout, "tesseract"
    except (subprocess.SubprocessError, OSError) as exc:
        return "", f"tesseract-error:{type(exc).__name__}"


def parse(evidence: EvidenceFile) -> Tuple[List[Record], str]:
    text, engine = _ocr(evidence.absolute_path)
    if not text.strip():
        return [], f"engine={engine} no-text"

    resource_ids = sorted(set(find_resource_ids(text)))
    emails = sorted(set(find_emails(text)))
    phones = sorted(set(find_phones(text)))
    user_refs = sorted(set(find_user_refs(text)))

    records: List[Record] = [Record(
        evidence_id=evidence.file_id,
        evidence_kind="manifest",
        captured_at=evidence.captured_at,
        observed_at=evidence.captured_at,
        system="evidence_screenshot",
        resource_id=evidence.file_id,
        record_type="SCREENSHOT",
        state="REFERENCED",
        identifiers={"emails": emails, "phones": phones, "user_refs": user_refs},
        link_keys=emails + user_refs,
        payload={
            "engine": engine,
            "resource_ids": resource_ids,
            "emails": emails,
            "phones": phones,
            "user_refs": user_refs,
            "characters": len(text),
            # Keep the text: it is small, and it is the only place the UI state
            # is expressed, so downstream reasoning needs it verbatim.
            "text": text[:6000],
        },
        parser="image_doc",
        source_path=evidence.file_path,
    )]

    for resource_id in resource_ids:
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
            payload={"source": "image_doc", "file_id": evidence.file_id},
            parser="image_doc",
            source_path=evidence.file_path,
        ))

    detail = (f"engine={engine} chars={len(text)} resources={len(resource_ids)} "
              f"subjects={len(emails) + len(user_refs)}")
    return records, detail
