"""Link normalized records to the people they describe.

Link precedence, strongest first:

1. ``explicit_ref``  — the record itself carries ``customer_reference`` /
   ``subject_reference`` / ``user_id`` equal to a stable ``user_NN``.
2. ``identifier``    — an email / phone / email-hash / name on the record matches
   the current or historical identifier graph.
3. ``link_key``      — the surrounding log line supplied a ``lookup_key`` for this
   resource (``profile_lookup_started ... lookup_key=someone@example.com``).
4. ``resource_alias``— the same ``resource_id`` was linked elsewhere in the
   corpus, so the identity is inherited.

Anything left is reported as unlinked rather than guessed.
"""

from __future__ import annotations

from typing import Dict, List, Set

from .identity import IdentityResolver
from .model import ObservationStore, Record
from .util import norm_email, norm_name, norm_phone, sha256


class Linker:
    def __init__(self, resolver: IdentityResolver, store: ObservationStore):
        self.resolver = resolver
        self.store = store
        self.unlinked: List[Record] = []

    # -- public ------------------------------------------------------------
    def run(self) -> Dict[str, int]:
        counts = {"explicit_ref": 0, "identifier": 0, "link_key": 0,
                  "resource_alias": 0, "none": 0}

        # Pass 1: direct evidence on the record.
        for record in self.store.records:
            users, method = self._direct(record)
            if users:
                record.subject_users = sorted(users)
                record.link_method = method
                counts[method] += 1

        # Pass 2: alias map from resources that already resolved.
        alias: Dict[str, Set[str]] = {}
        for record in self.store.records:
            if record.subject_users:
                alias.setdefault(record.resource_id, set()).update(record.subject_users)

        # Pass 3: link keys + aliases, repeated until stable (alias chains).
        for _ in range(3):
            changed = False
            for record in self.store.records:
                if record.subject_users:
                    continue
                via_key = self._from_link_keys(record)
                if via_key:
                    record.subject_users = sorted(via_key)
                    record.link_method = "link_key"
                    alias.setdefault(record.resource_id, set()).update(via_key)
                    counts["link_key"] += 1
                    changed = True
                    continue
                via_alias = alias.get(record.resource_id)
                if via_alias:
                    record.subject_users = sorted(via_alias)
                    record.link_method = "resource_alias"
                    counts["resource_alias"] += 1
                    changed = True
            if not changed:
                break

        for record in self.store.records:
            if not record.subject_users:
                counts["none"] += 1
                if record.record_type not in ("REFERENCE", "DOCUMENT", "SCREENSHOT"):
                    self.unlinked.append(record)

        return counts

    # -- internals ---------------------------------------------------------
    def _direct(self, record: Record):
        identifiers = record.identifiers or {}

        # 1. explicit stable reference
        for key in ("customer_reference", "subject_reference", "user_id"):
            value = identifiers.get(key)
            if isinstance(value, str) and value.startswith("user_"):
                if value in self.resolver.identities:
                    return {value}, "explicit_ref"

        # 2. identifier match
        users: Set[str] = set()
        for key in ("email", "requester_email", "owner_email", "customer_email"):
            value = identifiers.get(key)
            if isinstance(value, str) and value:
                users |= self.resolver.users_for_identifier(norm_email(value))
        for key in ("phone", "requester_phone", "owner_phone"):
            value = identifiers.get(key)
            if isinstance(value, str) and value:
                users |= self.resolver.users_for_identifier(norm_phone(value))
                users |= self.resolver.users_for_identifier(value)
        value = identifiers.get("email_hash")
        if isinstance(value, str) and value:
            users |= self.resolver.users_for_identifier(value.lower())
        # names are weak and duplicated in the snapshot, so only use them when
        # they add nothing ambiguous
        for key in ("full_name", "name", "requester_name", "display_name"):
            value = identifiers.get(key)
            if isinstance(value, str) and value:
                named = self.resolver.users_for_identifier(norm_name(value))
                if len(named) == 1:
                    users |= named

        # 3. nested profile / document blobs (JSON + SQL payloads)
        for key in ("profile", "document"):
            nested = identifiers.get(key)
            if isinstance(nested, dict):
                for sub_key in ("email", "phone", "email_hash",
                                "customer_reference"):
                    value = nested.get(sub_key)
                    if isinstance(value, str) and value:
                        users |= self.resolver.users_for_identifier(
                            value if sub_key != "email" else norm_email(value))

        if users:
            return users, "identifier"
        return set(), "none"

    def _from_link_keys(self, record: Record) -> Set[str]:
        users: Set[str] = set()
        for key in record.link_keys:
            if not key:
                continue
            users |= self.resolver.users_for_identifier(key)
            if "@" in key:
                users |= self.resolver.users_for_identifier(norm_email(key))
            users |= self.resolver.users_for_identifier(sha256(norm_email(key)))
        return users
