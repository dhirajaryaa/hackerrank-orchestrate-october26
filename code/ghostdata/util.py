"""Small, dependency-free helpers shared by every parser."""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone

TS_RE = re.compile(
    r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)"
)

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
USER_REF_RE = re.compile(r"\buser_\d+\b")
RESOURCE_RE = re.compile(
    r"\b(account|search|analytics|support|export|data_flow|backup|audit_record|"
    r"tombstone|email_delivery|cache|object|marketing|legal_hold|archive)_([A-Za-z0-9]+)\b"
)
PHONE_RE = re.compile(r"\+\d[\d\s().\-]{6,}\d")
HASH_RE = re.compile(r"\b[0-9a-f]{64}\b")


def parse_ts(value):
    """Parse an ISO-8601 UTC timestamp into an aware datetime, or None."""
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def ts_key(value):
    """Sortable string key for timestamps; unparseable values sort last."""
    dt = parse_ts(value)
    if dt is None:
        return "9999-12-31T23:59:59+00:00"
    return dt.astimezone(timezone.utc).isoformat()


def norm_email(value):
    return (value or "").strip().lower()


def norm_phone(value):
    if not value:
        return ""
    return re.sub(r"[^0-9+]", "", str(value))


def norm_name(value):
    return re.sub(r"\s+", " ", (value or "").strip().lower())


def sha256(value):
    return hashlib.sha256((value or "").encode("utf-8")).hexdigest()


def is_email_hash(value):
    return bool(value) and bool(HASH_RE.fullmatch(str(value).strip().lower()))


def find_emails(text):
    return [m.group(0) for m in EMAIL_RE.finditer(text or "")]


def find_user_refs(text):
    return [m.group(0) for m in USER_REF_RE.finditer(text or "")]


def find_resource_ids(text):
    return [f"{m.group(1)}_{m.group(2)}" for m in RESOURCE_RE.finditer(text or "")]


def find_phones(text):
    return [m.group(0).strip() for m in PHONE_RE.finditer(text or "")]


def split_kv(text):
    """Extract ``key=value`` / ``key="value"`` pairs from a log fragment.

    Handles values that are quoted, unquoted, or JSON-encoded, and tolerates
    ``message="... event=\"x\" key=\"y\" ..."`` double encoding.
    """
    out = {}
    # Unescape a JSON-ish wrapper if present.
    fragment = text.replace('\\"', '"')
    pattern = re.compile(r'(\b[A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|([^\s]+))')
    for match in pattern.finditer(fragment):
        key = match.group(1)
        value = match.group(2) if match.group(2) is not None else match.group(3)
        if value is None:
            continue
        value = value.strip()
        if value.lower() in ("null", "none", ""):
            value = None
        out[key] = value
    return out


def first_of(mapping, *keys):
    for key in keys:
        if key in mapping and mapping[key] not in (None, ""):
            return mapping[key]
    return None


def truthy(value):
    if isinstance(value, bool):
        return value
    if value is None:
        return None
    return str(value).strip().lower() in ("1", "true", "yes", "y", "enabled", "active")


def bucket_ts(value):
    """Coarse bucket used to group observations captured in the same run."""
    dt = parse_ts(value)
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H")
