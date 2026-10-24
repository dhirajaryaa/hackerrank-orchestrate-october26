import { makeRecord } from './model.js';
import { findEmails, findUserRefs } from './util.js';

const EVENT_MAP = {
  DELETE_RECORD: ['__same__', 'ABSENT', 'PRESENT'],
  REDACT_RECORD: ['__same__', 'REDACTED', 'PRESENT'],
  ANONYMIZE_RECORD: ['__same__', 'ANONYMIZED', 'PRESENT'],
  DISABLE_DATA_FLOW: ['DATA_FLOW', 'DISABLED', 'ACTIVE'],
  BLOCK_RESTORE: ['BACKUP_ARCHIVE', 'BLOCKED', 'ACTIVE'],
  RETAIN_RECORD: ['__same__', 'RETAINED', 'RETAINED'],
  RESTORE_BACKUP: ['BACKUP_ARCHIVE', 'ACTIVE', 'ACTIVE'],
  SYNC_RECORD: ['__same__', 'ACTIVE', 'ACTIVE'],
  INDEX_RECORD: ['SEARCH_INDEX_ENTRY', 'ACTIVE', 'ACTIVE'],
  CREATE_EXPORT: ['USER_EXPORT', 'ACTIVE', 'ACTIVE'],
  UPDATE_RECORD: ['__same__', 'PRESENT', 'PRESENT'],
  CHECK_DATA_FLOW: ['DATA_FLOW', 'ACTIVE', 'DISABLED'],
  CHECK_RESTORE_ACCESS: ['BACKUP_ARCHIVE', 'ACTIVE', 'BLOCKED'],
  SEND_EMAIL: ['EMAIL_DELIVERY_LOG', 'PRESENT', 'PRESENT'],
  REFRESH_CACHE: ['CACHE_ENTRY', 'PRESENT', 'PRESENT'],
  LINK_RESOURCE_IDENTITY: ['__same__', 'REFERENCED', 'REFERENCED'],
  CLASSIFY_REQUEST: ['__same__', 'REFERENCED', 'REFERENCED'],
};

const RECORD_TYPE_BY_SYSTEM = {
  search_service: 'SEARCH_INDEX_ENTRY',
  analytics_platform: 'ANALYTICS_PROFILE',
  support_platform: 'SUPPORT_MESSAGE',
  support_storage_service: 'SUPPORT_ATTACHMENT',
  email_delivery_service: 'EMAIL_DELIVERY_LOG',
  cache_service: 'CACHE_ENTRY',
  object_store: 'SUPPORT_ATTACHMENT',
  object_storage: 'SUPPORT_ATTACHMENT',
  archive_service: 'BACKUP_ARCHIVE',
  backup_service: 'BACKUP_ARCHIVE',
  export_service: 'USER_EXPORT',
  integration_service: 'DATA_FLOW',
  identity_service: 'ACCOUNT_TOMBSTONE',
  marketing_platform: 'MARKETING_PROFILE',
  account_service: 'USER_PROFILE',
  account_replication_cluster: 'USER_PROFILE',
  account_failover_replica: 'USER_PROFILE',
  security_service: 'SECURITY_AUDIT_LOG',
  legal_service: 'LEGAL_HOLD_RECORD',
};

const STATE_BEARING_EVENTS = new Set([
  'DELETE_RECORD',
  'REDACT_RECORD',
  'ANONYMIZE_RECORD',
  'DISABLE_DATA_FLOW',
  'BLOCK_RESTORE',
  'RETAIN_RECORD',
  'RESTORE_BACKUP',
  'CHECK_DATA_FLOW',
  'CHECK_RESTORE_ACCESS',
]);

function recordTypeFor(system, eventType) {
  const mapped = EVENT_MAP[eventType]?.[0];
  if (mapped && mapped !== '__same__') return mapped;
  return RECORD_TYPE_BY_SYSTEM[system] || 'UNKNOWN';
}

function buildActivityRecords(events) {
  const out = [];
  for (const event of events) {
    if (!EVENT_MAP[event.event_type]) continue;
    const system = event.target_system || event.source_system;
    const success = event.reported_result.toUpperCase() === 'SUCCESS';
    const partial = event.reported_result.toUpperCase() === 'PARTIAL';
    const [, onSuccess, onFailure] = EVENT_MAP[event.event_type];
    const state = partial ? 'UNCERTAIN' : (success ? onSuccess : onFailure);
    const identifiers = {};
    const linkKeys = [];
    if (event.event_type === 'LINK_RESOURCE_IDENTITY') {
      const emails = findEmails(event.details);
      const users = findUserRefs(event.details);
      if (emails[0]) {
        linkKeys.push(emails[0]);
        identifiers.email = emails[0];
      }
      if (users[0]) {
        linkKeys.push(users[0]);
        identifiers.subject_reference = users[0];
      }
    }
    const record = makeRecord({
      evidenceId: event.activity_id,
      evidenceKind: 'activity',
      capturedAt: event.event_time,
      observedAt: event.event_time,
      system,
      resourceId: event.resource_id,
      recordType: recordTypeFor(system, event.event_type),
      state,
      identifiers,
      linkKeys,
      payload: { ...event, claim: true },
      parser: 'activity',
      sourcePath: 'system_activity.csv',
      notes: ['claim', `event_type=${event.event_type}`, `reported_result=${event.reported_result}`],
    });
    record.event = event;
    out.push(record);
  }
  return out;
}

function classifyRequests(events) {
  const out = new Map();
  for (const event of events) {
    if (event.event_type !== 'CLASSIFY_REQUEST') continue;
    out.set(event.resource_id, event);
  }
  return out;
}

function isStateBearing(record) {
  if (record.evidenceKind !== 'activity') return true;
  return STATE_BEARING_EVENTS.has(record.payload?.event_type);
}

export { buildActivityRecords, classifyRequests, isStateBearing, EVENT_MAP, STATE_BEARING_EVENTS };
