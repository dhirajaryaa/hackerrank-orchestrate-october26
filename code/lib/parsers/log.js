import fs from 'node:fs';
import { makeRecord, guessRecordType, guessSystem } from '../model.js';
import { splitKv } from '../util.js';

const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/;
const PIPE_RE = /^(\d{4}-\d{2}-\d{2}T\S+)\s*\|\s*(\w+)\s*\|\s*([^\s|]+)\s*\|\s*([^\s|]+)\s*\|\s*([^\s|]+)\s*\|(.*)$/;
const BRACKET_RE = /^(\d{4}-\d{2}-\d{2}T\S+)\s*\[(\w+)\]\s*\[([^\]]+)\]\s*\[([^\]]+)\]\s*([A-Za-z0-9_]+):?(.*)$/;
const SYSLOG_RE = /^(\d{4}-\d{2}-\d{2}T\S+)\s*<\d+>\d\s+\S+\s+([^\s]+)\s+([^\s]+)\s+-\s+-(.*)$/;
const CLOUD_RE = /^(\d{4}-\d{2}-\d{2}T\S+)\s+(?:requestId=\S+\s+)?level=\w+\s+function=([^\s]+)\s+(.*)$/;
const FLAT_RE = /^(\d{4}-\d{2}-\d{2}T\S+)\s+(INFO|DEBUG|WARN|ERROR)\s+service=([^\s]+)\s+(.*)$/;

const PERSON_FIELDS = [
  'email', 'phone', 'email_hash', 'customer_reference', 'subject_reference',
  'subject_selector', 'requester_name', 'requester_email', 'requester_phone',
  'owner_email', 'owner_phone', 'customer_email', 'display_name', 'full_name',
  'user_id',
];

const STATE_EVENTS = {
  profile_lookup_completed: 'account_service',
  index_query_completed: 'search_service',
  analytics_profile_read: 'analytics_platform',
  analytics_profile_read_completed: 'analytics_platform',
  analytics_profile_scan_completed: 'analytics_platform',
  analytics_identity_scan: 'analytics_platform',
  support_ticket_read_completed: 'support_platform',
  support_attachment_read_completed: 'support_platform',
  message_pii_scan: 'support_platform',
  attachment_pii_scan: 'support_platform',
  audit_record_read_completed: 'security_service',
  connector_config_read_completed: 'integration_service',
  connector_heartbeat: 'integration_service',
  restore_policy_read_completed: 'backup_service',
  restore_candidate_evaluated: 'backup_service',
  contact_query_completed: 'support_platform',
  contact_lookup_completed: 'analytics_platform',
  export_job_read_completed: 'export_service',
  export_metadata_read_completed: 'export_service',
  export_download_check_completed: 'export_service',
  marketing_profile_read_completed: 'marketing_platform',
  email_log_read_completed: 'email_delivery_service',
  cache_entry_read_completed: 'cache_service',
  tombstone_read_completed: 'identity_service',
  record_lookup: null,
};

const EXPOSURE_EVENTS = {
  message_pii_scan: 'SUPPORT_MESSAGE',
  attachment_pii_scan: 'SUPPORT_ATTACHMENT',
  analytics_identity_scan: 'ANALYTICS_PROFILE',
};

const RECORD_TYPE_OVERRIDES = {
  contact_lookup_completed: 'CACHE_ENTRY',
  contact_query_completed: 'SUPPORT_ATTACHMENT',
  support_attachment_read_completed: 'SUPPORT_ATTACHMENT',
  support_ticket_read_completed: 'SUPPORT_MESSAGE',
  analytics_profile_read: 'ANALYTICS_PROFILE',
  analytics_profile_read_completed: 'ANALYTICS_PROFILE',
  analytics_profile_scan_completed: 'ANALYTICS_PROFILE',
  analytics_identity_scan: 'ANALYTICS_PROFILE',
  cache_entry_read_completed: 'CACHE_ENTRY',
  restore_policy_read_completed: 'BACKUP_ARCHIVE',
  restore_candidate_evaluated: 'BACKUP_ARCHIVE',
  connector_config_read_completed: 'DATA_FLOW',
  connector_heartbeat: 'DATA_FLOW',
  export_job_read_completed: 'USER_EXPORT',
  export_metadata_read_completed: 'USER_EXPORT',
  export_download_check_completed: 'USER_EXPORT',
};

const LINK_KEY_FIELDS = [
  'lookup_key', 'correlation_key', 'subject_key', 'scan_key', 'owner_key',
  'match_key', 'subject_ref', 'matched_value', 'subject_reference',
  'subject_selector',
];

const NOISE_EVENTS = new Set([
  'export_started', 'export_completed', 'connection_acquired', 'pool_acquired',
  'dependency_retry', 'dependency_recovered', 'shard_scan', 'cache_lookup',
  'batch_started', 'batch_completed', 'message_scan_started',
  'attachment_scan_started', 'restore_policy_check_started',
  'export_download_check_started', 'analytics_profile_scan_started',
  'index_query_started', 'profile_lookup_started', 'audit_record_read_started',
  'audit_record_query_started', 'connector_config_read_started',
  'analytics_profile_read_started', 'support_ticket_read_started',
  'export_metadata_read_started', 'contact_query_started',
  'deletion_marker_check', 'deletion_marker_created', 'connector_heartbeat_ok',
  'cache_refresh', 'consumer_lag', 'timer_tick', 'disk_latency',
  'certificate_checked', 'lease_extended', 'checkpoint_saved',
  'delivery_abandoned', 'thumbnail_failed', 'batch_completed',
]);

function dialect(line) {
  const stripped = line.trim();
  if (!stripped) return ['blank', {}];

  let match = PIPE_RE.exec(stripped);
  if (match) {
    const [, ts, level, service, trace, event, rest] = match;
    return ['pipe', { ts, level, service, trace, event, fields: splitKv(rest) }];
  }

  match = BRACKET_RE.exec(stripped);
  if (match) {
    const [, ts, level, service, trace, event, rest] = match;
    return ['bracket', { ts, level, service, trace, event, fields: splitKv(rest) }];
  }

  const brace = stripped.indexOf('{');
  if (brace > 0 && /^\d/.test(stripped)) {
    const tsMatch = TS_RE.exec(stripped);
    if (tsMatch) {
      let payload = null;
      try {
        payload = JSON.parse(stripped.slice(brace));
      } catch {
        payload = null;
      }
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const fields = {};
        for (const [key, value] of Object.entries(payload)) {
          if (!['severity', 'logger', 'service', 'instance', 'pod', 'region', 'event'].includes(key)) fields[key] = value;
        }
        return ['json', {
          ts: tsMatch[1],
          level: payload.severity,
          service: payload.service || payload.logger,
          trace: payload.trace_id,
          event: payload.event,
          fields,
        }];
      }
    }
  }

  match = SYSLOG_RE.exec(stripped);
  if (match) {
    const [, ts, service, trace, rest] = match;
    const fields = splitKv(rest);
    return ['syslog', { ts, level: fields.level, service, trace, event: fields.event, fields }];
  }

  match = CLOUD_RE.exec(stripped);
  if (match) {
    const [, ts, fn, rest] = match;
    const fields = splitKv(rest);
    if (fields.message) {
      const nested = splitKv(fields.message);
      Object.assign(fields, nested);
    }
    return ['cloudruntime', {
      ts,
      level: fields.level,
      service: fn,
      trace: fields.requestId,
      event: fields.event,
      fields,
    }];
  }

  match = FLAT_RE.exec(stripped);
  if (match) {
    const [, ts, level, service, rest] = match;
    const fields = splitKv(rest);
    return ['flat', { ts, level, service, trace: fields.trace_id, event: fields.event, fields }];
  }

  const tsMatch = TS_RE.exec(stripped);
  if (tsMatch) {
    const fields = splitKv(stripped.slice(tsMatch[0].length));
    return ['logfmt', {
      ts: tsMatch[1],
      level: fields.level,
      service: fields.service,
      trace: fields.trace_id,
      event: fields.event,
      fields,
    }];
  }
  return ['unknown', {}];
}

function stateOf(name, fields) {
  if (EXPOSURE_EVENTS[name]) {
    return fields.matched_value || (fields.direct_identifiers && String(fields.direct_identifiers) !== '0') ? 'IDENTIFIABLE' : 'REDACTED';
  }
  if (name === 'record_lookup') {
    const token = String(fields.result || '').toUpperCase();
    return ['NOT_FOUND', 'MISS', 'ABSENT'].includes(token) ? 'ABSENT' : 'PRESENT';
  }
  if (name === 'profile_lookup_completed') {
    if (String(fields.http_status) === '404') return 'ABSENT';
    if (String(fields.rows) === '0') return 'ABSENT';
    return 'PRESENT';
  }
  if (name === 'index_query_completed') {
    return String(fields.result || '').toLowerCase() === 'miss' ? 'ABSENT' : 'PRESENT';
  }
  if (['analytics_profile_read', 'analytics_profile_read_completed', 'analytics_profile_scan_completed'].includes(name)) {
    const direct = fields.direct_identifiers !== undefined
      ? String(fields.direct_identifiers) !== '0'
      : ['customer_reference', 'email', 'phone', 'email_hash'].some((key) => {
        const value = fields[key];
        return value !== undefined && value !== null && value !== '' && value !== 'null';
      });
    return direct ? 'IDENTIFIABLE' : 'ANONYMIZED';
  }
  if (name === 'contact_lookup_completed') {
    return String(fields.rows || '1') === '0' ? 'ABSENT' : 'PRESENT';
  }
  if (['connector_config_read_completed', 'connector_heartbeat'].includes(name)) {
    return String(fields.enabled).toLowerCase() === 'true' ? 'ACTIVE' : 'DISABLED';
  }
  if (name === 'restore_policy_read_completed') {
    if (String(fields.archive_present).toLowerCase() === 'false') return 'ABSENT';
    return String(fields.restore_allowed).toLowerCase() === 'true' ? 'ACTIVE' : 'BLOCKED';
  }
  if (name === 'restore_candidate_evaluated') {
    if (String(fields.eligible).toLowerCase() !== 'true') return 'BLOCKED';
    return String(fields.deletion_block).toLowerCase() === 'true' ? 'BLOCKED' : 'ACTIVE';
  }
  if (['export_metadata_read_completed', 'export_download_check_completed'].includes(name)) {
    return String(fields.available).toLowerCase() === 'false' ? 'DISABLED' : 'PRESENT';
  }
  if (name === 'audit_record_read_completed') {
    return String(fields.rows || '1') !== '0' ? 'PRESENT' : 'ABSENT';
  }
  return 'PRESENT';
}

function parse(evidence) {
  const lines = fs.readFileSync(evidence.absolute_path, 'utf8').split(/\r?\n/);
  const parsed = [];
  const dialectCounts = {};

  for (const line of lines) {
    const [name, skeleton] = dialect(line);
    if (name === 'blank' || name === 'unknown' || !skeleton.event) continue;
    skeleton.dialect = name;
    parsed.push(skeleton);
    dialectCounts[name] = (dialectCounts[name] || 0) + 1;
  }

  const lookupKeys = new Map();
  const traceKeys = new Map();
  for (const event of parsed) {
    const fields = event.fields || {};
    let key = null;
    for (const fieldName of LINK_KEY_FIELDS) {
      if (fields[fieldName] !== undefined && fields[fieldName] !== null && fields[fieldName] !== '') {
        key = fields[fieldName];
        break;
      }
    }
    if (!key) continue;
    const resourceId = fields.resource_id;
    if (resourceId) {
      lookupKeys.set(`${event.service}|${resourceId}`, key);
      lookupKeys.set(`|${resourceId}`, key);
    }
    if (event.trace) {
      if (!traceKeys.has(event.trace)) traceKeys.set(event.trace, key);
    }
  }

  const records = [];
  for (const event of parsed) {
    const record = toRecord(evidence, event, lookupKeys, traceKeys);
    if (record) records.push(record);
  }

  const detail = Object.keys(dialectCounts).sort().map((k) => `${k}=${dialectCounts[k]}`).join(' ');
  return { records, detail: `lines=${lines.length} ${detail}`.trim() };
}

function toRecord(evidence, event, lookupKeys, traceKeys) {
  const name = event.event;
  if (NOISE_EVENTS.has(name) || !Object.prototype.hasOwnProperty.call(STATE_EVENTS, name)) return null;
  const fields = event.fields || {};
  const resourceId = fields.resource_id;
  if (!resourceId) return null;

  const service = event.service || '';
  let system = fields.system || STATE_EVENTS[name] || guessSystem(resourceId);
  let recordType = guessRecordType(system, null, fields.record_type);
  if (EXPOSURE_EVENTS[name]) recordType = EXPOSURE_EVENTS[name];
  if (RECORD_TYPE_OVERRIDES[name]) recordType = RECORD_TYPE_OVERRIDES[name];
  if (!recordType || recordType === 'UNKNOWN') recordType = guessRecordType(system, null, null);

  const identifiers = {};
  for (const key of PERSON_FIELDS) {
    const value = fields[key];
    if (value !== undefined && value !== null && value !== 'null' && value !== '') identifiers[key] = value;
  }
  const matched = fields.matched_value;
  if (matched) {
    if (String(matched).includes('@')) identifiers.email = matched;
    else if (String(matched).startsWith('+')) identifiers.phone = matched;
    else identifiers.matched_value = matched;
  }

  const linkKeys = [];
  const explicitKey = fields.lookup_key || fields.query || fields.correlation_key || fields.subject_key;
  if (explicitKey && explicitKey !== 'null') linkKeys.push(explicitKey);
  for (const candidate of [`${service}|${resourceId}`, `|${resourceId}`]) {
    const key = lookupKeys.get(candidate);
    if (key && key !== 'null' && !linkKeys.includes(key)) linkKeys.push(key);
  }
  if (event.trace && traceKeys.has(event.trace)) {
    const key = traceKeys.get(event.trace);
    if (key && key !== 'null' && !linkKeys.includes(key)) linkKeys.push(key);
  }

  const notes = [`event=${name}`, `dialect=${event.dialect}`];
  const payload = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!PERSON_FIELDS.includes(key)) payload[key] = value;
  }
  payload.event_name = name;
  return makeRecord({
    evidenceId: evidence.file_id,
    capturedAt: evidence.captured_at,
    observedAt: event.ts,
    system,
    resourceId,
    recordType,
    state: stateOf(name, fields),
    identifiers,
    linkKeys,
    payload,
    parser: 'log_events',
    sourcePath: evidence.file_path,
    notes,
  });
}

export { parse, dialect, splitKv, STATE_EVENTS };
