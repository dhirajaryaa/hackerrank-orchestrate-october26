import {
  PREFIX_TO_SYSTEM,
  SYSTEM_TO_CATEGORY,
  RECORD_TYPE_TO_CATEGORY,
  COLLECTION_TO_RECORD_TYPE,
  DIRECT_IDENTIFIER_FIELDS,
} from './config.js';
import { unique, normEmail, normPhone, normName } from './util.js';

function guessSystem(resourceId, fallback = 'unknown_system') {
  if (!resourceId) return fallback;
  const text = String(resourceId);
  for (const [prefix, system] of Object.entries(PREFIX_TO_SYSTEM)) {
    if (text.startsWith(`${prefix}_`)) return system;
  }
  return fallback;
}

function guessRecordType(system, collection, explicit) {
  if (explicit) {
    const token = String(explicit).trim().toUpperCase();
    if (RECORD_TYPE_TO_CATEGORY[token]) return token;
  }
  if (collection) {
    const key = String(collection).toLowerCase();
    for (const [name, type] of Object.entries(COLLECTION_TO_RECORD_TYPE)) {
      if (key === name || key.startsWith(name)) return type;
    }
  }
  return SYSTEM_TO_CATEGORY[system] || 'UNKNOWN';
}

function categoryOf(record) {
  if (RECORD_TYPE_TO_CATEGORY[record.recordType]) return RECORD_TYPE_TO_CATEGORY[record.recordType];
  return SYSTEM_TO_CATEGORY[record.system] || 'UNKNOWN';
}

const NESTED_KEYS = ['profile', 'document', 'subject', 'hits'];

function directIdentifiers(record) {
  const found = {};
  const identifiers = record.identifiers || {};
  for (const [key, value] of Object.entries(identifiers)) {
    if (key === 'subject_selector' && typeof value === 'string' && /^user_\d+$/.test(value)) {
      continue;
    }
    if (DIRECT_IDENTIFIER_FIELDS.has(key) && value !== null && value !== undefined && value !== '' && value !== 'null') {
      found[key] = value;
    } else if (Array.isArray(value)) {
      const kept = value.filter((item) => item !== null && item !== undefined && item !== '');
      if (kept.length) found[key] = kept;
    } else if (value && typeof value === 'object') {
      for (const [subKey, subValue] of Object.entries(value)) {
        if (DIRECT_IDENTIFIER_FIELDS.has(subKey) && subValue !== null && subValue !== undefined && subValue !== '' && subValue !== 'null') {
          found[`${key}.${subKey}`] = subValue;
        }
      }
    }
  }
  return found;
}

function hasDirectIdentifiers(record) {
  return Object.keys(directIdentifiers(record)).length > 0;
}

function refineState(record) {
  let state = record.state || 'PRESENT';
  const category = categoryOf(record);
  const direct = hasDirectIdentifiers(record);
  if (state === 'ACTIVE' && !['DATA_FLOW', 'BACKUP_ARCHIVE'].includes(category)) state = 'PRESENT';
  if (category === 'SUPPORT_MESSAGE') {
    if (['PRESENT', 'IDENTIFIABLE', 'ACTIVE'].includes(state)) return direct ? 'IDENTIFIABLE' : 'REDACTED';
  } else if (['ANALYTICS_PROFILE', 'PRODUCT_TELEMETRY'].includes(category)) {
    if (['PRESENT', 'IDENTIFIABLE', 'ACTIVE'].includes(state)) return direct ? 'IDENTIFIABLE' : 'ANONYMIZED';
  } else if (['EMAIL_DELIVERY_LOG', 'ACCOUNT_TOMBSTONE'].includes(category)) {
    if (state === 'PRESENT' || state === 'ACTIVE' || state === 'IDENTIFIABLE') return direct ? 'IDENTIFIABLE' : 'REDACTED';
  }
  return state;
}

function extractIdentifiers(row) {
  const out = {};
  if (!row || typeof row !== 'object') return out;
  const personKeys = [
    'customer_reference', 'user_id', 'subject_reference', 'subject_selector',
    'full_name', 'name', 'email', 'phone', 'email_hash', 'requester_name',
    'requester_email', 'requester_phone', 'owner_email', 'owner_phone',
    'customer_email', 'display_name', 'profile', 'document', 'subject',
    'lookup_value', 'query', 'id', 'ticket_id', 'ticket_number', 'order_id',
    'owner_key', 'correlation_key', 'subject_key', 'scan_key', 'match_key',
    'matched_value',
  ];
  for (const key of personKeys) {
    const value = row[key];
    if (value === undefined || value === null || value === '' || value === 'null') continue;
    if (typeof value === 'object') {
      const nested = {};
      for (const [subKey, subValue] of Object.entries(value)) {
        if (subValue === undefined || subValue === null || subValue === '' || subValue === 'null') continue;
        nested[subKey] = subValue;
      }
      if (Object.keys(nested).length) out[key] = nested;
    } else {
      out[key] = value;
    }
  }
  for (const key of NESTED_KEYS) {
    const nested = row[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      for (const subKey of ['email', 'phone', 'email_hash', 'full_name', 'name', 'display_name', 'customer_reference', 'user_id']) {
        const value = nested[subKey];
        if (value === undefined || value === null || value === '' || value === 'null') continue;
        out[`${key}.${subKey}`] = value;
      }
    }
  }
  return out;
}

function normalizeIdentifiers(identifiers) {
  const out = { ...identifiers };
  for (const key of ['email', 'requester_email', 'owner_email', 'customer_email', 'matched_value']) {
    if (typeof out[key] === 'string' && out[key].includes('@')) out[key] = normEmail(out[key]);
  }
  for (const key of ['phone', 'requester_phone', 'owner_phone']) {
    if (typeof out[key] === 'string') out[`${key}_normalized`] = normPhone(out[key]);
  }
  for (const key of ['full_name', 'name', 'requester_name', 'display_name']) {
    if (typeof out[key] === 'string') out[`${key}_normalized`] = normName(out[key]);
  }
  return out;
}

function makeRecord({
  evidenceId,
  evidenceKind = 'manifest',
  capturedAt,
  observedAt,
  system,
  resourceId,
  recordType,
  state = 'PRESENT',
  identifiers = {},
  linkKeys = [],
  payload = {},
  parser = '',
  sourcePath = '',
  notes = [],
  rowIndex = null,
  collectionIndex = null,
  category = null,
}) {
  const resolvedSystem = system || guessSystem(resourceId);
  const resolvedType = recordType || guessRecordType(resolvedSystem, payload.collection || payload.collection_name || '');
  return {
    evidenceId,
    evidenceKind,
    capturedAt,
    observedAt: observedAt || capturedAt,
    system: resolvedSystem,
    resourceId: resourceId || '',
    recordType: resolvedType,
    state,
    identifiers: normalizeIdentifiers(identifiers),
    linkKeys: unique(linkKeys),
    payload: payload || {},
    parser,
    sourcePath,
    notes: unique(notes),
    rowIndex,
    collectionIndex,
    category: category || RECORD_TYPE_TO_CATEGORY[resolvedType] || SYSTEM_TO_CATEGORY[resolvedSystem] || 'UNKNOWN',
    subjectUsers: [],
    linkMethod: 'none',
  };
}

function directLinkUsers(identifiers, resolver) {
  const users = new Set();
  for (const key of ['customer_reference', 'subject_reference', 'subject_selector', 'user_id']) {
    const value = identifiers?.[key];
    if (typeof value === 'string' && /^user_\d+$/.test(value) && resolver.identities.has(value)) {
      users.add(value);
    }
  }
  if (users.size) return { users, method: 'explicit_ref' };

  const consider = (value, key = '') => {
    if (!value) return;
    if (typeof value === 'string' && /^user_\d+$/.test(value) && resolver.identities.has(value)) {
      users.add(value);
      return;
    }
    if (key === 'email' || key.endsWith('_email') || key === 'matched_value') {
      for (const user of resolver.usersForIdentifier(normEmail(value))) users.add(user);
    } else if (key === 'phone' || key.endsWith('_phone')) {
      for (const user of resolver.usersForIdentifier(normPhone(value))) users.add(user);
      for (const user of resolver.usersForIdentifier(value)) users.add(user);
    } else if (key === 'email_hash') {
      for (const user of resolver.usersForIdentifier(String(value).toLowerCase())) users.add(user);
    } else if (['full_name', 'name', 'requester_name', 'display_name'].includes(key)) {
      const found = resolver.usersForIdentifier(normName(value));
      if (found.size === 1) for (const user of found) users.add(user);
    } else {
      for (const user of resolver.usersForIdentifier(value)) users.add(user);
    }
  };

  for (const key of ['email', 'requester_email', 'owner_email', 'customer_email', 'matched_value']) {
    const value = identifiers?.[key];
    if (typeof value === 'string' && value) consider(value, key);
  }
  for (const key of ['phone', 'requester_phone', 'owner_phone', 'phone_normalized']) {
    const value = identifiers?.[key];
    if (typeof value === 'string' && value) consider(value, key === 'phone_normalized' ? 'phone' : key);
  }
  if (typeof identifiers?.email_hash === 'string' && identifiers.email_hash) {
    for (const user of resolver.usersForIdentifier(identifiers.email_hash.toLowerCase())) users.add(user);
  }
  for (const key of ['full_name', 'name', 'requester_name', 'display_name']) {
    const value = identifiers?.[key];
    if (typeof value === 'string' && value) consider(value, key);
  }
  for (const key of ['profile', 'document', 'subject']) {
    const nested = identifiers?.[key];
    if (nested && typeof nested === 'object') {
      for (const subKey of ['email', 'phone', 'email_hash', 'customer_reference', 'user_id']) {
        const value = nested[subKey];
        if (typeof value === 'string' && value) consider(value, subKey);
      }
    }
  }
  for (const value of identifiers?.emails || []) consider(value, 'email');
  for (const value of identifiers?.phones || []) consider(value, 'phone');
  for (const value of identifiers?.user_refs || []) consider(value);
  if (users.size) return { users, method: 'identifier' };
  return { users, method: 'none' };
}

class ObservationStore {
  constructor() {
    this.records = [];
    this.parseLog = [];
  }

  add(record) {
    if (record && record.resourceId) this.records.push(record);
  }

  extend(records) {
    for (const record of records || []) this.add(record);
  }

  logFile(fileId, filePath, parser, count, status = 'ok', detail = '') {
    this.parseLog.push({ file_id: fileId, path: filePath, parser, records: count, status, detail });
  }

  byResource() {
    const index = new Map();
    for (const record of this.records) {
      const key = `${record.system}|${record.resourceId}`;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(record);
    }
    return index;
  }

  stats() {
    const systems = {};
    const types = {};
    const states = {};
    const parsers = {};
    for (const record of this.records) {
      systems[record.system] = (systems[record.system] || 0) + 1;
      types[record.recordType] = (types[record.recordType] || 0) + 1;
      states[record.state] = (states[record.state] || 0) + 1;
      parsers[record.parser] = (parsers[record.parser] || 0) + 1;
    }
    return {
      records: this.records.length,
      distinct_resources: new Set(this.records.map((r) => `${r.system}|${r.resourceId}`)).size,
      by_system: systems,
      by_record_type: types,
      by_state: states,
      by_parser: parsers,
    };
  }
}

export {
  guessSystem,
  guessRecordType,
  categoryOf,
  directIdentifiers,
  hasDirectIdentifiers,
  refineState,
  extractIdentifiers,
  normalizeIdentifiers,
  makeRecord,
  directLinkUsers,
  ObservationStore,
};
