"""Identity resolution: current snapshot + historical changes -> identifier graph.

`user_identities.csv` holds the current snapshot; `user_audit_log.csv` holds the
old/new value of every later change. A request may arrive with an email that has
since been replaced, so both sources are required. Email hashes are ``sha256`` of
the lower-cased address, which lets a redacted-looking record still resolve.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

from .tables import AuditEntry, Identity, Request
from .util import (
    is_email_hash,
    norm_email,
    norm_name,
    norm_phone,
    parse_ts,
    sha256,
)


@dataclass
class Resolution:
    """What we know about one case subject before touching the evidence."""

    user_id: Optional[str]
    email_supplied: str
    email_kind: str            # "current" | "historical" | "unknown"
    matched_audit_ids: List[str] = field(default_factory=list)
    name: Optional[str] = None
    current: Dict[str, str] = field(default_factory=dict)
    historical: Dict[str, List[str]] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "user_id": self.user_id,
            "email_supplied": self.email_supplied,
            "email_kind": self.email_kind,
            "matched_audit_ids": self.matched_audit_ids,
            "name": self.name,
            "current": self.current,
            "historical": self.historical,
        }


class IdentityResolver:
    def __init__(self, identities: Dict[str, Identity], audit_log: List[AuditEntry]):
        self.identities = identities
        self.audit_log = audit_log

        self.by_user: Dict[str, List[AuditEntry]] = {}
        self._email: Dict[str, Set[str]] = {}
        self._hash: Dict[str, Set[str]] = {}
        self._phone: Dict[str, Set[str]] = {}
        self._name: Dict[str, Set[str]] = {}
        self._audit_by_value: Dict[str, List[AuditEntry]] = {}

        for identity in identities.values():
            self._add_user_values(
                identity.user_id,
                email=identity.email,
                phone=identity.phone,
                email_hash=identity.email_hash,
                name=identity.name,
            )
        for entry in audit_log:
            self.by_user.setdefault(entry.user_id, []).append(entry)
            self._audit_by_value.setdefault(norm_email(entry.old_value), []).append(entry)
            self._audit_by_value.setdefault(norm_email(entry.new_value), []).append(entry)
            if entry.field_name == "email":
                self._link(self._email, entry.old_value, entry.user_id)
                self._link(self._email, entry.new_value, entry.user_id)
                self._link(self._hash, sha256(norm_email(entry.old_value)), entry.user_id)
                self._link(self._hash, sha256(norm_email(entry.new_value)), entry.user_id)
            elif entry.field_name == "email_hash":
                self._link(self._hash, entry.old_value, entry.user_id)
                self._link(self._hash, entry.new_value, entry.user_id)
            elif entry.field_name == "phone":
                self._link(self._phone, entry.old_value, entry.user_id)
                self._link(self._phone, entry.new_value, entry.user_id)

    # -- construction ------------------------------------------------------
    @staticmethod
    def _link(index: Dict[str, Set[str]], value: str, user_id: str) -> None:
        if not value:
            return
        index.setdefault(str(value).strip().lower(), set()).add(user_id)

    def _add_user_values(self, user_id: str, **values) -> None:
        if values.get("email"):
            self._link(self._email, norm_email(values["email"]), user_id)
            self._link(self._hash, sha256(norm_email(values["email"])), user_id)
        if values.get("phone"):
            self._link(self._phone, norm_phone(values["phone"]), user_id)
            self._link(self._phone, values["phone"], user_id)
        if values.get("email_hash"):
            self._link(self._hash, str(values["email_hash"]).strip().lower(), user_id)
        if values.get("name"):
            self._link(self._name, norm_name(values["name"]), user_id)

    # -- lookups -----------------------------------------------------------
    def resolve_email(self, email: str) -> Tuple[Optional[str], str, List[str]]:
        """Resolve a request email to a user id using current then historical data."""
        key = norm_email(email)
        if not key:
            return None, "unknown", []
        current = self._email.get(key, set())
        audit_hits = self._audit_by_value.get(key, [])
        audit_ids = sorted({e.audit_id for e in audit_hits})
        if current:
            user_id = sorted(current)[0]
            kind = "current" if self.identities.get(user_id) and \
                norm_email(self.identities[user_id].email) == key else "historical"
            return user_id, kind, audit_ids
        # Fall back to the hash of the supplied address.
        hashed = self._hash.get(sha256(key), set())
        if hashed:
            return sorted(hashed)[0], "historical", audit_ids
        if audit_hits:
            return sorted({e.user_id for e in audit_hits})[0], "historical", audit_ids
        return None, "unknown", audit_ids

    def users_for_identifier(self, value) -> Set[str]:
        if value in (None, ""):
            return set()
        text = str(value).strip()
        if text.startswith("user_"):
            return {text} if text in self.identities else set()
        key = text.lower()
        found: Set[str] = set()
        if "@" in key:
            found |= self._email.get(key, set())
            found |= self._hash.get(sha256(key), set())
        found |= self._hash.get(key, set())
        found |= self._phone.get(key, set())
        found |= self._phone.get(norm_phone(key), set())
        found |= self._name.get(norm_name(key), set())
        return found

    def resolve_case(self, request: Request) -> Resolution:
        user_id, kind, audit_ids = self.resolve_email(request.email)
        resolution = Resolution(
            user_id=user_id,
            email_supplied=request.email,
            email_kind=kind,
            matched_audit_ids=audit_ids,
        )
        if user_id and user_id in self.identities:
            identity = self.identities[user_id]
            resolution.name = identity.name
            resolution.current = identity.identifiers()
            history: Dict[str, List[str]] = {}
            for entry in self.by_user.get(user_id, []):
                value = entry.old_value
                if not value:
                    continue
                history.setdefault(entry.field_name, [])
                if value not in history[entry.field_name]:
                    history[entry.field_name].append(value)
            resolution.historical = history
        return resolution

    def identifier_set(self, user_id: Optional[str]) -> Dict[str, Set[str]]:
        """Every identifier form known for a user, normalized for matching."""
        out = {"emails": set(), "hashes": set(), "phones": set(), "names": set()}
        if not user_id:
            return out
        identity = self.identities.get(user_id)
        if identity:
            out["emails"].add(norm_email(identity.email))
            out["hashes"].add(str(identity.email_hash).lower())
            out["phones"].add(norm_phone(identity.phone))
            out["phones"].add(identity.phone.strip().lower())
            out["names"].add(norm_name(identity.name))
        for entry in self.by_user.get(user_id, []):
            value = entry.old_value
            if not value:
                continue
            if entry.field_name == "email":
                out["emails"].add(norm_email(value))
                out["hashes"].add(sha256(norm_email(value)))
            elif entry.field_name == "email_hash":
                out["hashes"].add(str(value).lower())
            elif entry.field_name == "phone":
                out["phones"].add(norm_phone(value))
                out["phones"].add(value.strip().lower())
        out["emails"].discard("")
        out["hashes"].discard("")
        out["phones"].discard("")
        return out

    # -- helpers -----------------------------------------------------------
    def identity_known_at(self, user_id: str, at: Optional[str]) -> Dict[str, str]:
        """Current identifiers, minus any change that happened after `at`."""
        identity = self.identities.get(user_id)
        if identity is None:
            return {}
        cutoff = parse_ts(at)
        if cutoff is None:
            return identity.identifiers()
        snapshot = identity.identifiers()
        # Walk history backwards: if a change happened after the cutoff, roll it back.
        for entry in sorted(self.by_user.get(user_id, []),
                            key=lambda e: parse_ts(e.event_time) or cutoff,
                            reverse=True):
            event_time = parse_ts(entry.event_time)
            if event_time is None or event_time <= cutoff:
                continue
            field = entry.field_name
            if field == "email":
                snapshot["email"] = entry.old_value
                snapshot["email_hash"] = sha256(norm_email(entry.old_value))
            elif field == "email_hash":
                snapshot["email_hash"] = entry.old_value
            elif field == "phone":
                snapshot["phone"] = entry.old_value
        return snapshot
