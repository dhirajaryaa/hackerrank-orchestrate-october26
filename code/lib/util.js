import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse } from 'csv-parse/sync';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const USER_RE = /\buser_\d+\b/g;
const RESOURCE_RE = /\b(?:account|search|analytics|support|export|data_flow|backup|audit_record|tombstone|email_delivery|cache|object|marketing|legal_hold|archive|order)_[A-Za-z0-9]+\b/g;
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{1,4}\)?[\s.-]?){2,5}\d{2,4}/g;

function readCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  return parse(text, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
    trim: false,
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function writeCsv(filePath, rows, columns) {
  const cols = columns || (rows.length ? Object.keys(rows[0]) : []);
  const escape = (value) => {
    const text = value === undefined || value === null ? '' : String(value);
    if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  };
  const lines = [cols.map(escape).join(',')];
  for (const row of rows) lines.push(cols.map((c) => escape(row[c])).join(','));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function parseTs(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(text)
    ? text
    : text.replace(' ', 'T');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function tsKey(value) {
  const ms = parseTs(value);
  return ms === null ? 0 : ms;
}

function isBeforeOrAt(value, cutoff) {
  const ms = parseTs(value);
  const limit = parseTs(cutoff);
  if (limit === null) return true;
  if (ms === null) return false;
  return ms <= limit;
}

function normEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normPhone(value) {
  return String(value || '').replace(/[^\d+]/g, '').trim();
}

function normName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function unique(values) {
  return [...new Set((values || []).filter((v) => v !== undefined && v !== null && v !== ''))];
}

function findEmails(text) {
  return unique((String(text || '').match(EMAIL_RE) || []).map((v) => v.toLowerCase()));
}

function findUserRefs(text) {
  return unique((String(text || '').match(USER_RE) || []).map((v) => v.toLowerCase()));
}

function findResourceIds(text) {
  return unique((String(text || '').match(RESOURCE_RE) || []));
}

function findPhones(text) {
  const found = [];
  for (const raw of String(text || '').match(PHONE_RE) || []) {
    const value = raw.trim();
    const digits = value.replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 15 && !value.includes('@')) found.push(value);
  }
  return unique(found);
}

function getNested(obj, keys) {
  for (const key of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined) return obj[key];
  }
  return undefined;
}

function lowerKeys(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[String(k).toLowerCase()] = v;
  return out;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sortBy(values, fn) {
  return [...values].sort((a, b) => {
    const ka = fn(a);
    const kb = fn(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
}

export {
  EMAIL_RE,
  USER_RE,
  RESOURCE_RE,
  readCsv,
  readJson,
  readText,
  writeCsv,
  ensureDir,
  parseTs,
  tsKey,
  isBeforeOrAt,
  normEmail,
  normPhone,
  normName,
  sha256,
  unique,
  findEmails,
  findUserRefs,
  findResourceIds,
  findPhones,
  getNested,
  lowerKeys,
  escapeRegExp,
  sortBy,
};
