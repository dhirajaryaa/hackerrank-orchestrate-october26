import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { makeRecord, guessRecordType, guessSystem } from '../model.js';
import { readText } from '../util.js';

const TOPOLOGY_RE = /^--\s*Database topology:\s*(\S+)/m;
const CAPTURED_RE = /^--\s*Captured at:\s*(\S+)/m;

const PERSON_COLUMNS = [
  'customer_reference', 'user_id', 'subject_reference', 'subject_selector',
  'full_name', 'email', 'phone', 'email_hash', 'requester_name',
  'requester_email', 'requester_phone', 'owner_email', 'owner_phone',
  'customer_email', 'display_name',
];

const DIRECT_COLUMNS = [
  'full_name', 'email', 'phone', 'email_hash', 'requester_name',
  'requester_email', 'requester_phone', 'owner_email', 'owner_phone',
  'customer_email', 'display_name',
];

const TABLE_SYSTEM_HINTS = {
  customer_profiles: 'account_service',
  customer_data: 'replicated_store',
  customer_search_documents: 'search_service',
  customer_analytics_profiles: 'analytics_platform',
  customer_analytics_reports: 'analytics_platform',
  support_records: 'support_platform',
  support_conversations: 'support_platform',
  customer_exports: 'export_service',
  customer_export_jobs: 'export_service',
  backup_restore_entries: 'backup_service',
  backup_catalog: 'backup_service',
  connector_configurations: 'integration_service',
  connector_subscriptions: 'integration_service',
  security_audit_records: 'security_service',
  security_audit_events: 'security_service',
  deleted_customer_references: 'identity_service',
  marketing_profiles: 'marketing_platform',
  email_delivery_log: 'email_delivery_service',
  legal_hold_records: 'legal_service',
  ticket_attachments: 'support_platform',
  object_store_attachments: 'object_storage',
  cache_entries: 'cache_service',
};

function splitTable(name) {
  for (const suffix of [
    'failover_replica', 'read_replica', 'reporting_replica', 'regional_replicas',
    'replica_ap_south', 'replica_eu_west', 'primary',
  ]) {
    if (name.endsWith(`_${suffix}`)) return [name.slice(0, -(suffix.length + 1)), suffix];
    if (name.endsWith(suffix) && name !== suffix) {
      const base = name.slice(0, -suffix.length).replace(/_+$/, '');
      if (base) return [base, suffix];
    }
  }
  return [name, 'primary'];
}

function hasDirect(row) {
  for (const column of DIRECT_COLUMNS) {
    const value = row[column];
    if (value !== undefined && value !== null && value !== '' && value !== 'null') return true;
  }
  return false;
}

function stateFromRow(row) {
  const status = String(row.account_status || '').toUpperCase();
  if (['DELETED', 'TOMBSTONED'].includes(status)) return hasDirect(row) ? 'PRESENT' : 'REDACTED';
  if (row.enabled !== undefined && row.enabled !== null && row.enabled !== '') {
    return ['1', 'true', 'True'].includes(String(row.enabled)) ? 'ACTIVE' : 'DISABLED';
  }
  if (row.restore_allowed !== undefined && row.restore_allowed !== null && row.restore_allowed !== '') {
    return ['1', 'true', 'True'].includes(String(row.restore_allowed)) ? 'ACTIVE' : 'BLOCKED';
  }
  return 'PRESENT';
}

function identifiersOf(row) {
  const out = {};
  for (const column of PERSON_COLUMNS) {
    const value = row[column];
    if (value !== undefined && value !== null && value !== '' && value !== 'null') out[column] = String(value);
  }
  for (const key of ['document', 'profile', 'subject']) {
    const nested = row[key];
    if (nested && typeof nested === 'object') {
      const inner = {};
      for (const [sub, value] of Object.entries(nested)) {
        if (value !== undefined && value !== null && value !== '' && value !== 'null') inner[sub] = value;
      }
      if (Object.keys(inner).length) out[key] = inner;
    }
  }
  return out;
}

function rowToRecords(evidence, table, row, topology, capturedAt) {
  const [base, tableTopology] = splitTable(table);
  let payload = {};
  if (row.record_json) {
    try {
      payload = JSON.parse(row.record_json);
    } catch {
      payload = {};
    }
  }
  const resourceId = String(row.resource_id || payload.resource_id || '');
  if (!resourceId) return [];
  let system = row.origin_system || payload.system || '';
  if (!system) {
    if (base in TABLE_SYSTEM_HINTS) system = TABLE_SYSTEM_HINTS[base];
    else system = guessSystem(resourceId);
  }
  if (base === 'customer_profiles') system = 'account_service';
  if (base === 'customer_data') system = payload.system || row.origin_system || 'replicated_store';
  const collection = row.collection_name || payload.collection || base;
  const recordType = guessRecordType(system, collection, row.record_type || payload.record_type);
  const payloadRow = { ...row, ...payload };
  const identifiers = identifiersOf(payloadRow);
  const observedAt = row.updated_at || payload.updated_at || capturedAt;
  const notes = [`table=${table}`, `topology=${tableTopology}`];
  if (topology) notes.push(`capture_topology=${topology}`);
  return [makeRecord({
    evidenceId: evidence.file_id,
    capturedAt: evidence.captured_at,
    observedAt,
    system,
    resourceId,
    recordType,
    state: stateFromRow(payloadRow),
    identifiers,
    payload: { ...payloadRow, _table: table, _collection: collection },
    parser: 'sql_snapshot',
    sourcePath: evidence.file_path,
    notes,
  })];
}

function parse(evidence) {
  const script = readText(evidence.absolute_path);
  const topologyMatch = TOPOLOGY_RE.exec(script);
  const capturedMatch = CAPTURED_RE.exec(script);
  const topology = topologyMatch ? topologyMatch[1].trim() : 'inventory';
  const capturedAt = capturedMatch ? capturedMatch[1].trim() : evidence.captured_at;
  const db = new DatabaseSync(':memory:');
  const records = [];
  try {
    db.exec(script);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    for (const { name } of tables) {
      if (name === 'snapshot_scope') continue;
      let rows;
      try {
        rows = db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all();
      } catch {
        continue;
      }
      for (const raw of rows) {
        const row = { ...raw };
        records.push(...rowToRecords(evidence, name, row, topology, capturedAt));
      }
    }
  } catch (error) {
    return { records, detail: `error=${error.message.slice(0, 120)}` };
  } finally {
    db.close();
  }
  return { records, detail: `topology=${topology} tables=${new Set(records.map((r) => r.payload?._table)).size}` };
}

export { parse, splitTable, stateFromRow };
