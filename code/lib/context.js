import fs from 'node:fs';
import { parseTs } from './util.js';
import { loadManifest } from './tables.js';
import { directIdentifiers } from './model.js';
import { categoryOfResource } from './inference.js';

const POLICY_CATEGORIES = new Set([
  'USER_PROFILE',
  'SECONDARY_IDENTIFIER',
  'SEARCH_INDEX_ENTRY',
  'CACHE_ENTRY',
  'SUPPORT_MESSAGE',
  'SUPPORT_ATTACHMENT',
  'ANALYTICS_PROFILE',
  'PRODUCT_TELEMETRY',
  'USER_EXPORT',
  'MARKETING_PROFILE',
  'EMAIL_DELIVERY_LOG',
  'SECURITY_AUDIT_LOG',
  'LEGAL_HOLD_RECORD',
  'BACKUP_ARCHIVE',
  'ACCOUNT_TOMBSTONE',
  'DATA_FLOW',
]);

const SYSTEM_ALIASES = {
  account_replication_cluster: 'account_service',
  account_failover_replica: 'account_service',
  replicated_store: 'account_service',
  support_storage_service: 'support_platform',
  object_store: 'support_platform',
  object_storage: 'support_platform',
  backup_restore_service: 'backup_service',
  archive_service: 'backup_service',
};

const INCLUDE_ACTIVITY_EVENTS = new Set([
  'DELETE_RECORD',
  'REDACT_RECORD',
  'ANONYMIZE_RECORD',
  'DISABLE_DATA_FLOW',
  'BLOCK_RESTORE',
  'RETAIN_RECORD',
  'RESTORE_BACKUP',
  'CHECK_DATA_FLOW',
  'CHECK_RESTORE_ACCESS',
  'SYNC_RECORD',
]);

function normalizeSystem(record) {
  const system = record.system || '';
  return SYSTEM_ALIASES[system] || system;
}

function categoryFor(record) {
  const category = record.category || categoryOfResource(record.resourceId);
  if (category !== 'UNKNOWN') return category;
  return categoryOfResource(record.resourceId);
}

function isUsable(record) {
  if (!record.resourceId) return false;
  if (record.system === 'evidence_document' || record.system === 'evidence_screenshot') return false;
  if (record.payload?.event_type === 'LINK_RESOURCE_IDENTITY') return false;
  if (record.evidenceKind === 'activity' && !INCLUDE_ACTIVITY_EVENTS.has(record.payload?.event_type)) return false;
  return true;
}

function hasDirect(record) {
  return Object.keys(directIdentifiers(record)).length > 0;
}

function activityState(record, category) {
  const result = String(record.payload?.reported_result || record.state || '').toUpperCase();
  const success = result === 'SUCCESS';
  const partial = result === 'PARTIAL';
  const eventType = record.payload?.event_type;
  if (eventType === 'DELETE_RECORD') {
    if (success) return 'ABSENT';
    if (partial) return category === 'USER_PROFILE' ? 'ABSENT' : 'PRESENT';
    return 'PRESENT';
  }
  if (eventType === 'REDACT_RECORD') return success ? 'REDACTED' : 'PRESENT';
  if (eventType === 'ANONYMIZE_RECORD') return success ? 'ANONYMIZED' : 'PRESENT';
  if (eventType === 'DISABLE_DATA_FLOW') return success ? 'DISABLED' : 'ACTIVE';
  if (eventType === 'BLOCK_RESTORE') return success ? 'BLOCKED' : 'ACTIVE';
  if (eventType === 'CHECK_DATA_FLOW') return success ? 'ACTIVE' : 'DISABLED';
  if (eventType === 'CHECK_RESTORE_ACCESS') return success ? 'ACTIVE' : 'BLOCKED';
  if (eventType === 'RESTORE_BACKUP') return 'ACTIVE';
  if (eventType === 'RETAIN_RECORD') return 'RETAINED';
  if (eventType === 'SYNC_RECORD') return 'PRESENT';
  return record.state || 'PRESENT';
}

function normalizeState(record, category) {
  let state = record.evidenceKind === 'activity' ? activityState(record, category) : (record.state || 'PRESENT');
  state = String(state).toUpperCase();

  if (category === 'USER_PROFILE') {
    if (state === 'ABSENT') return 'ABSENT';
    if (state === 'UNCERTAIN') return 'ABSENT';
    return 'PRESENT';
  }
  if (['SEARCH_INDEX_ENTRY', 'CACHE_ENTRY', 'USER_EXPORT', 'MARKETING_PROFILE'].includes(category)) {
    if (state === 'ABSENT' || (category === 'USER_EXPORT' && state === 'DISABLED')) return 'ABSENT';
    return 'PRESENT';
  }
  if (category === 'SUPPORT_ATTACHMENT') {
    return state === 'ABSENT' ? 'ABSENT' : 'PRESENT';
  }
  if (category === 'SUPPORT_MESSAGE') {
    if (state === 'ABSENT') return 'ABSENT';
    if (state === 'REDACTED') return 'REDACTED';
    if (record.evidenceKind === 'activity' || record.parser === 'log_events') return 'IDENTIFIABLE';
    return hasDirect(record) ? 'IDENTIFIABLE' : 'REDACTED';
  }
  if (['ANALYTICS_PROFILE', 'PRODUCT_TELEMETRY'].includes(category)) {
    if (state === 'ABSENT') return 'ABSENT';
    if (state === 'ANONYMIZED' || state === 'REDACTED') return 'ANONYMIZED';
    if (record.evidenceKind === 'activity') return 'IDENTIFIABLE';
    if (record.parser === 'log_events') return state === 'IDENTIFIABLE' ? 'IDENTIFIABLE' : 'ANONYMIZED';
    return hasDirect(record) ? 'IDENTIFIABLE' : 'ANONYMIZED';
  }
  if (['EMAIL_DELIVERY_LOG', 'ACCOUNT_TOMBSTONE'].includes(category)) {
    if (state === 'ABSENT') return 'ABSENT';
    if (state === 'REDACTED') return 'REDACTED';
    if (record.evidenceKind === 'activity') return 'IDENTIFIABLE';
    return hasDirect(record) ? 'IDENTIFIABLE' : 'REDACTED';
  }
  if (category === 'SECURITY_AUDIT_LOG') {
    if (state === 'ABSENT') return 'ABSENT';
    if (state === 'RETAINED') return 'RETAINED';
    return 'PRESENT';
  }
  if (category === 'LEGAL_HOLD_RECORD') {
    if (state === 'ABSENT') return 'ABSENT';
    return state === 'RETAINED' ? 'RETAINED' : 'PRESENT';
  }
  if (category === 'DATA_FLOW') {
    if (state === 'ABSENT') return 'ABSENT';
    if (state === 'DISABLED') return 'DISABLED';
    return 'ACTIVE';
  }
  if (category === 'BACKUP_ARCHIVE') {
    if (state === 'ABSENT') return 'ABSENT';
    if (state === 'BLOCKED') return 'BLOCKED';
    return 'ACTIVE';
  }
  return state;
}

function recordTime(record) {
  return parseTs(record.observedAt || record.capturedAt);
}

const EVIDENCE_ORIGIN_PRIORITY = {
  service_readback_logs: 100,
  service_resource_export: 95,
  customer_data_inventory_capture: 90,
  customer_account_service: 85,
  customer_account_failover_replica_capture: 80,
  customer_data_read_replica_capture: 80,
  central_observability_export: 75,
  records_assurance_snapshot_bundle: 20,
};

const PARSER_PRIORITY = {
  sql_snapshot: 70,
  pdf_doc: 65,
  text_doc: 60,
  image_doc: 55,
  log_events: 50,
  json_records: 40,
};

function citationPriority(record, auditMs) {
  const capturedMs = parseTs(record.evidenceCapturedAt);
  const preAudit = capturedMs !== null && auditMs !== null && capturedMs <= auditMs ? 1 : 0;
  const originRank = EVIDENCE_ORIGIN_PRIORITY[record.evidenceOrigin] || 0;
  const parserRank = PARSER_PRIORITY[record.parser] || 0;
  return {
    preAudit,
    rank: Math.max(originRank, parserRank),
    time: recordTime(record) || 0,
  };
}

function sortCitations(records, auditMs) {
  return [...records].sort((a, b) => {
    const pa = citationPriority(a, auditMs);
    const pb = citationPriority(b, auditMs);
    if (pa.preAudit !== pb.preAudit) return pb.preAudit - pa.preAudit;
    if (pa.rank !== pb.rank) return pb.rank - pa.rank;
    return pb.time - pa.time;
  });
}

let accountSnapshotCache = null;

function accountSnapshots() {
  if (accountSnapshotCache) return accountSnapshotCache;
  const snapshots = [];
  for (const evidence of loadManifest()) {
    if (!['.sql', '.json'].includes(evidence.suffix)) continue;
    let text = '';
    try {
      text = fs.readFileSync(evidence.absolute_path, 'utf8');
    } catch {
      continue;
    }
    if (!/customer_profiles|account_service/.test(text)) continue;
    const capturedMs = parseTs(evidence.captured_at);
    if (capturedMs === null) continue;
    snapshots.push({ file_id: evidence.file_id, capturedMs, origin: evidence.origin });
  }
  accountSnapshotCache = snapshots;
  return snapshots;
}

function latestAccountSnapshot(auditMs) {
  if (auditMs === null) return '';
  let best = null;
  for (const snapshot of accountSnapshots()) {
    if (snapshot.capturedMs > auditMs) continue;
    if (!best || snapshot.capturedMs > best.capturedMs) best = snapshot;
  }
  return best?.file_id || '';
}

function isRetentionApplicable(record, category, auditMs) {
  if (category === 'SECURITY_AUDIT_LOG') {
    const until = record.payload?.retention_until || record.payload?.retain_until || record.identifiers?.retention_until;
    if (until) {
      const ms = parseTs(until);
      if (ms !== null && auditMs !== null && ms < auditMs) return false;
    }
    return true;
  }
  if (category === 'LEGAL_HOLD_RECORD') {
    const status = String(record.payload?.hold_status || record.payload?.status || '').toLowerCase();
    if (['released', 'inactive', 'expired'].includes(status)) return false;
    const until = record.payload?.hold_until || record.payload?.expires_at;
    if (until) {
      const ms = parseTs(until);
      if (ms !== null && auditMs !== null && ms < auditMs) return false;
    }
    return true;
  }
  return true;
}

function statePriority(record, state) {
  if (['ABSENT', 'BLOCKED', 'DISABLED', 'REDACTED', 'ANONYMIZED'].includes(state)) return 0;
  return 1;
}

function chooseLatest(records) {
  const sorted = [...records].sort((a, b) => {
    const ta = recordTime(a);
    const tb = recordTime(b);
    if (ta !== tb) return tb - ta;
    const pa = a.evidenceKind === 'manifest' ? 1 : 0;
    const pb = b.evidenceKind === 'manifest' ? 1 : 0;
    if (pa !== pb) return pb - pa;
    const sa = statePriority(a, a.state);
    const sb = statePriority(b, b.state);
    if (sa !== sb) return sb - sa;
    return (b.rowIndex ?? 0) - (a.rowIndex ?? 0);
  });
  return sorted[0] || null;
}

function isRelevantRecord(record, request, auditMs) {
  const timestamp = recordTime(record);
  if (timestamp === null) return false;
  if (auditMs !== null && timestamp > auditMs) return false;
  if (record.evidenceKind === 'manifest') {
    if (request.requestedMs === null) return true;
    return timestamp >= request.requestedMs - 120 * 86400000;
  }
  if (request.reportedMs === null) return true;
  return Math.abs(timestamp - request.reportedMs) <= 7 * 86400000;
}

function accountState(entries, auditMs) {
  const manifestRecords = entries
    .map((entry) => entry.record)
    .filter((record) => record.evidenceKind === 'manifest');
  const manifests = [...manifestRecords]
    .sort((a, b) => (recordTime(b) || 0) - (recordTime(a) || 0));
  const latestManifest = manifests[0] || null;
  if (!latestManifest) return { state: 'ABSENT', citation: null };
  const latestManifestMs = recordTime(latestManifest);

  const deletes = entries
    .filter((entry) => entry.record.evidenceKind === 'activity')
    .filter((entry) => entry.record.payload?.event_type === 'DELETE_RECORD')
    .sort((a, b) => (recordTime(b.record) || 0) - (recordTime(a.record) || 0));
  const latestDelete = deletes[0]?.record || null;
  if (latestDelete) {
    const deleteMs = recordTime(latestDelete);
    const result = String(latestDelete.payload?.reported_result || '').toUpperCase();
    if (deleteMs !== null && latestManifestMs !== null && deleteMs > latestManifestMs && result !== 'FAILED') {
      return { state: 'ABSENT', citation: latestDelete };
    }
  }
  const manifestState = normalizeState(latestManifest, 'USER_PROFILE');
  const matching = manifestRecords.filter((record) => normalizeState(record, 'USER_PROFILE') === manifestState);
  const citation = sortCitations(matching.length ? matching : manifestRecords, auditMs)[0] || latestManifest;
  return { state: manifestState, citation };
}

function buildResourceStates({ store, resourceUsers, userId, request }) {
  const auditMs = parseTs(request.audit_at);
  const ownedResources = new Set();
  for (const [resourceId, users] of resourceUsers.entries()) {
    if (users.has(userId)) ownedResources.add(resourceId);
  }

  const byResource = new Map();
  for (const record of store.records) {
    if (!isUsable(record)) continue;
    if (!ownedResources.has(record.resourceId)) continue;
    const category = categoryFor(record);
    if (!POLICY_CATEGORIES.has(category)) continue;
    if (!isRetentionApplicable(record, category, auditMs)) continue;
    if (!isRelevantRecord(record, request, auditMs)) continue;
    if (!byResource.has(record.resourceId)) byResource.set(record.resourceId, []);
    byResource.get(record.resourceId).push({ record, category });
  }

  const resources = [];
  for (const [resourceId, entries] of byResource.entries()) {
    const latest = chooseLatest(entries.map((entry) => entry.record));
    if (!latest) continue;
    const category = categoryFor(latest);
    if (!POLICY_CATEGORIES.has(category)) continue;

    let state = normalizeState(latest, category);
    let citation = null;
    if (category === 'USER_PROFILE') {
      const account = accountState(entries, auditMs);
      state = account.state;
      if (account.citation) citation = account.citation;
    }
    if (!state) continue;

    const candidates = entries.map((entry) => entry.record);
    if (!citation) {
      const matchingManifest = sortCitations(
        candidates.filter((record) => record.evidenceKind === 'manifest' && normalizeState(record, category) === state),
        auditMs,
      )[0];
      const anyManifest = sortCitations(
        candidates.filter((record) => record.evidenceKind === 'manifest'),
        auditMs,
      )[0];
      citation = matchingManifest || anyManifest || latest;
    }
    if (category === 'USER_PROFILE' && state === 'ABSENT' && citation?.evidenceKind !== 'manifest') {
      const snapshotId = latestAccountSnapshot(auditMs);
      if (snapshotId) citation = { evidenceId: snapshotId, evidenceKind: 'manifest' };
    }

    resources.push({
      resource_id: resourceId,
      system: normalizeSystem(latest),
      category,
      state,
      evidence_id: citation?.evidenceId || '',
      evidence_kind: citation?.evidenceKind || 'none',
      observed_at: latest.observedAt || latest.capturedAt || '',
      source_system: latest.system || '',
      source_parser: latest.parser || '',
    });
  }

  resources.sort((a, b) => a.category.localeCompare(b.category) || a.resource_id.localeCompare(b.resource_id));
  return resources;
}

function buildCaseContexts({ store, resourceUsers, requests, resolver }) {
  return requests.map((request) => {
    const resolution = resolver.resolveCase(request);
    const userId = resolution.userId || request.user_id || null;
    const enriched = {
      ...request,
      user_id: userId,
      requestedMs: request.requestedMs ?? parseTs(request.requested_at),
      reportedMs: request.reportedMs ?? parseTs(request.reported_at),
      auditMs: request.auditMs ?? parseTs(request.audit_at),
    };
    const resources = userId ? buildResourceStates({
      store,
      resourceUsers,
      userId,
      request: enriched,
    }) : [];
    return {
      ...enriched,
      resolution,
      resources,
    };
  });
}

export {
  buildCaseContexts,
  buildResourceStates,
  normalizeSystem,
  normalizeState,
  categoryFor,
  POLICY_CATEGORIES,
  INCLUDE_ACTIVITY_EVENTS,
};
