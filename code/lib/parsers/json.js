import fs from 'node:fs';
import { makeRecord, guessRecordType, guessSystem } from '../model.js';
import { readJson } from '../util.js';

const DIRECT_IDENTIFIER_KEYS = [
  'full_name', 'name', 'email', 'phone', 'email_hash', 'requester_name',
  'requester_email', 'requester_phone', 'owner_email', 'owner_phone',
  'customer_email', 'display_name',
];

const PERSON_KEYS = [
  'customer_reference', 'user_id', 'subject_reference', 'subject_selector',
  'full_name', 'name', 'email', 'phone', 'email_hash', 'requester_name',
  'requester_email', 'requester_phone', 'owner_email', 'owner_phone',
  'customer_email', 'display_name', 'profile', 'document', 'lookup_value',
  'lookup_key', 'query', 'matched_value',
];

const TEXT_KEYS = ['message_excerpt', 'message_text', 'body', 'content', 'note'];
const REDACTION_MARKERS = ['[redacted]', '<redacted>', 'redacted', '***', '[deleted]'];

function hasDirectIdentifier(row) {
  for (const key of DIRECT_IDENTIFIER_KEYS) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '' && row[key] !== 'null') return true;
  }
  for (const key of ['profile', 'document']) {
    const nested = row[key];
    if (nested && typeof nested === 'object') {
      for (const sub of DIRECT_IDENTIFIER_KEYS) {
        if (nested[sub] !== undefined && nested[sub] !== null && nested[sub] !== '' && nested[sub] !== 'null') return true;
      }
    }
  }
  return false;
}

function textRedacted(row) {
  for (const key of TEXT_KEYS) {
    const value = row[key];
    if (typeof value === 'string') {
      const lowered = value.trim().toLowerCase();
      if (REDACTION_MARKERS.some((marker) => lowered.includes(marker))) return true;
    }
  }
  return false;
}

function stateOf(row) {
  const status = String(row.account_status || '').toUpperCase();
  if (['DELETED', 'TOMBSTONED'].includes(status)) {
    return hasDirectIdentifier(row) ? 'PRESENT' : 'REDACTED';
  }
  if (textRedacted(row)) return 'REDACTED';
  if (row.result !== undefined) {
    const token = String(row.result || '').toUpperCase();
    if (['HIT', 'FOUND', 'PRESENT'].includes(token)) return 'PRESENT';
    if (['MISS', 'NOT_FOUND', 'ABSENT'].includes(token)) return 'ABSENT';
  }
  if (row.hits && typeof row.hits === 'object') {
    return Number(row.hits.total) === 0 ? 'ABSENT' : 'PRESENT';
  }
  if (row.status_code !== undefined) {
    return String(row.status_code) === '404' ? 'ABSENT' : 'PRESENT';
  }
  if (row.enabled !== undefined) {
    return ['true', '1', 1, true].includes(row.enabled) ? 'ACTIVE' : 'DISABLED';
  }
  if (row.restore_allowed !== undefined) {
    return ['true', '1', 1, true].includes(row.restore_allowed) ? 'ACTIVE' : 'BLOCKED';
  }
  if (row.last_delivery_status !== undefined) {
    const token = String(row.last_delivery_status || '').toLowerCase();
    if (['stopped', 'disabled'].includes(token)) return 'DISABLED';
  }
  return 'PRESENT';
}

function flattenHits(row) {
  if (!row.hits || typeof row.hits !== 'object') return row;
  const docs = Array.isArray(row.hits.documents) ? row.hits.documents : [];
  if (!docs.length || typeof docs[0] !== 'object') return row;
  const merged = { ...docs[0] };
  for (const [key, value] of Object.entries(row)) {
    if (key !== 'hits' && merged[key] === undefined) merged[key] = value;
  }
  return merged;
}

function identifiersOf(row) {
  const out = {};
  for (const key of PERSON_KEYS) {
    const value = row[key];
    if (value === null || value === undefined || value === '' || value === 'null') continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = {};
      for (const [sub, nestedValue] of Object.entries(value)) {
        if (nestedValue !== null && nestedValue !== undefined && nestedValue !== '' && nestedValue !== 'null') {
          nested[sub] = nestedValue;
        }
      }
      if (Object.keys(nested).length) out[key] = nested;
    } else {
      out[key] = value;
    }
  }
  for (const key of ['profile', 'document']) {
    const nested = row[key];
    if (nested && typeof nested === 'object') {
      for (const sub of ['email', 'phone', 'email_hash', 'full_name', 'name', 'display_name', 'customer_reference', 'user_id']) {
        const value = nested[sub];
        if (value !== null && value !== undefined && value !== '' && value !== 'null') {
          out[`${key}.${sub}`] = value;
        }
      }
    }
  }
  return out;
}

function rowRecords(evidence, system, collection, rawRow, capturedAt, collectionIndex = null, rowIndex = null) {
  if (!rawRow || typeof rawRow !== 'object') return [];
  const row = flattenHits(rawRow);
  const resourceId = String(row.resource_id || rawRow.resource_id || '');
  if (!resourceId) return [];
  const resolvedSystem = system || guessSystem(resourceId);
  const explicitType = row.record_type || rawRow.record_type;
  const recordType = guessRecordType(resolvedSystem, collection, explicitType);
  const observedAt = row.observed_at || row.recorded_at || row.updated_at || capturedAt;
  const linkKeys = [];
  for (const key of ['lookup_key', 'query', 'lookup_value', 'subject_selector']) {
    const value = row[key];
    if (typeof value === 'string' && value && value !== 'null') linkKeys.push(value);
  }
  if (row.profile && typeof row.profile === 'object') {
    for (const key of ['customer_reference', 'email', 'phone', 'email_hash']) {
      const value = row.profile[key];
      if (typeof value === 'string' && value && value !== 'null') linkKeys.push(value);
    }
  }
  const record = makeRecord({
    evidenceId: evidence.file_id,
    capturedAt: evidence.captured_at,
    observedAt,
    system: resolvedSystem,
    resourceId,
    recordType,
    state: stateOf(row),
    identifiers: identifiersOf(row),
    linkKeys,
    payload: { ...row, _collection: collection, _captured_at: capturedAt },
    parser: 'json_records',
    sourcePath: evidence.file_path,
    rowIndex,
    collectionIndex,
  });
  return [record];
}

function parse(evidence) {
  const document = readJson(evidence.absolute_path);
  const capturedAt = document.captured_at || document.exported_at || evidence.captured_at;
  const records = [];
  const shapes = [];

  if (Array.isArray(document.snapshots)) {
    shapes.push(`snapshots=${document.snapshots.length}`);
    for (const [snapshotIndex, snapshot] of document.snapshots.entries()) {
      const system = snapshot.data_store || '';
      const collection = snapshot.collection || '';
      const snapshotCaptured = snapshot.captured_at || capturedAt;
      for (const [rowIndex, row] of (snapshot.records || []).entries()) {
        records.push(...rowRecords(evidence, system, collection, row, snapshotCaptured, snapshotIndex, rowIndex));
      }
    }
  }

  if (document.service_exports && typeof document.service_exports === 'object') {
    shapes.push(`services=${Object.keys(document.service_exports).length}`);
    for (const [system, collections] of Object.entries(document.service_exports)) {
      if (!collections || typeof collections !== 'object') continue;
      for (const [collection, rows] of Object.entries(collections)) {
        if (!Array.isArray(rows)) continue;
        for (const [rowIndex, row] of rows.entries()) {
          records.push(...rowRecords(evidence, system, collection, row, document.exported_at || capturedAt, null, rowIndex));
        }
      }
    }
  }

  if (Array.isArray(document.records)) {
    shapes.push(`records=${document.records.length}`);
    const defaultSystem = document.system || '';
    for (const [rowIndex, row] of document.records.entries()) {
      const system = row.system || defaultSystem;
      const collection = row.collection || document.collection || '';
      records.push(...rowRecords(evidence, system, collection, row, capturedAt, null, rowIndex));
    }
  }

  return { records, detail: shapes.length ? shapes.join(' ') : 'unrecognized' };
}

export { parse, identifiersOf, stateOf, flattenHits };
