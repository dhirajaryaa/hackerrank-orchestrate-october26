import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import pdfParse from 'pdf-parse';
import { makeRecord, guessRecordType, guessSystem } from '../model.js';
import { findEmails, findPhones, findResourceIds, findUserRefs } from '../util.js';

const LABEL_RE = /^\s*(Record|Detail)\s{2,}(.+?)\s*$/;
const REGISTER_RE = /^\s*\d+\s{2,}([A-Z]{2,}-\S+)\s*\|\s*(user_\d+)\s*\|(.+)$/;
const REFERENCE_RE = /\b(?:CJX|CS|NST|ORD|SWF)-[0-9A-Z-]+\b/;

function extractText(filePath) {
  try {
    const text = execFileSync('pdftotext', ['-layout', filePath, '-'], {
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (text.trim()) return { text, engine: 'pdftotext' };
  } catch {
    // Fall through to the JS PDF parser.
  }
  return pdfParse(fs.readFileSync(filePath)).then((result) => ({ text: result.text || '', engine: 'pdf-parse' }));
}

function inferResourceType(text, resourceId) {
  const lower = String(text || '').toLowerCase();
  const prefix = String(resourceId).split('_')[0];
  if (prefix === 'support') {
    if (lower.includes('attachment') || lower.includes('delivery address correction')) return 'SUPPORT_ATTACHMENT';
    return 'SUPPORT_MESSAGE';
  }
  if (prefix === 'account') return 'USER_PROFILE';
  if (prefix === 'search') return 'SEARCH_INDEX_ENTRY';
  if (prefix === 'analytics') return 'ANALYTICS_PROFILE';
  if (prefix === 'support') return 'SUPPORT_MESSAGE';
  if (prefix === 'export') return 'USER_EXPORT';
  if (prefix === 'data_flow') return 'DATA_FLOW';
  if (prefix === 'backup' || prefix === 'archive') return 'BACKUP_ARCHIVE';
  if (prefix === 'audit_record') return 'SECURITY_AUDIT_LOG';
  if (prefix === 'tombstone') return 'ACCOUNT_TOMBSTONE';
  if (prefix === 'marketing') return 'MARKETING_PROFILE';
  if (prefix === 'email_delivery') return 'EMAIL_DELIVERY_LOG';
  if (prefix === 'cache') return 'CACHE_ENTRY';
  if (prefix === 'object') return 'SUPPORT_ATTACHMENT';
  if (prefix === 'legal_hold') return 'LEGAL_HOLD_RECORD';
  return guessRecordType(guessSystem(resourceId), null);
}

function inferState(text, recordType) {
  const lower = String(text || '').toLowerCase();
  if (recordType === 'BACKUP_ARCHIVE') {
    if (/(restore[^.\n]{0,30}(blocked|not allowed|disabled))|restore_allowed\s*[:=]?\s*(false|no)/i.test(lower)) return 'BLOCKED';
    return 'ACTIVE';
  }
  if (recordType === 'DATA_FLOW') {
    if (/(connector[^.\n]{0,30}(disabled|stopped|inactive))|enabled\s*[:=]?\s*(false|no)/i.test(lower)) return 'DISABLED';
    return 'ACTIVE';
  }
  if (recordType === 'ACCOUNT_TOMBSTONE') {
    if (/\b(redacted|no direct identifier|deleted)\b/i.test(lower)) return 'REDACTED';
    return 'PRESENT';
  }
  if (recordType === 'ANALYTICS_PROFILE') {
    if (/\b(anonymi[sz]ed|no direct identifier)\b/i.test(lower)) return 'ANONYMIZED';
    return 'PRESENT';
  }
  if (recordType === 'SUPPORT_MESSAGE') {
    if (/\b(redacted|no direct identifier)\b/i.test(lower)) return 'REDACTED';
    return 'PRESENT';
  }
  if (recordType === 'USER_PROFILE' && /\b(not found|deleted|absent)\b/i.test(lower)) return 'ABSENT';
  if (recordType === 'SEARCH_INDEX_ENTRY' && /\b(not found|miss|absent)\b/i.test(lower)) return 'ABSENT';
  return 'PRESENT';
}

async function parse(evidence) {
  const { text, engine } = await extractText(evidence.absolute_path);
  if (!text.trim()) return { records: [], detail: `engine=${engine} no-text` };

  const labels = {};
  const keyRecords = [];
  for (const line of text.split(/\r?\n/)) {
    const match = LABEL_RE.exec(line);
    if (!match) continue;
    const label = match[1].toLowerCase();
    const value = match[2].trim();
    if (!labels[label]) labels[label] = [];
    labels[label].push(value);
    if (label === 'record') keyRecords.push(value);
  }

  const registerRows = [];
  for (const line of text.split(/\r?\n/)) {
    const match = REGISTER_RE.exec(line);
    if (match) {
      registerRows.push({
        order_id: match[1],
        subject_reference: match[2],
        detail: match[3].trim(),
      });
    }
  }

  const resourceIds = findResourceIds(text);
  const emails = findEmails(text);
  const phones = findPhones(text);
  const userRefs = findUserRefs(text);
  const references = [...new Set((text.match(REFERENCE_RE) || []))];
  const singleSubject = userRefs.length === 1 || emails.length === 1;
  const subjectIdentifiers = singleSubject
    ? { emails, phones, user_refs: userRefs }
    : { emails: [], phones: [], user_refs: [] };
  const linkKeys = singleSubject ? [...emails, ...userRefs, ...phones] : [...emails, ...userRefs];
  const payload = {
    engine,
    title: text.split(/\r?\n/)[0]?.trim() || '',
    key_records: keyRecords,
    labels,
    register_rows: registerRows,
    resource_ids: [...new Set(resourceIds)],
    emails,
    phones,
    user_refs: userRefs,
    references,
    characters: text.length,
    text: text.slice(0, 8000),
  };

  const records = [
    makeRecord({
      evidenceId: evidence.file_id,
      capturedAt: evidence.captured_at,
      observedAt: evidence.captured_at,
      system: 'evidence_document',
      resourceId: evidence.file_id,
      recordType: 'DOCUMENT',
      state: 'REFERENCED',
      identifiers: subjectIdentifiers,
      linkKeys,
      payload,
      parser: 'pdf_doc',
      sourcePath: evidence.file_path,
    }),
  ];

  for (const resourceId of [...new Set(resourceIds)]) {
    const recordType = inferResourceType(text, resourceId);
    const state = inferState(text, recordType);
    records.push(makeRecord({
      evidenceId: evidence.file_id,
      capturedAt: evidence.captured_at,
      observedAt: evidence.captured_at,
      system: guessSystem(resourceId),
      resourceId,
      recordType,
      state,
      identifiers: singleSubject ? subjectIdentifiers : {},
      linkKeys: singleSubject ? linkKeys : [],
      payload: { source: 'pdf_doc', file_id: evidence.file_id, title: payload.title, text: text.slice(0, 4000) },
      parser: 'pdf_doc',
      sourcePath: evidence.file_path,
    }));
  }

  return {
    records,
    detail: `engine=${engine} chars=${text.length} labels=${keyRecords.length} resources=${new Set(resourceIds).size} subjects=${emails.length + userRefs.length}`,
  };
}

export { parse, inferResourceType, inferState };
