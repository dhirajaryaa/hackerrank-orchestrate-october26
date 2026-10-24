"""Paths, constant tables, and vocabulary mappings.

Every mapping in this file is justified by either `problem_statement.md`,
`deletion_rules.csv`, or the schema of the participant-facing dataset. Nothing
here encodes answers.
"""

from __future__ import annotations

import os

# ---------------------------------------------------------------------------
# Paths (resolved relative to the repository root, never hardcoded)
# ---------------------------------------------------------------------------

def _find_root(start: str) -> str:
    """Walk upwards until a directory containing ``dataset/`` is found."""
    current = start
    for _ in range(6):
        if os.path.isdir(os.path.join(current, "dataset")):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    return start


_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = _find_root(_HERE)
DATASET_DIR = os.path.join(ROOT_DIR, "dataset")
EVIDENCE_DIR = os.path.join(DATASET_DIR, "evidence")
BUILD_DIR = os.path.join(ROOT_DIR, "build")
OUTPUT_CSV = os.path.join(ROOT_DIR, "output.csv")

# ---------------------------------------------------------------------------
# Input tables
# ---------------------------------------------------------------------------

FILE_REQUESTS = "deletion_requests.csv"
FILE_SAMPLE_REQUESTS = "sample_deletion_requests.csv"
FILE_SAMPLE_OUTPUT = "sample_output.csv"
FILE_IDENTITIES = "user_identities.csv"
FILE_AUDIT_LOG = "user_audit_log.csv"
FILE_ACTIVITY = "system_activity.csv"
FILE_RULES = "deletion_rules.csv"
FILE_MANIFEST = "evidence_files.csv"

# ---------------------------------------------------------------------------
# Systems
# ---------------------------------------------------------------------------

# Resource-id prefix -> canonical system id. Derived from the prefix that
# appears in every evidence dialect.
PREFIX_TO_SYSTEM = {
    "account": "account_service",
    "search": "search_service",
    "analytics": "analytics_platform",
    "support": "support_platform",
    "export": "export_service",
    "data_flow": "integration_service",
    "backup": "backup_service",
    "audit_record": "security_service",
    "tombstone": "identity_service",
    "email_delivery": "email_delivery_service",
    "cache": "cache_service",
    "object": "object_storage",
    "marketing": "marketing_platform",
    "legal_hold": "legal_service",
    "archive": "backup_service",
    "order": "order_service",
}

# system id -> data category from deletion_rules.csv
SYSTEM_TO_CATEGORY = {
    "account_service": "USER_PROFILE",
    "account_replication_cluster": "USER_PROFILE",
    "account_failover_replica": "USER_PROFILE",
    "identity_service": "ACCOUNT_TOMBSTONE",
    "search_service": "SEARCH_INDEX_ENTRY",
    "cache_service": "CACHE_ENTRY",
    "support_platform": "SUPPORT_MESSAGE",
    "analytics_platform": "ANALYTICS_PROFILE",
    "product_telemetry": "PRODUCT_TELEMETRY",
    "export_service": "USER_EXPORT",
    "marketing_platform": "MARKETING_PROFILE",
    "email_delivery_service": "EMAIL_DELIVERY_LOG",
    "security_service": "SECURITY_AUDIT_LOG",
    "legal_service": "LEGAL_HOLD_RECORD",
    "backup_service": "BACKUP_ARCHIVE",
    "backup_restore_service": "BACKUP_ARCHIVE",
    "archive_service": "BACKUP_ARCHIVE",
    "integration_service": "DATA_FLOW",
    "object_storage": "SUPPORT_ATTACHMENT",
    "object_store": "SUPPORT_ATTACHMENT",
    "support_storage_service": "SUPPORT_MESSAGE",
    "privacy_treatment_service": "OPERATIONAL_HISTORY",
}

# record_type / collection name -> data category
RECORD_TYPE_TO_CATEGORY = {
    "USER_PROFILE": "USER_PROFILE",
    "SECONDARY_IDENTIFIER": "SECONDARY_IDENTIFIER",
    "SEARCH_INDEX_ENTRY": "SEARCH_INDEX_ENTRY",
    "CACHE_ENTRY": "CACHE_ENTRY",
    "SUPPORT_MESSAGE": "SUPPORT_MESSAGE",
    "SUPPORT_ATTACHMENT": "SUPPORT_ATTACHMENT",
    "ANALYTICS_PROFILE": "ANALYTICS_PROFILE",
    "PRODUCT_TELEMETRY": "PRODUCT_TELEMETRY",
    "USER_EXPORT": "USER_EXPORT",
    "MARKETING_PROFILE": "MARKETING_PROFILE",
    "EMAIL_DELIVERY_LOG": "EMAIL_DELIVERY_LOG",
    "SECURITY_AUDIT_LOG": "SECURITY_AUDIT_LOG",
    "LEGAL_HOLD_RECORD": "LEGAL_HOLD_RECORD",
    "BACKUP_ARCHIVE": "BACKUP_ARCHIVE",
    "ACCOUNT_TOMBSTONE": "ACCOUNT_TOMBSTONE",
    "DATA_FLOW": "DATA_FLOW",
    "OPERATIONAL_HISTORY": "OPERATIONAL_HISTORY",
}

# Collection names used inside SQL snapshots / JSON snapshot bundles.
COLLECTION_TO_RECORD_TYPE = {
    "customer_profiles": "USER_PROFILE",
    "customer_profiles_primary": "USER_PROFILE",
    "customer_profiles_failover_replica": "USER_PROFILE",
    "customer_search_documents": "SEARCH_INDEX_ENTRY",
    "customer_analytics_profiles": "ANALYTICS_PROFILE",
    "customer_analytics_reports": "ANALYTICS_PROFILE",
    "support_records": "SUPPORT_MESSAGE",
    "support_conversations": "SUPPORT_MESSAGE",
    "customer_exports": "USER_EXPORT",
    "customer_export_jobs": "USER_EXPORT",
    "connector_subscriptions": "DATA_FLOW",
    "connector_configurations": "DATA_FLOW",
    "backup_restore_entries": "BACKUP_ARCHIVE",
    "backup_catalog": "BACKUP_ARCHIVE",
    "security_audit_records": "SECURITY_AUDIT_LOG",
    "security_audit_events": "SECURITY_AUDIT_LOG",
    "deleted_customer_references": "ACCOUNT_TOMBSTONE",
    "marketing_profiles": "MARKETING_PROFILE",
    "email_delivery_log": "EMAIL_DELIVERY_LOG",
    "legal_hold_records": "LEGAL_HOLD_RECORD",
    "ticket_attachments": "SUPPORT_ATTACHMENT",
    "retained_order_records": "LEGAL_HOLD_RECORD",
}

# ---------------------------------------------------------------------------
# States
# ---------------------------------------------------------------------------

# Canonical observation states. `ABSENT` is deliberately distinct from
# "unknown": it is only assigned when a source explicitly reports a miss.
STATE_ABSENT = "ABSENT"
STATE_PRESENT = "PRESENT"
STATE_IDENTIFIABLE = "IDENTIFIABLE"
STATE_REDACTED = "REDACTED"
STATE_ANONYMIZED = "ANONYMIZED"
STATE_ACTIVE = "ACTIVE"
STATE_DISABLED = "DISABLED"
STATE_BLOCKED = "BLOCKED"
STATE_RETAINED = "RETAINED"

# Raw source token (upper-cased) -> canonical state.
RAW_STATE = {
    # record existence
    "FOUND": STATE_PRESENT,
    "PRESENT": STATE_PRESENT,
    "HIT": STATE_PRESENT,
    "200": STATE_PRESENT,
    "EXISTS": STATE_PRESENT,
    "NOT_FOUND": STATE_ABSENT,
    "ABSENT": STATE_ABSENT,
    "MISS": STATE_ABSENT,
    "404": STATE_ABSENT,
    "DELETED": STATE_ABSENT,
    "GONE": STATE_ABSENT,
    # identifier exposure
    "IDENTIFIABLE": STATE_IDENTIFIABLE,
    "EXPOSED": STATE_IDENTIFIABLE,
    "PARTIAL": STATE_IDENTIFIABLE,
    "REDACTED": STATE_REDACTED,
    "ANONYMIZED": STATE_ANONYMIZED,
    "ANONYMISED": STATE_ANONYMIZED,
    # processes
    "ACTIVE": STATE_ACTIVE,
    "ENABLED": STATE_ACTIVE,
    "RUNNING": STATE_ACTIVE,
    "RESTORE_ALLOWED": STATE_ACTIVE,
    "DISABLED": STATE_DISABLED,
    "STOPPED": STATE_DISABLED,
    "INACTIVE": STATE_DISABLED,
    "BLOCKED": STATE_BLOCKED,
    "RESTORE_BLOCKED": STATE_BLOCKED,
    # retention
    "RETAINED": STATE_RETAINED,
    "RETAIN": STATE_RETAINED,
    "SUCCESS": STATE_PRESENT,
    "FAILED": "FAILED",
}

# ---------------------------------------------------------------------------
# Log event vocabulary
# ---------------------------------------------------------------------------

# Event name -> (record_type, hint about where the state lives)
LOG_EVENT_KINDS = {
    "profile_lookup_completed": "USER_PROFILE",
    "record_lookup": None,  # record_type supplied in the line itself
    "index_query_completed": "SEARCH_INDEX_ENTRY",
    "analytics_profile_read_completed": "ANALYTICS_PROFILE",
    "analytics_profile_scan_completed": "ANALYTICS_PROFILE",
    "support_ticket_read_completed": "SUPPORT_MESSAGE",
    "support_attachment_read_completed": "SUPPORT_ATTACHMENT",
    "audit_record_read_completed": "SECURITY_AUDIT_LOG",
    "connector_config_read_completed": "DATA_FLOW",
    "restore_policy_read_completed": "BACKUP_ARCHIVE",
    "contact_query_completed": "SUPPORT_MESSAGE",
    "export_job_read_completed": "USER_EXPORT",
    "marketing_profile_read_completed": "MARKETING_PROFILE",
    "email_log_read_completed": "EMAIL_DELIVERY_LOG",
    "cache_entry_read_completed": "CACHE_ENTRY",
    "tombstone_read_completed": "ACCOUNT_TOMBSTONE",
}

# Identifier fields we treat as a direct link to a person.
IDENTIFIER_FIELDS = ("email", "phone", "email_hash", "full_name", "name", "display_name",
                     "requester_email", "requester_phone", "requester_name",
                     "owner_email", "owner_phone", "customer_email", "customer_reference",
                     "subject_reference", "user_id", "profile", "document")

# Fields that identify the record rather than the person.
RESOURCE_FIELDS = ("resource_id", "record_type", "account_status", "event_code",
                   "event_name", "archive_key", "object_key", "connector_name",
                   "index_name", "audience_cohort", "retention_until",
                   "last_delivery_status", "enabled", "restore_allowed")

# ---------------------------------------------------------------------------
# Output contract
# ---------------------------------------------------------------------------

PHASE_ORDER = {"FINDING": 0, "REMEDIATION": 1, "VERIFICATION": 2}

OPERATION_ORDER = {
    "REPORT_REMAINING_RECORD": 0,
    "REPORT_EXPOSED_PII": 1,
    "REPORT_ACTIVE_DATA_FLOW": 2,
    "REPORT_RESTORE_RISK": 3,
    "DISABLE_DATA_FLOW": 4,
    "BLOCK_RESTORE": 5,
    "DELETE_RECORD": 6,
    "REDACT_RECORD": 7,
    "ANONYMIZE_RECORD": 8,
    "VERIFY_RECORD_ABSENT": 9,
    "VERIFY_RECORD_PRESENT": 10,
    "VERIFY_RECORD_REDACTED": 11,
    "VERIFY_RECORD_ANONYMIZED": 12,
    "VERIFY_DATA_FLOW_DISABLED": 13,
    "VERIFY_RESTORE_BLOCKED": 14,
}

OPERATION_STATE = {
    "REPORT_REMAINING_RECORD": "PRESENT",
    "REPORT_EXPOSED_PII": "PRESENT",
    "REPORT_ACTIVE_DATA_FLOW": "ACTIVE",
    "REPORT_RESTORE_RISK": "ACTIVE",
    "DISABLE_DATA_FLOW": "DISABLED",
    "BLOCK_RESTORE": "BLOCKED",
    "DELETE_RECORD": "ABSENT",
    "REDACT_RECORD": "REDACTED",
    "ANONYMIZE_RECORD": "ANONYMIZED",
    "VERIFY_RECORD_ABSENT": "ABSENT",
    "VERIFY_RECORD_PRESENT": "PRESENT",
    "VERIFY_RECORD_REDACTED": "REDACTED",
    "VERIFY_RECORD_ANONYMIZED": "ANONYMIZED",
    "VERIFY_DATA_FLOW_DISABLED": "DISABLED",
    "VERIFY_RESTORE_BLOCKED": "BLOCKED",
}

# data category -> (finding operation, remediation operation, verification operation)
CATEGORY_ACTIONS = {
    "USER_PROFILE": ("REPORT_REMAINING_RECORD", "DELETE_RECORD", "VERIFY_RECORD_ABSENT"),
    "SECONDARY_IDENTIFIER": ("REPORT_REMAINING_RECORD", "DELETE_RECORD", "VERIFY_RECORD_ABSENT"),
    "SEARCH_INDEX_ENTRY": ("REPORT_REMAINING_RECORD", "DELETE_RECORD", "VERIFY_RECORD_ABSENT"),
    "CACHE_ENTRY": ("REPORT_REMAINING_RECORD", "DELETE_RECORD", "VERIFY_RECORD_ABSENT"),
    "SUPPORT_MESSAGE": ("REPORT_EXPOSED_PII", "REDACT_RECORD", "VERIFY_RECORD_REDACTED"),
    "SUPPORT_ATTACHMENT": ("REPORT_REMAINING_RECORD", "DELETE_RECORD", "VERIFY_RECORD_ABSENT"),
    "ANALYTICS_PROFILE": ("REPORT_EXPOSED_PII", "ANONYMIZE_RECORD", "VERIFY_RECORD_ANONYMIZED"),
    "PRODUCT_TELEMETRY": ("REPORT_EXPOSED_PII", "ANONYMIZE_RECORD", "VERIFY_RECORD_ANONYMIZED"),
    "USER_EXPORT": ("REPORT_REMAINING_RECORD", "DELETE_RECORD", "VERIFY_RECORD_ABSENT"),
    "MARKETING_PROFILE": ("REPORT_REMAINING_RECORD", "DELETE_RECORD", "VERIFY_RECORD_ABSENT"),
    "EMAIL_DELIVERY_LOG": ("REPORT_EXPOSED_PII", "REDACT_RECORD", "VERIFY_RECORD_REDACTED"),
    "SECURITY_AUDIT_LOG": (None, None, "VERIFY_RECORD_PRESENT"),
    "LEGAL_HOLD_RECORD": (None, None, "VERIFY_RECORD_PRESENT"),
    "BACKUP_ARCHIVE": ("REPORT_RESTORE_RISK", "BLOCK_RESTORE", "VERIFY_RESTORE_BLOCKED"),
    "ACCOUNT_TOMBSTONE": ("REPORT_EXPOSED_PII", "REDACT_RECORD", "VERIFY_RECORD_REDACTED"),
    "DATA_FLOW": ("REPORT_ACTIVE_DATA_FLOW", "DISABLE_DATA_FLOW", "VERIFY_DATA_FLOW_DISABLED"),
}
