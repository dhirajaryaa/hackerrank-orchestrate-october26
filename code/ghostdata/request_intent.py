"""Request-intent classification: does this message authorise deletion?

The dataset contains deletion requests written in several languages plus a small
set of look-alikes (access, correction, portability, marketing opt-out, login
help). Those must come out as ``NOT_APPLICABLE`` with an empty step list, so the
classifier is deliberately conservative:

* an explicit negation phrase wins outright;
* otherwise a deletion verb in any supported language authorises deletion;
* otherwise a recognised non-deletion action marks the request as
  ``NOT_APPLICABLE``;
* otherwise the request is flagged ``unclear`` so a human/LLM can adjudicate
  instead of silently guessing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List

# Phrases that unambiguously withdraw consent for destructive action.
HARD_NEGATIONS = [
    r"not asking for deletion",
    r"not a request to erase",
    r"not a request to delete",
    r"do not close the account",
    r"don'?t close the account",
    r"do not delete",
    r"don'?t delete",
    r"do not remove",
    r"don'?t remove",
    r"please don'?t delete or change anything",
    r"without removing any of my records",
    r"leave the account active",
    r"keep the account as it is",
    r"leave my profile and purchase history in place",
    r"i still (?:need|use|want) the account",
    r"i want to continue using the service",
    r"i still want receipts",
    r"this is an information request",
]

# Deletion intent, per language. Verbs are stemmed loosely and anchored to word
# boundaries so "deleted" and "删除" both hit without matching unrelated words.
DELETION_TERMS = [
    # English
    r"delet", r"eras", r"erasure", r"remov", r"\bgone\b",
    r"close (?:my|this|the) account",
    r"clos(?:e|ed|ing) (?:it|my|this|the) account", r"\bclosed\b", r"purge",
    r"permanently removed?", r"profile is gone", r"nothing .* point back to me",
    # Spanish / Portuguese
    r"elimina", r"eliminaci[oó]n", r"borrar", r"borrado", r"exclus[ãa]o", r"excluir",
    r"apagar", r"deletar", r"suprimir", r"cerrar (?:mi|la) cuenta",
    # French
    r"suppress?ion", r"supprimer", r"effacer",
    # German / Dutch
    r"l[oö]sch", r"entfernen", r"verwijder",
    # Italian
    r"cancellare", r"sopprimere",
    # Korean / Japanese / Chinese
    r"삭제", r"해지", r"탈퇴", r"削除", r"消去", r"删除", r"刪除", r"注销",
    # Others
    r"usuni[eę]", r"usu[nń]", r"удал", r"حذف", r"sil(?:me|mek)", r"hapus",
]

# Non-deletion actions, used only when no deletion term is present.
NON_DELETION_ACTIONS = [
    (r"(?:mobile )?number .* out of date|replace it with the new one", "correction"),
    (r"surname is misspelled|can you correct it", "correction"),
    (r"change the email address", "correction"),
    (r"reset(?:ting)? the login|can'?t access my profile", "access_help"),
    (r"stop the promotional emails|remove me from marketing lists", "marketing_opt_out"),
    (r"download my account information|send me a copy of the information|"
     r"copy of last year'?s invoices|what personal information you hold", "access"),
]

DELETION_SET = re.compile("|".join(DELETION_TERMS), re.IGNORECASE)
NEGATION_SET = re.compile("|".join(HARD_NEGATIONS), re.IGNORECASE)


@dataclass
class Intent:
    is_deletion: bool
    label: str                       # "deletion" | "not_deletion" | "unclear"
    matched_terms: List[str] = field(default_factory=list)
    matched_negations: List[str] = field(default_factory=list)
    non_deletion_action: str = ""

    def to_dict(self) -> dict:
        return {
            "is_deletion": self.is_deletion,
            "label": self.label,
            "matched_terms": self.matched_terms,
            "matched_negations": self.matched_negations,
            "non_deletion_action": self.non_deletion_action,
        }


def classify(text: str) -> Intent:
    body = (text or "").strip()
    if not body:
        return Intent(False, "unclear")

    negations = sorted({m.group(0).lower() for m in NEGATION_SET.finditer(body)})
    if negations:
        return Intent(False, "not_deletion", matched_negations=negations)

    terms = sorted({m.group(0).lower() for m in DELETION_SET.finditer(body)})
    action = ""
    for pattern, label in NON_DELETION_ACTIONS:
        if re.search(pattern, body, re.IGNORECASE):
            action = label
            break

    if terms:
        return Intent(True, "deletion", matched_terms=terms,
                      non_deletion_action=action)
    if action:
        return Intent(False, "not_deletion", non_deletion_action=action)
    return Intent(False, "unclear")
