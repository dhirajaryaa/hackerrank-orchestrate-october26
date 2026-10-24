import { directLinkUsers } from './model.js';
import { normEmail, sha256, unique } from './util.js';

const RESOURCE_REF_RE = /\b(?:account|search|analytics|support|export|data_flow|backup|audit_record|tombstone|email_delivery|cache|object|marketing|legal_hold|archive)_[A-Za-z0-9]+\b/g;

function relatedResourcesOf(record) {
  const found = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 5 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      RESOURCE_REF_RE.lastIndex = 0;
      for (const match of value.matchAll(RESOURCE_REF_RE)) {
        if (match[0] !== record.resourceId) found.add(match[0]);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const item of Object.values(value)) visit(item, depth + 1);
    }
  };
  visit(record.payload);
  visit(record.identifiers);
  return unique([...found]).sort();
}

class Linker {
  constructor(resolver, store) {
    this.resolver = resolver;
    this.store = store;
    this.counts = { explicit_ref: 0, identifier: 0, link_key: 0, resource_alias: 0, none: 0 };
  }

  run() {
    this.linkDirect();
    this.propagateAliases();
    this.propagateLinkKeys();
    for (const record of this.store.records) {
      if (!record.subjectUsers || !record.subjectUsers.length) {
        this.counts.none += 1;
      }
    }
    return this.counts;
  }

  linkDirect() {
    for (const record of this.store.records) {
      record.relatedResourceIds = relatedResourcesOf(record);
      if (record.system === 'evidence_document' || record.system === 'evidence_screenshot') continue;
      if (record.payload?.event_type === 'LINK_RESOURCE_IDENTITY') continue;
      const { users, method } = directLinkUsers(record.identifiers, this.resolver);
      if (users.size) {
        record.subjectUsers = [...users].sort();
        record.linkMethod = method;
        this.counts[method] = (this.counts[method] || 0) + 1;
      }
    }
  }

  propagateAliases() {
    const alias = new Map();
    const strongOwners = new Map();
    for (const record of this.store.records) {
      if (!record.subjectUsers || record.subjectUsers.length !== 1) continue;
      if (!['explicit_ref', 'identifier', 'link_key'].includes(record.linkMethod)) continue;
      if (!strongOwners.has(record.resourceId)) strongOwners.set(record.resourceId, new Set());
      strongOwners.get(record.resourceId).add(record.subjectUsers[0]);
    }
    for (const record of this.store.records) {
      if (!record.subjectUsers || record.subjectUsers.length !== 1) continue;
      if (!['explicit_ref', 'identifier', 'link_key'].includes(record.linkMethod)) continue;
      for (const related of record.relatedResourceIds || []) {
        const owners = strongOwners.get(related);
        if (owners && !owners.has(record.subjectUsers[0])) continue;
        if (!alias.has(related)) alias.set(related, new Set());
        alias.get(related).add(record.subjectUsers[0]);
      }
    }
    for (const record of this.store.records) {
      if (!record.subjectUsers || !record.subjectUsers.length) continue;
      if (!alias.has(record.resourceId)) alias.set(record.resourceId, new Set());
      for (const user of record.subjectUsers) alias.get(record.resourceId).add(user);
    }
    let changed = true;
    let guard = 0;
    while (changed && guard < 8) {
      changed = false;
      guard += 1;
      for (const record of this.store.records) {
        if (record.subjectUsers && record.subjectUsers.length) continue;
        const users = alias.get(record.resourceId);
        if (!users || !users.size) continue;
        record.subjectUsers = [...users].sort();
        record.linkMethod = 'resource_alias';
        this.counts.resource_alias += 1;
        changed = true;
      }
      for (const record of this.store.records) {
        if (!record.subjectUsers || !record.subjectUsers.length) continue;
        if (!alias.has(record.resourceId)) alias.set(record.resourceId, new Set());
        for (const user of record.subjectUsers) alias.get(record.resourceId).add(user);
      }
    }
  }

  propagateLinkKeys() {
    const keyUsers = new Map();
    const add = (key, users) => {
      if (!key) return;
      const text = String(key).trim();
      if (!text) return;
      if (!keyUsers.has(text)) keyUsers.set(text, new Set());
      for (const user of users) keyUsers.get(text).add(user);
      const lower = text.toLowerCase();
      if (lower !== text) {
        if (!keyUsers.has(lower)) keyUsers.set(lower, new Set());
        for (const user of users) keyUsers.get(lower).add(user);
      }
    };

    const absorb = () => {
      let changed = false;
      for (const record of this.store.records) {
        if (!record.subjectUsers || !record.subjectUsers.length) continue;
        for (const key of record.linkKeys || []) {
          const before = keyUsers.get(key)?.size || 0;
          add(key, record.subjectUsers);
          if ((keyUsers.get(key)?.size || 0) !== before) changed = true;
          if (key.includes('@')) {
            const normalized = normEmail(key);
            const hashed = sha256(normalized);
            for (const value of [normalized, hashed]) {
              const n = keyUsers.get(value)?.size || 0;
              add(value, record.subjectUsers);
              if ((keyUsers.get(value)?.size || 0) !== n) changed = true;
            }
          }
        }
      }
      return changed;
    };

    absorb();
    let changed = true;
    let guard = 0;
    while (changed && guard < 8) {
      changed = false;
      guard += 1;
      for (const record of this.store.records) {
        if (record.subjectUsers && record.subjectUsers.length) continue;
        const users = new Set();
        for (const key of record.linkKeys || []) {
          for (const user of this.resolver.usersForIdentifier(key)) users.add(user);
          if (key.includes('@')) {
            for (const user of this.resolver.usersForIdentifier(normEmail(key))) users.add(user);
            for (const user of this.resolver.usersForIdentifier(sha256(normEmail(key)))) users.add(user);
          }
          for (const user of keyUsers.get(key) || []) users.add(user);
        }
        if (users.size) {
          record.subjectUsers = [...users].sort();
          record.linkMethod = 'link_key';
          this.counts.link_key += 1;
          changed = true;
        }
      }
      if (absorb()) changed = true;
    }
  }

  resourcesForUser(userId) {
    const seen = new Set();
    const out = [];
    for (const record of this.store.records) {
      if (!record.subjectUsers?.includes(userId)) continue;
      const key = `${record.system}|${record.resourceId}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(record);
      }
    }
    return out;
  }
}

export { Linker };
