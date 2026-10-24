import path from 'node:path';
import { z } from 'zod';
import { DATASET_DIR } from './config.js';
import {
  readCsv,
  normEmail,
  normPhone,
  normName,
  sha256,
  unique,
} from './util.js';

const identitySchema = z.object({
  user_id: z.string().min(1),
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  email_hash: z.string(),
  updated_at: z.string(),
});

const auditSchema = z.object({
  audit_id: z.string().min(1),
  user_id: z.string().min(1),
  field_name: z.string().min(1),
  old_value: z.string(),
  new_value: z.string(),
  event_time: z.string().min(1),
});

function loadIdentities() {
  const rows = readCsv(path.join(DATASET_DIR, 'user_identities.csv'));
  const identities = new Map();
  for (const row of rows) {
    const parsed = identitySchema.parse(row);
    identities.set(parsed.user_id, parsed);
  }
  return identities;
}

function loadAuditLog() {
  return readCsv(path.join(DATASET_DIR, 'user_audit_log.csv')).map((row) => auditSchema.parse(row));
}

class IdentityResolver {
  constructor(identities, auditLog) {
    this.identities = identities;
    this.auditLog = auditLog;
    this.byUser = new Map();
    this.email = new Map();
    this.hash = new Map();
    this.phone = new Map();
    this.name = new Map();
    this.auditByValue = new Map();

    for (const identity of identities.values()) {
      this.addUserValues(identity.user_id, identity);
    }
    for (const entry of auditLog) {
      if (!this.byUser.has(entry.user_id)) this.byUser.set(entry.user_id, []);
      this.byUser.get(entry.user_id).push(entry);
      for (const value of [entry.old_value, entry.new_value]) {
        if (!value) continue;
        const key = normEmail(value);
        if (!this.auditByValue.has(key)) this.auditByValue.set(key, []);
        this.auditByValue.get(key).push(entry);
      }
      if (entry.field_name === 'email') {
        this.link(this.email, entry.old_value, entry.user_id);
        this.link(this.email, entry.new_value, entry.user_id);
        this.link(this.hash, sha256(normEmail(entry.old_value)), entry.user_id);
        this.link(this.hash, sha256(normEmail(entry.new_value)), entry.user_id);
      } else if (entry.field_name === 'email_hash') {
        this.link(this.hash, entry.old_value, entry.user_id);
        this.link(this.hash, entry.new_value, entry.user_id);
      } else if (entry.field_name === 'phone') {
        this.link(this.phone, entry.old_value, entry.user_id);
        this.link(this.phone, entry.new_value, entry.user_id);
      }
    }
  }

  link(index, value, userId) {
    if (!value) return;
    const key = String(value).trim().toLowerCase();
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(userId);
  }

  addUserValues(userId, values) {
    if (values.email) {
      this.link(this.email, normEmail(values.email), userId);
      this.link(this.hash, sha256(normEmail(values.email)), userId);
    }
    if (values.phone) {
      this.link(this.phone, normPhone(values.phone), userId);
      this.link(this.phone, values.phone, userId);
    }
    if (values.email_hash) this.link(this.hash, String(values.email_hash).trim().toLowerCase(), userId);
    if (values.name) this.link(this.name, normName(values.name), userId);
  }

  resolveEmail(email) {
    const key = normEmail(email);
    if (!key) return { userId: null, kind: 'unknown', auditIds: [] };
    const current = this.email.get(key) || new Set();
    const auditHits = this.auditByValue.get(key) || [];
    const auditIds = unique(auditHits.map((e) => e.audit_id)).sort();
    if (current.size) {
      const userId = [...current].sort()[0];
      const identity = this.identities.get(userId);
      const kind = identity && normEmail(identity.email) === key ? 'current' : 'historical';
      return { userId, kind, auditIds };
    }
    const hashed = this.hash.get(sha256(key)) || new Set();
    if (hashed.size) return { userId: [...hashed].sort()[0], kind: 'historical', auditIds };
    if (auditHits.length) return { userId: [...new Set(auditHits.map((e) => e.user_id))].sort()[0], kind: 'historical', auditIds };
    return { userId: null, kind: 'unknown', auditIds };
  }

  usersForIdentifier(value) {
    if (value === undefined || value === null || value === '') return new Set();
    const text = String(value).trim();
    if (!text) return new Set();
    if (/^user_\d+$/.test(text)) return this.identities.has(text) ? new Set([text]) : new Set();
    const key = text.toLowerCase();
    const found = new Set();
    if (key.includes('@')) {
      for (const user of this.email.get(key) || []) found.add(user);
      for (const user of this.hash.get(sha256(key)) || []) found.add(user);
    }
    for (const user of this.hash.get(key) || []) found.add(user);
    for (const user of this.phone.get(key) || []) found.add(user);
    for (const user of this.phone.get(normPhone(key)) || []) found.add(user);
    for (const user of this.name.get(normName(key)) || []) found.add(user);
    return found;
  }

  resolveCase(request) {
    const resolved = this.resolveEmail(request.email);
    const resolution = {
      userId: resolved.userId,
      emailSupplied: request.email,
      emailKind: resolved.kind,
      matchedAuditIds: resolved.auditIds,
      name: null,
      current: {},
      historical: {},
    };
    if (resolved.userId && this.identities.has(resolved.userId)) {
      const identity = this.identities.get(resolved.userId);
      resolution.name = identity.name;
      resolution.current = {
        user_id: identity.user_id,
        name: identity.name,
        email: identity.email,
        phone: identity.phone,
        email_hash: identity.email_hash,
      };
      const history = {};
      for (const entry of this.byUser.get(resolved.userId) || []) {
        if (!entry.old_value) continue;
        if (!history[entry.field_name]) history[entry.field_name] = [];
        if (!history[entry.field_name].includes(entry.old_value)) history[entry.field_name].push(entry.old_value);
      }
      resolution.historical = history;
    }
    return resolution;
  }
}

function createIdentityResolver() {
  return new IdentityResolver(loadIdentities(), loadAuditLog());
}

export { createIdentityResolver, IdentityResolver };
