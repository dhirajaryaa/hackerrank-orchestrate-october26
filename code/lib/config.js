import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(start = __dirname) {
  let current = start;
  for (let i = 0; i < 8; i += 1) {
    try {
      if (fs.existsSync(path.join(current, 'dataset'))) return current;
    } catch {
      // ignore
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(start, '..', '..');
}

const ROOT_DIR = findRepoRoot();
const DATASET_DIR = path.join(ROOT_DIR, 'dataset');
const EVIDENCE_DIR = path.join(DATASET_DIR, 'evidence');
const BUILD_DIR = path.join(ROOT_DIR, 'build');

const PREFIX_TO_SYSTEM = {
  account: 'account_service',
  search: 'search_service',
  analytics: 'analytics_platform',
  support: 'support_platform',
  export: 'export_service',
  data_flow: 'integration_service',
  backup: 'backup_service',
  audit_record: 'security_service',
  tombstone: 'identity_service',
  email_delivery: 'email_delivery_service',
  cache: 'cache_service',
  object: 'object_storage',
  marketing: 'marketing_platform',
  legal_hold: 'legal_service',
  archive: 'backup_service',
  order: 'legal_service',
};

const SYSTEM_TO_CATEGORY = {
  account_service: 'USER_PROFILE',
  account_replication_cluster: 'USER_PROFILE',
  account_failover_replica: 'USER_PROFILE',
  identity_service: 'ACCOUNT_TOMBSTONE',
  search_service: 'SEARCH_INDEX_ENTRY',
  cache_service: 'CACHE_ENTRY',
  support_platform: 'SUPPORT_MESSAGE',
  support_storage_service: 'SUPPORT_MESSAGE',
  analytics_platform: 'ANALYTICS_PROFILE',
  product_telemetry: 'PRODUCT_TELEMETRY',
  export_service: 'USER_EXPORT',
  marketing_platform: 'MARKETING_PROFILE',
  email_delivery_service: 'EMAIL_DELIVERY_LOG',
  security_service: 'SECURITY_AUDIT_LOG',
  legal_service: 'LEGAL_HOLD_RECORD',
  backup_service: 'BACKUP_ARCHIVE',
  backup_restore_service: 'BACKUP_ARCHIVE',
  archive_service: 'BACKUP_ARCHIVE',
  integration_service: 'DATA_FLOW',
  object_storage: 'SUPPORT_ATTACHMENT',
  object_store: 'SUPPORT_ATTACHMENT',
  privacy_treatment_service: 'OPERATIONAL_HISTORY',
};

const RECORD_TYPE_TO_CATEGORY = {
  USER_PROFILE: 'USER_PROFILE',
  SECONDARY_IDENTIFIER: 'SECONDARY_IDENTIFIER',
  SEARCH_INDEX_ENTRY: 'SEARCH_INDEX_ENTRY',
  CACHE_ENTRY: 'CACHE_ENTRY',
  SUPPORT_MESSAGE: 'SUPPORT_MESSAGE',
  SUPPORT_ATTACHMENT: 'SUPPORT_ATTACHMENT',
  ANALYTICS_PROFILE: 'ANALYTICS_PROFILE',
  PRODUCT_TELEMETRY: 'PRODUCT_TELEMETRY',
  USER_EXPORT: 'USER_EXPORT',
  MARKETING_PROFILE: 'MARKETING_PROFILE',
  EMAIL_DELIVERY_LOG: 'EMAIL_DELIVERY_LOG',
  SECURITY_AUDIT_LOG: 'SECURITY_AUDIT_LOG',
  LEGAL_HOLD_RECORD: 'LEGAL_HOLD_RECORD',
  BACKUP_ARCHIVE: 'BACKUP_ARCHIVE',
  ACCOUNT_TOMBSTONE: 'ACCOUNT_TOMBSTONE',
  DATA_FLOW: 'DATA_FLOW',
  OPERATIONAL_HISTORY: 'OPERATIONAL_HISTORY',
};

const COLLECTION_TO_RECORD_TYPE = {
  customer_profiles: 'USER_PROFILE',
  customer_profiles_primary: 'USER_PROFILE',
  customer_profiles_failover_replica: 'USER_PROFILE',
  customer_profiles_read_replica: 'USER_PROFILE',
  customer_profiles_reporting_replica: 'USER_PROFILE',
  customer_search_documents: 'SEARCH_INDEX_ENTRY',
  search_documents: 'SEARCH_INDEX_ENTRY',
  search_documents_primary: 'SEARCH_INDEX_ENTRY',
  customer_analytics_profiles: 'ANALYTICS_PROFILE',
  customer_analytics_reports: 'ANALYTICS_PROFILE',
  analytics_profiles: 'ANALYTICS_PROFILE',
  support_records: 'SUPPORT_MESSAGE',
  support_conversations: 'SUPPORT_MESSAGE',
  customer_exports: 'USER_EXPORT',
  customer_export_jobs: 'USER_EXPORT',
  connector_subscriptions: 'DATA_FLOW',
  connector_configurations: 'DATA_FLOW',
  backup_restore_entries: 'BACKUP_ARCHIVE',
  backup_catalog: 'BACKUP_ARCHIVE',
  security_audit_records: 'SECURITY_AUDIT_LOG',
  security_audit_events: 'SECURITY_AUDIT_LOG',
  deleted_customer_references: 'ACCOUNT_TOMBSTONE',
  marketing_profiles: 'MARKETING_PROFILE',
  email_delivery_log: 'EMAIL_DELIVERY_LOG',
  legal_hold_records: 'LEGAL_HOLD_RECORD',
  retained_order_records: 'LEGAL_HOLD_RECORD',
  ticket_attachments: 'SUPPORT_ATTACHMENT',
  customer_data_primary: 'USER_PROFILE',
  customer_data_failover_replica: 'USER_PROFILE',
  customer_data_read_replica: 'USER_PROFILE',
  customer_data_reporting_replica: 'USER_PROFILE',
  customer_data_regional_replicas: 'USER_PROFILE',
};

const DIRECT_IDENTIFIER_FIELDS = new Set([
  'email', 'phone', 'email_hash', 'full_name', 'name', 'display_name',
  'requester_email', 'requester_phone', 'requester_name', 'owner_email',
  'owner_phone', 'customer_email', 'matched_value', 'requester_name',
]);

const PHASE_ORDER = { FINDING: 0, REMEDIATION: 1, VERIFICATION: 2 };
const OPERATION_ORDER = {
  REPORT_REMAINING_RECORD: 0,
  REPORT_EXPOSED_PII: 1,
  REPORT_ACTIVE_DATA_FLOW: 2,
  REPORT_RESTORE_RISK: 3,
  DISABLE_DATA_FLOW: 4,
  BLOCK_RESTORE: 5,
  DELETE_RECORD: 6,
  REDACT_RECORD: 7,
  ANONYMIZE_RECORD: 8,
  VERIFY_RECORD_ABSENT: 9,
  VERIFY_RECORD_PRESENT: 10,
  VERIFY_RECORD_REDACTED: 11,
  VERIFY_RECORD_ANONYMIZED: 12,
  VERIFY_DATA_FLOW_DISABLED: 13,
  VERIFY_RESTORE_BLOCKED: 14,
};

const STATE_PLAN = {
  USER_PROFILE: {
    ABSENT: [null, null, 'VERIFY_RECORD_ABSENT'],
    PRESENT: ['REPORT_REMAINING_RECORD', 'DELETE_RECORD', 'VERIFY_RECORD_ABSENT'],
    IDENTIFIABLE: ['REPORT_REMAINING_RECORD', 'DELETE_RECORD', 'VERIFY_RECORD_ABSENT'],
    REDACTED: [null, null, 'VERIFY_RECORD_ABSENT'],
  },
  SECONDARY_IDENTIFIER: {
    ABSENT: [null, null, 'VERIFY_RECORD_ABSENT'],
    PRESENT: ['REPORT_REMAINING_RECORD', 'DELETE_RECORD', 'VERIFY_RECORD_ABSENT'],
  },
  SEARCH_INDEX_ENTRY: {
    ABSENT: [null, null, 'VERIFY_RECORD_ABSENT'],
    PRESENT: ['REPORT_REMAINING_RECORD', 'DELETE_RECORD', 'VERIFY_RECORD_ABSENT'],
  },
  CACHE_ENTRY: {
    ABSENT: [null, null, 'VERIFY_RECORD_ABSENT'],
    PRESENT: ['REPORT_REMAINING_RECORD', 'DELETE_RECORD', 'VERIFY_RECORD_ABSENT'],
  },
  USER_EXPORT: {
    ABSENT: [null, null, 'VERIFY_RECORD_ABSENT'],
    PRESENT: ['REPORT_REMAINING_RECORD', 'DELETE_RECORD', 'VERIFY_RECORD_ABSENT'],
  },
  MARKETING_PROFILE: {
    ABSENT: [null, null, 'VERIFY_RECORD_ABSENT'],
    PRESENT: ['REPORT_REMAINING_RECORD', 'DELETE_RECORD', 'VERIFY_RECORD_ABSENT'],
  },
  SUPPORT_ATTACHMENT: {
    ABSENT: [null, null, 'VERIFY_RECORD_ABSENT'],
    PRESENT: ['REPORT_REMAINING_RECORD', 'DELETE_RECORD', 'VERIFY_RECORD_ABSENT'],
  },
  SUPPORT_MESSAGE: {
    ABSENT: [null, null, 'VERIFY_RECORD_ABSENT'],
    REDACTED: [null, null, 'VERIFY_RECORD_REDACTED'],
    PRESENT: ['REPORT_EXPOSED_PII', 'REDACT_RECORD', 'VERIFY_RECORD_REDACTED'],
    IDENTIFIABLE: ['REPORT_EXPOSED_PII', 'REDACT_RECORD', 'VERIFY_RECORD_REDACTED'],
  },
  ANALYTICS_PROFILE: {
    ABSENT: [null, null, 'VERIFY_RECORD_ABSENT'],
    ANONYMIZED: [null, null, 'VERIFY_RECORD_ANONYMIZED'],
    PRESENT: ['REPORT_EXPOSED_PII', 'ANONYMIZE_RECORD', 'VERIFY_RECORD_ANONYMIZED'],
    IDENTIFIABLE: ['REPORT_EXPOSED_PII', 'ANONYMIZE_RECORD', 'VERIFY_RECORD_ANONYMIZED'],
  },
  PRODUCT_TELEMETRY: {
    ABSENT: [null, null, 'VERIFY_RECORD_ABSENT'],
    ANONYMIZED: [null, null, 'VERIFY_RECORD_ANONYMIZED'],
    PRESENT: ['REPORT_EXPOSED_PII', 'ANONYMIZE_RECORD', 'VERIFY_RECORD_ANONYMIZED'],
    IDENTIFIABLE: ['REPORT_EXPOSED_PII', 'ANONYMIZE_RECORD', 'VERIFY_RECORD_ANONYMIZED'],
  },
  EMAIL_DELIVERY_LOG: {
    ABSENT: [null, null, 'VERIFY_RECORD_ABSENT'],
    REDACTED: [null, null, 'VERIFY_RECORD_REDACTED'],
    PRESENT: ['REPORT_EXPOSED_PII', 'REDACT_RECORD', 'VERIFY_RECORD_REDACTED'],
    IDENTIFIABLE: ['REPORT_EXPOSED_PII', 'REDACT_RECORD', 'VERIFY_RECORD_REDACTED'],
  },
  SECURITY_AUDIT_LOG: {
    PRESENT: [null, null, 'VERIFY_RECORD_PRESENT'],
    RETAINED: [null, null, 'VERIFY_RECORD_PRESENT'],
    ABSENT: [null, null, 'VERIFY_RECORD_ABSENT'],
  },
  LEGAL_HOLD_RECORD: {
    PRESENT: [null, null, 'VERIFY_RECORD_PRESENT'],
    RETAINED: [null, null, 'VERIFY_RECORD_PRESENT'],
  },
  BACKUP_ARCHIVE: {
    ABSENT: [null, null, 'VERIFY_RECORD_ABSENT'],
    ACTIVE: ['REPORT_RESTORE_RISK', 'BLOCK_RESTORE', 'VERIFY_RESTORE_BLOCKED'],
    BLOCKED: [null, null, 'VERIFY_RESTORE_BLOCKED'],
  },
  DATA_FLOW: {
    ABSENT: [null, null, 'VERIFY_RECORD_ABSENT'],
    ACTIVE: ['REPORT_ACTIVE_DATA_FLOW', 'DISABLE_DATA_FLOW', 'VERIFY_DATA_FLOW_DISABLED'],
    DISABLED: [null, null, 'VERIFY_DATA_FLOW_DISABLED'],
  },
  ACCOUNT_TOMBSTONE: {
    ABSENT: [null, null, 'VERIFY_RECORD_ABSENT'],
    REDACTED: [null, null, 'VERIFY_RECORD_REDACTED'],
    PRESENT: ['REPORT_EXPOSED_PII', 'REDACT_RECORD', 'VERIFY_RECORD_REDACTED'],
    IDENTIFIABLE: ['REPORT_EXPOSED_PII', 'REDACT_RECORD', 'VERIFY_RECORD_REDACTED'],
  },
};

const OPERATION_STATE = {
  REPORT_REMAINING_RECORD: 'PRESENT',
  REPORT_EXPOSED_PII: 'PRESENT',
  REPORT_ACTIVE_DATA_FLOW: 'ACTIVE',
  REPORT_RESTORE_RISK: 'ACTIVE',
  DISABLE_DATA_FLOW: 'DISABLED',
  BLOCK_RESTORE: 'BLOCKED',
  DELETE_RECORD: 'ABSENT',
  REDACT_RECORD: 'REDACTED',
  ANONYMIZE_RECORD: 'ANONYMIZED',
  VERIFY_RECORD_ABSENT: 'ABSENT',
  VERIFY_RECORD_PRESENT: 'PRESENT',
  VERIFY_RECORD_REDACTED: 'REDACTED',
  VERIFY_RECORD_ANONYMIZED: 'ANONYMIZED',
  VERIFY_DATA_FLOW_DISABLED: 'DISABLED',
  VERIFY_RESTORE_BLOCKED: 'BLOCKED',
};

export {
  ROOT_DIR,
  DATASET_DIR,
  EVIDENCE_DIR,
  BUILD_DIR,
  PREFIX_TO_SYSTEM,
  SYSTEM_TO_CATEGORY,
  RECORD_TYPE_TO_CATEGORY,
  COLLECTION_TO_RECORD_TYPE,
  DIRECT_IDENTIFIER_FIELDS,
  PHASE_ORDER,
  OPERATION_ORDER,
  STATE_PLAN,
  OPERATION_STATE,
};
