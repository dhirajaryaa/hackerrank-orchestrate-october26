import { loadActivity, loadRequests } from './tables.js';
import { parseTs } from './util.js';
import { SYSTEM_TO_CATEGORY, PREFIX_TO_SYSTEM } from './config.js';

const STRONG_METHODS = new Set(['explicit_ref', 'identifier', 'link_key']);
const SYSTEM_IDS = new Set([...Object.keys(SYSTEM_TO_CATEGORY), ...Object.values(PREFIX_TO_SYSTEM)]);

const PREFIX_CATEGORY = {
  account: 'USER_PROFILE',
  search: 'SEARCH_INDEX_ENTRY',
  analytics: 'ANALYTICS_PROFILE',
  support: 'SUPPORT_MESSAGE',
  export: 'USER_EXPORT',
  data_flow: 'DATA_FLOW',
  backup: 'BACKUP_ARCHIVE',
  audit_record: 'SECURITY_AUDIT_LOG',
  tombstone: 'ACCOUNT_TOMBSTONE',
  email_delivery: 'EMAIL_DELIVERY_LOG',
  cache: 'CACHE_ENTRY',
  object: 'SUPPORT_ATTACHMENT',
  marketing: 'MARKETING_PROFILE',
  legal_hold: 'LEGAL_HOLD_RECORD',
  archive: 'BACKUP_ARCHIVE',
};

const HINTS = {
  ANALYTICS_PROFILE: /analytics|anonymi[sz]|identif|statistics|profile data|traces/i,
  CACHE_ENTRY: /cache|analytics|identif|old address|systems that do not display/i,
  SEARCH_INDEX_ENTRY: /search|index|find traces|find result/i,
  SUPPORT_MESSAGE: /support|ticket|conversation|service message|messages/i,
  SUPPORT_ATTACHMENT: /attachment|support|ticket|document/i,
  USER_EXPORT: /export|archive|download|copy of/i,
  BACKUP_ARCHIVE: /backup|restore|archive/i,
  DATA_FLOW: /sync|synchroni[sz]|connector|integration|copy them back|recreate/i,
  ACCOUNT_TOMBSTONE: /tombstone|deleted-account reference|internal reference|reference needed/i,
  SECURITY_AUDIT_LOG: /audit|security|retention/i,
};

const ACTIVITY_FOR_CATEGORY = {
  ANALYTICS_PROFILE: ['ANONYMIZE_RECORD'],
  CACHE_ENTRY: ['DELETE_RECORD'],
  SEARCH_INDEX_ENTRY: ['DELETE_RECORD'],
  SUPPORT_MESSAGE: ['REDACT_RECORD'],
  SUPPORT_ATTACHMENT: ['DELETE_RECORD'],
  USER_EXPORT: ['DELETE_RECORD', 'CREATE_EXPORT'],
  BACKUP_ARCHIVE: ['BLOCK_RESTORE', 'CHECK_RESTORE_ACCESS', 'RESTORE_BACKUP'],
  DATA_FLOW: ['DISABLE_DATA_FLOW', 'CHECK_DATA_FLOW', 'SYNC_RECORD'],
};

const CATEGORY_PREFIXES = Object.keys(PREFIX_CATEGORY).sort((a, b) => b.length - a.length);

function prefixOf(resourceId) {
  const text = String(resourceId || '');
  for (const prefix of CATEGORY_PREFIXES) {
    if (text.startsWith(`${prefix}_`)) return prefix;
  }
  return '';
}

function categoryOfResource(resourceId) {
  return PREFIX_CATEGORY[prefixOf(resourceId)] || 'UNKNOWN';
}

function categoryOfActivity(event) {
  if (event.target_system === 'analytics_platform' && event.event_type === 'DELETE_RECORD') return 'CACHE_ENTRY';
  if (event.target_system === 'support_platform' && event.event_type === 'DELETE_RECORD') return 'SUPPORT_ATTACHMENT';
  return categoryOfResource(event.resource_id);
}

function addOwner(map, resourceId, userId) {
  if (!resourceId || !userId) return;
  if (!map.has(resourceId)) map.set(resourceId, new Set());
  map.get(resourceId).add(userId);
}

function ownersOf(map, resourceId) {
  return map.get(resourceId) || new Set();
}

function isResourceRef(value) {
  const text = String(value || '');
  if (SYSTEM_IDS.has(text)) return false;
  return /^[a-z][a-z0-9]*_[a-z0-9]+$/.test(text) && /\d/.test(text);
}

function hasMultipleEmbeddedSubjects(record) {
  const payload = record.payload || {};
  const ids = Array.isArray(payload.resource_ids) ? payload.resource_ids : [];
  if (new Set(ids.map(String)).size > 1) return true;
  const emails = Array.isArray(payload.emails) ? payload.emails : [];
  if (new Set(emails.map((value) => String(value).toLowerCase())).size > 1) return true;
  return false;
}

function manifestResourceMap(store) {
  const map = new Map();
  for (const record of store.records) {
    if (record.evidenceKind !== 'manifest' || !record.resourceId) continue;
    if (!map.has(record.resourceId)) map.set(record.resourceId, []);
    map.get(record.resourceId).push(record);
  }
  return map;
}

function hasRelevantManifest(manifestByResource, resourceId, request) {
  const records = manifestByResource.get(resourceId) || [];
  for (const record of records) {
    const timestamp = parseTs(record.observedAt || record.capturedAt);
    if (timestamp === null) continue;
    if (request.auditMs !== null && timestamp > request.auditMs) continue;
    if (request.requestedMs !== null && timestamp < request.requestedMs - 90 * 86400000) continue;
    return true;
  }
  return false;
}

function buildOwnership(store) {
  const resourceUsers = new Map();
  const strongRecords = [];
  const directOwners = new Map();

  const resourcesByFile = new Map();
  for (const record of store.records) {
    if (record.evidenceKind !== 'manifest' || !record.resourceId || !record.evidenceId) continue;
    if (!resourcesByFile.has(record.evidenceId)) resourcesByFile.set(record.evidenceId, new Set());
    resourcesByFile.get(record.evidenceId).add(record.resourceId);
  }
  const multiResourceImages = new Set();
  for (const [fileId, ids] of resourcesByFile.entries()) {
    if (ids.size > 1) {
      const imageRecord = store.records.find((record) => (
        record.evidenceId === fileId && record.parser === 'image_doc'
      ));
      if (imageRecord) multiResourceImages.add(fileId);
    }
  }

  for (const record of store.records) {
    if (!record.resourceId) continue;
    if (record.payload?.event_type === 'LINK_RESOURCE_IDENTITY') continue;
    if (record.evidenceKind === 'manifest' && ['evidence_document', 'evidence_screenshot'].includes(record.system)) continue;
    if (record.parser === 'image_doc' && multiResourceImages.has(record.evidenceId)) continue;
    if (!record.subjectUsers || record.subjectUsers.length !== 1) continue;
    if (!STRONG_METHODS.has(record.linkMethod)) continue;
    if (hasMultipleEmbeddedSubjects(record)) continue;
    strongRecords.push(record);
    addOwner(resourceUsers, record.resourceId, record.subjectUsers[0]);
    if (!directOwners.has(record.resourceId)) directOwners.set(record.resourceId, new Set());
    directOwners.get(record.resourceId).add(record.subjectUsers[0]);
  }

  for (const record of strongRecords) {
    for (const related of record.relatedResourceIds || []) {
      // Relations can point at system names or decoy resources. Only follow a
      // concrete resource reference that has no independent strong owner.
      if (!isResourceRef(related)) continue;
      if (directOwners.has(related)) continue;
      addOwner(resourceUsers, related, record.subjectUsers[0]);
    }
  }

  return { resourceUsers, strongRecords };
}

function requestsWithParsedTimes(caseUsers = new Map()) {
  return loadRequests(false).map((request, index) => ({
    ...request,
    user_id: caseUsers.get(request.case_id) || null,
    caseOrder: index,
    reportedMs: parseTs(request.reported_at),
    requestedMs: parseTs(request.requested_at),
    auditMs: parseTs(request.audit_at),
  }));
}

function closeToReported(request, eventMs, before = 240, after = 300) {
  if (!request.reportedMs || !eventMs) return false;
  const minutes = (eventMs - request.reportedMs) / 60000;
  return minutes >= -before && minutes <= after;
}

function resultCompatibility(status, result) {
  const normalized = String(result || '').toUpperCase();
  if (status === 'COMPLETE') {
    if (normalized === 'SUCCESS') return 0;
    if (normalized === 'PARTIAL') return 0.5;
    return 2.5;
  }
  if (status === 'NOT_STARTED') {
    if (normalized === 'FAILED') return 0;
    if (normalized === 'PARTIAL') return 1;
    return 2.5;
  }
  if (normalized === 'FAILED' || normalized === 'PARTIAL') return 0;
  return 0.75;
}

function applyLocalEventOrder(pairs) {
  const minOrder = new Map();
  for (const pair of pairs) {
    const current = minOrder.get(pair.request.case_id);
    if (current === undefined || pair.event.eventOrder < current) {
      minOrder.set(pair.request.case_id, pair.event.eventOrder);
    }
  }
  for (const pair of pairs) {
    const offset = pair.event.eventOrder - (minOrder.get(pair.request.case_id) || 0);
    pair.score += Math.max(offset, 0) * 0.05;
  }
}

function hasHint(request, category) {
  const pattern = HINTS[category];
  if (!pattern) return false;
  return pattern.test(request.request_text || '');
}

function hasCategoryForUser(resourceUsers, userId, category) {
  for (const [resourceId, users] of resourceUsers.entries()) {
    if (!users.has(userId)) continue;
    if (categoryOfResource(resourceId) === category) return true;
  }
  return false;
}

function hasAnyCategoryForUser(resourceUsers, userId, categories) {
  const wanted = new Set(categories);
  for (const [resourceId, users] of resourceUsers.entries()) {
    if (!users.has(userId)) continue;
    if (wanted.has(categoryOfResource(resourceId))) return true;
  }
  return false;
}

function assignAccounts({ resourceUsers, requests, activity, manifestByResource }) {
  const assignments = [];
  const events = activity
    .filter((event) => event.target_system === 'account_service')
    .filter((event) => event.event_type === 'DELETE_RECORD')
    .map((event, index) => ({
      ...event,
      eventMs: parseTs(event.event_time),
      eventOrder: index,
    }));

  const pairs = [];
  for (const request of requests) {
    if (!request.user_id) continue;
    if (hasCategoryForUser(resourceUsers, request.user_id, 'USER_PROFILE')) continue;
    for (const event of events) {
      if (!closeToReported(request, event.eventMs, 300, 180)) continue;
      if (categoryOfResource(event.resource_id) !== 'USER_PROFILE') continue;
      if (String(event.reported_result).toUpperCase() === 'FAILED'
        && request.reported_status !== 'NOT_STARTED'
        && !hasRelevantManifest(manifestByResource, event.resource_id, request)) continue;
      const owners = ownersOf(resourceUsers, event.resource_id);
      if (owners.size && !owners.has(request.user_id)) continue;
      const distance = Math.abs(event.eventMs - request.reportedMs) / 60000;
      let score = resultCompatibility(request.reported_status, event.reported_result) * 2;
      score += Math.min(distance / 60, 4);
      score += Math.abs(request.caseOrder - event.eventOrder) / 100000;
      pairs.push({ request, event, score, distance });
    }
  }

  applyLocalEventOrder(pairs);
  pairs.sort((a, b) => a.score - b.score || a.distance - b.distance);
  const usedCases = new Set();
  const usedResources = new Set();
  for (const pair of pairs) {
    if (usedCases.has(pair.request.case_id) || usedResources.has(pair.event.resource_id)) continue;
    if (pair.score > 5.5) continue;
    const owners = ownersOf(resourceUsers, pair.event.resource_id);
    if (owners.size && !owners.has(pair.request.user_id)) continue;
    addOwner(resourceUsers, pair.event.resource_id, pair.request.user_id);
    usedCases.add(pair.request.case_id);
    usedResources.add(pair.event.resource_id);
    assignments.push({
      case_id: pair.request.case_id,
      user_id: pair.request.user_id,
      resource_id: pair.event.resource_id,
      event_id: pair.event.activity_id,
      eventMs: pair.event.eventMs,
      reported_at: pair.request.reported_at,
      caseOrder: pair.request.caseOrder,
      reason: 'account_activity',
      score: pair.score,
    });
  }
  return assignments;
}

function assignCategoryEvents({
  resourceUsers,
  requests,
  activity,
  category,
  eventTypes,
  targetSystem,
  manifestByResource,
  requireHint = false,
  skipWhenOtherCategories = [],
  maxBefore = 300,
  maxAfter = 300,
}) {
  const assignments = [];
  const events = activity
    .filter((event) => (targetSystem ? event.target_system === targetSystem : true))
    .filter((event) => eventTypes.includes(event.event_type))
    .map((event, index) => ({
      ...event,
      eventMs: parseTs(event.event_time),
      eventOrder: index,
    }));

  const pairs = [];
  const eligibleByReported = new Map();
  for (const request of requests) {
    if (!request.user_id) continue;
    if (hasCategoryForUser(resourceUsers, request.user_id, category)) continue;
    eligibleByReported.set(request.reported_at, (eligibleByReported.get(request.reported_at) || 0) + 1);
  }
  for (const request of requests) {
    if (!request.user_id) continue;
    if (hasCategoryForUser(resourceUsers, request.user_id, category)) continue;
    const hint = hasHint(request, category);
    if (requireHint && !hint) continue;
    if (!hint && skipWhenOtherCategories.length
      && hasAnyCategoryForUser(resourceUsers, request.user_id, skipWhenOtherCategories)
      && (eligibleByReported.get(request.reported_at) || 0) < 2) continue;
    for (const event of events) {
      if (!closeToReported(request, event.eventMs, maxBefore, maxAfter)) continue;
      if (categoryOfActivity(event) !== category) continue;
      if (String(event.reported_result).toUpperCase() !== 'SUCCESS'
        && !hasRelevantManifest(manifestByResource, event.resource_id, request)) continue;
      const owners = ownersOf(resourceUsers, event.resource_id);
      if (owners.size && !owners.has(request.user_id)) continue;
      const distance = Math.abs(event.eventMs - request.reportedMs) / 60000;
      let score = Math.min(distance / 60, 4);
      if (!hint) score += 0.5;
      if (event.reported_result === 'SUCCESS' && request.reported_status === 'COMPLETE') score -= 0.15;
      if (event.reported_result === 'FAILED' && request.reported_status === 'NOT_STARTED') score -= 0.15;
      score += Math.abs(request.caseOrder - event.eventOrder) / 100000;
      pairs.push({ request, event, score, distance });
    }
  }

  applyLocalEventOrder(pairs);
  pairs.sort((a, b) => (
    a.score - b.score
    || a.event.eventOrder - b.event.eventOrder
    || a.distance - b.distance
  ));
  const usedCases = new Set();
  const usedResources = new Set();
  for (const pair of pairs) {
    if (usedCases.has(pair.request.case_id) || usedResources.has(pair.event.resource_id)) continue;
    const owners = ownersOf(resourceUsers, pair.event.resource_id);
    if (owners.size && !owners.has(pair.request.user_id)) continue;
    if (pair.score > 5.0) continue;
    addOwner(resourceUsers, pair.event.resource_id, pair.request.user_id);
    usedCases.add(pair.request.case_id);
    usedResources.add(pair.event.resource_id);
    assignments.push({
      case_id: pair.request.case_id,
      user_id: pair.request.user_id,
      resource_id: pair.event.resource_id,
      event_id: pair.event.activity_id,
      eventMs: pair.event.eventMs,
      reported_at: pair.request.reported_at,
      caseOrder: pair.request.caseOrder,
      reason: `${category.toLowerCase()}_activity`,
      score: pair.score,
    });
  }
  return assignments;
}

function fileUsers(store, resourceUsers) {
  const out = new Map();
  for (const record of store.records) {
    if (record.evidenceKind !== 'manifest') continue;
    if (!record.resourceId) continue;
    const users = ownersOf(resourceUsers, record.resourceId);
    if (!users.size) continue;
    if (!out.has(record.evidenceId)) out.set(record.evidenceId, new Set());
    for (const user of users) out.get(record.evidenceId).add(user);
  }
  return out;
}

function reorderEventAssignments(assignments, resourceUsers, requests) {
  const reorderReasons = new Set(['account_activity', 'analytics_profile_activity']);
  const groups = new Map();
  for (const assignment of assignments) {
    if (!reorderReasons.has(assignment.reason)) continue;
    if (!assignment.eventMs || !assignment.reported_at) continue;
    const key = `${assignment.reason}|${assignment.reported_at}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(assignment);
  }

  const requestCount = new Map();
  for (const request of requests) {
    if (!request.reported_at) continue;
    requestCount.set(request.reported_at, (requestCount.get(request.reported_at) || 0) + 1);
  }

  for (const [key, group] of groups.entries()) {
    if (group.length < 2) continue;
    const reportedAt = key.split('|').slice(1).join('|');
    if ((requestCount.get(reportedAt) || 0) !== group.length) continue;
    const eventTimes = group.map((assignment) => assignment.eventMs).sort((a, b) => a - b);
    if (eventTimes[eventTimes.length - 1] - eventTimes[0] > 30 * 60000) continue;

    const cases = group.map((assignment) => assignment.case_id).sort();
    const entries = [...group].sort((a, b) => (
      a.eventMs - b.eventMs || String(a.event_id).localeCompare(String(b.event_id))
    ));
    const userByCase = new Map(group.map((assignment) => [assignment.case_id, assignment.user_id]));
    const current = entries.map((assignment) => assignment.case_id);
    if (current.every((caseId, index) => caseId === cases[index])) continue;

    const groupUsers = new Set(group.map((assignment) => assignment.user_id));
    let blocked = false;
    for (const assignment of group) {
      const owners = ownersOf(resourceUsers, assignment.resource_id);
      for (const owner of owners) {
        if (!groupUsers.has(owner)) blocked = true;
      }
    }
    if (blocked) continue;

    for (const assignment of group) {
      const owners = resourceUsers.get(assignment.resource_id);
      if (!owners) continue;
      owners.delete(assignment.user_id);
      if (!owners.size) resourceUsers.delete(assignment.resource_id);
    }

    const desired = cases.map((caseId, index) => ({
      caseId,
      userId: userByCase.get(caseId),
      entry: entries[index],
    }));
    for (const item of desired) {
      addOwner(resourceUsers, item.entry.resource_id, item.userId);
      item.entry.case_id = item.caseId;
      item.entry.user_id = item.userId;
    }
  }
}

function assignBundlePositions({ store, resourceUsers, requests }) {
  const assignments = [];
  const userByFile = fileUsers(store, resourceUsers);
  const requestByUser = new Map();
  for (const request of requests) {
    if (request.user_id) requestByUser.set(request.user_id, request);
  }

  const byFile = new Map();
  for (const record of store.records) {
    if (record.evidenceKind !== 'manifest') continue;
    if (!record.resourceId) continue;
    if (!byFile.has(record.evidenceId)) byFile.set(record.evidenceId, []);
    byFile.get(record.evidenceId).push(record);
  }

  for (const [fileId, records] of byFile.entries()) {
    const users = userByFile.get(fileId) || new Set();
    if (users.size < 2) continue;
    const byCategory = new Map();
    for (const record of records) {
      const category = record.category || categoryOfResource(record.resourceId);
      if (!ACTIVITY_FOR_CATEGORY[category]) continue;
      if (!byCategory.has(category)) byCategory.set(category, []);
      byCategory.get(category).push(record);
    }
    for (const [category, categoryRecords] of byCategory.entries()) {
      // Only analytics bundles have a stable positional layout in the public
      // evidence. Positional guesses for search/support/export resources are
      // too weak and create false remaining-record findings.
      if (category !== 'ANALYTICS_PROFILE') continue;
      const unlinked = [];
      const seen = new Set();
      for (const record of categoryRecords) {
        if (ownersOf(resourceUsers, record.resourceId).size) continue;
        if (seen.has(record.resourceId)) continue;
        seen.add(record.resourceId);
        unlinked.push(record);
      }
      if (!unlinked.length) continue;

      const candidates = [];
      for (const user of users) {
        const request = requestByUser.get(user);
        if (!request) continue;
        if (hasCategoryForUser(resourceUsers, user, category)) continue;
        if (!hasHint(request, category)) continue;
        candidates.push(request);
      }
      if (candidates.length !== unlinked.length || !candidates.length) continue;
      candidates.sort((a, b) => a.case_id.localeCompare(b.case_id));
      for (let i = 0; i < unlinked.length; i += 1) {
        const request = candidates[i];
        addOwner(resourceUsers, unlinked[i].resourceId, request.user_id);
        assignments.push({
          case_id: request.case_id,
          user_id: request.user_id,
          resource_id: unlinked[i].resourceId,
          event_id: '',
          reason: 'bundle_position',
          score: 0,
        });
      }
    }
  }
  return assignments;
}

function inferResources(store, caseUsers = new Map(), providedRequests = null) {
  const { resourceUsers } = buildOwnership(store);
  const activity = loadActivity();
  const baseRequests = providedRequests || requestsWithParsedTimes(caseUsers);
  const requests = baseRequests.map((request, index) => ({
    ...request,
    user_id: request.user_id || caseUsers.get(request.case_id) || null,
    caseOrder: request.caseOrder ?? index,
    requestedMs: request.requestedMs ?? parseTs(request.requested_at),
    reportedMs: request.reportedMs ?? parseTs(request.reported_at),
    auditMs: request.auditMs ?? parseTs(request.audit_at),
  }));
  const manifestByResource = manifestResourceMap(store);
  store.activity = activity;

  const assignments = [];
  assignments.push(...assignAccounts({
    resourceUsers,
    requests,
    activity,
    manifestByResource,
  }));
  // DELETE on analytics is a cache-entry action; ANONYMIZE is the profile action.
  assignments.push(...assignCategoryEvents({
    resourceUsers,
    requests,
    activity,
    category: 'CACHE_ENTRY',
    eventTypes: ['DELETE_RECORD'],
    targetSystem: 'analytics_platform',
    manifestByResource,
    maxBefore: 300,
    maxAfter: 300,
  }));
  assignments.push(...assignCategoryEvents({
    resourceUsers,
    requests,
    activity,
    category: 'ANALYTICS_PROFILE',
    eventTypes: ['ANONYMIZE_RECORD'],
    targetSystem: 'analytics_platform',
    manifestByResource,
    skipWhenOtherCategories: [
      'SEARCH_INDEX_ENTRY',
      'SUPPORT_MESSAGE',
      'SUPPORT_ATTACHMENT',
      'DATA_FLOW',
      'BACKUP_ARCHIVE',
      'USER_EXPORT',
    ],
    maxBefore: 300,
    maxAfter: 300,
  }));
  assignments.push(...assignCategoryEvents({
    resourceUsers,
    requests,
    activity,
    category: 'SEARCH_INDEX_ENTRY',
    eventTypes: ['DELETE_RECORD'],
    targetSystem: 'search_service',
    manifestByResource,
    requireHint: true,
    maxBefore: 300,
    maxAfter: 360,
  }));
  assignments.push(...assignCategoryEvents({
    resourceUsers,
    requests,
    activity,
    category: 'DATA_FLOW',
    eventTypes: ['CHECK_DATA_FLOW', 'DISABLE_DATA_FLOW', 'SYNC_RECORD'],
    targetSystem: 'integration_service',
    manifestByResource,
    requireHint: true,
    maxBefore: 300,
    maxAfter: 300,
  }));
  assignments.push(...assignBundlePositions({ store, resourceUsers, requests }));

  reorderEventAssignments(assignments, resourceUsers, requests);
  return { resourceUsers, assignments, activity };
}

export {
  inferResources,
  buildOwnership,
  categoryOfResource,
  categoryOfActivity,
  addOwner,
  ownersOf,
  hasHint,
  STRONG_METHODS,
  ACTIVITY_FOR_CATEGORY,
};
