import path from 'node:path';
import { DATASET_DIR } from './config.js';
import { readCsv, parseTs } from './util.js';

function datasetPath(name) {
  return path.join(DATASET_DIR, name);
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function loadRequests(sample = false) {
  const name = sample ? 'sample_deletion_requests.csv' : 'deletion_requests.csv';
  return readCsv(datasetPath(name))
    .map((row) => ({
      case_id: text(row.case_id),
      email: text(row.email),
      requested_at: text(row.requested_at),
      reported_status: text(row.reported_status),
      reported_at: text(row.reported_at),
      audit_at: text(row.audit_at),
      request_text: text(row.request_text),
    }))
    .filter((row) => row.case_id)
    .sort((a, b) => a.case_id.localeCompare(b.case_id));
}

function loadSampleOutput() {
  const rows = readCsv(datasetPath('sample_output.csv'));
  const out = new Map();
  for (const row of rows) out.set(text(row.case_id), row);
  return out;
}

function loadIdentities() {
  const out = new Map();
  for (const row of readCsv(datasetPath('user_identities.csv'))) {
    const identity = {
      user_id: text(row.user_id),
      name: text(row.name),
      email: text(row.email),
      phone: text(row.phone),
      email_hash: text(row.email_hash),
      updated_at: text(row.updated_at),
    };
    if (identity.user_id) out.set(identity.user_id, identity);
  }
  return out;
}

function loadAuditLog() {
  return readCsv(datasetPath('user_audit_log.csv'))
    .map((row) => ({
      audit_id: text(row.audit_id),
      user_id: text(row.user_id),
      field_name: text(row.field_name),
      old_value: text(row.old_value),
      new_value: text(row.new_value),
      event_time: text(row.event_time),
    }))
    .filter((row) => row.audit_id)
    .sort((a, b) => (parseTs(a.event_time) || 0) - (parseTs(b.event_time) || 0));
}

function loadActivity() {
  return readCsv(datasetPath('system_activity.csv'))
    .map((row) => ({
      activity_id: text(row.activity_id),
      event_time: text(row.event_time),
      event_type: text(row.event_type),
      source_system: text(row.source_system),
      target_system: text(row.target_system),
      resource_id: text(row.resource_id),
      reported_result: text(row.reported_result),
      details: text(row.details),
    }))
    .filter((row) => row.activity_id)
    .sort((a, b) => {
      const ta = parseTs(a.event_time) || 0;
      const tb = parseTs(b.event_time) || 0;
      return ta - tb || a.activity_id.localeCompare(b.activity_id);
    });
}

function loadRules() {
  return readCsv(datasetPath('deletion_rules.csv'))
    .map((row) => ({
      rule_id: text(row.rule_id),
      data_category: text(row.data_category),
      condition: text(row.condition),
      required_action: text(row.required_action),
    }))
    .filter((row) => row.rule_id)
    .sort((a, b) => a.rule_id.localeCompare(b.rule_id));
}

function loadManifest() {
  return readCsv(datasetPath('evidence_files.csv'))
    .map((row) => {
      const filePath = text(row.file_path);
      return {
        file_id: text(row.file_id),
        file_path: filePath,
        origin: text(row.origin),
        captured_at: text(row.captured_at),
        absolute_path: path.join(DATASET_DIR, filePath),
        suffix: path.extname(filePath).toLowerCase(),
      };
    })
    .filter((row) => row.file_id)
    .sort((a, b) => a.file_id.localeCompare(b.file_id));
}

export {
  datasetPath,
  loadRequests,
  loadSampleOutput,
  loadIdentities,
  loadAuditLog,
  loadActivity,
  loadRules,
  loadManifest,
};
