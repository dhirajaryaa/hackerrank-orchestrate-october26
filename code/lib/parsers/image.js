import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorker, PSM } from 'tesseract.js';
import { BUILD_DIR } from '../config.js';
import { makeRecord, guessRecordType, guessSystem } from '../model.js';
import { findEmails, findPhones, findUserRefs, ensureDir } from '../util.js';
import { inferState } from './pdf.js';

const OCR_CACHE_DIR = path.join(BUILD_DIR, 'ocr');
const RESOURCE_RE = /\b(account|search|analytics|support|export|data_flow|backup|audit_record|tombstone|email_delivery|cache|object|marketing|legal_hold|archive)\s*_\s*([A-Za-z0-9]+)\b/g;

let workerPromise = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker('eng', 1, { logger: () => {} });
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
      return worker;
    })();
  }
  return workerPromise;
}

function normalizeOcr(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/\b(account|search|analytics|support|export|data_flow|backup|audit_record|tombstone|email_delivery|cache|object|marketing|legal_hold|archive)\s+_\s*([A-Za-z0-9]+)\b/gi, (_, prefix, suffix) => `${prefix.toLowerCase()}_${suffix}`)
    .replace(/\buser\s+(\d{1,3})\b/gi, 'user_$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

async function extractOcr(filePath, fileId) {
  ensureDir(OCR_CACHE_DIR);
  const cachePath = path.join(OCR_CACHE_DIR, `${fileId}.txt`);
  if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 20) {
    return { text: fs.readFileSync(cachePath, 'utf8'), engine: 'cache' };
  }
  try {
    const worker = await getWorker();
    const result = await worker.recognize(filePath);
    const text = result.data.text || '';
    fs.writeFileSync(cachePath, text, 'utf8');
    return { text, engine: 'tesseract.js' };
  } catch {
    try {
      const text = execFileSync('tesseract', [filePath, 'stdout', '--psm', '6'], {
        encoding: 'utf8',
        timeout: 120000,
      });
      fs.writeFileSync(cachePath, text, 'utf8');
      return { text, engine: 'tesseract-cli' };
    } catch {
      return { text: '', engine: 'tesseract-unavailable' };
    }
  }
}

function inferResourceType(text, resourceId) {
  const lower = String(text || '').toLowerCase();
  const prefix = String(resourceId).split('_')[0];
  if (prefix === 'support') return lower.includes('attachment') ? 'SUPPORT_ATTACHMENT' : 'SUPPORT_MESSAGE';
  if (prefix === 'account') return 'USER_PROFILE';
  if (prefix === 'search') return 'SEARCH_INDEX_ENTRY';
  if (prefix === 'analytics') return 'ANALYTICS_PROFILE';
  if (prefix === 'export') return 'USER_EXPORT';
  if (prefix === 'data_flow') return 'DATA_FLOW';
  if (prefix === 'backup' || prefix === 'archive') return 'BACKUP_ARCHIVE';
  if (prefix === 'audit_record') return 'SECURITY_AUDIT_LOG';
  if (prefix === 'tombstone') return 'ACCOUNT_TOMBSTONE';
  if (prefix === 'marketing') return 'MARKETING_PROFILE';
  if (prefix === 'object') return 'SUPPORT_ATTACHMENT';
  return guessRecordType(guessSystem(resourceId), null);
}

async function parse(evidence) {
  const { text: raw, engine } = await extractOcr(evidence.absolute_path, evidence.file_id);
  const text = normalizeOcr(raw);
  if (!text.trim()) return { records: [], detail: `engine=${engine} no-text` };

  const resourceIds = [];
  let match;
  RESOURCE_RE.lastIndex = 0;
  while ((match = RESOURCE_RE.exec(text)) !== null) {
    const resourceId = `${match[1].toLowerCase()}_${match[2]}`;
    if (!resourceIds.includes(resourceId)) resourceIds.push(resourceId);
  }
  const emails = findEmails(text);
  const phones = findPhones(text);
  const userRefs = findUserRefs(text);
  const singleSubject = userRefs.length === 1 || emails.length === 1;
  const subjectIdentifiers = singleSubject ? { emails, phones, user_refs: userRefs } : { emails: [], phones: [], user_refs: [] };
  const linkKeys = singleSubject ? [...emails, ...userRefs, ...phones] : [...emails, ...userRefs];
  const payload = { engine, resource_ids: resourceIds, emails, phones, user_refs: userRefs, characters: text.length, text: text.slice(0, 8000) };

  const records = [
    makeRecord({
      evidenceId: evidence.file_id,
      capturedAt: evidence.captured_at,
      observedAt: evidence.captured_at,
      system: 'evidence_screenshot',
      resourceId: evidence.file_id,
      recordType: 'SCREENSHOT',
      state: 'REFERENCED',
      identifiers: subjectIdentifiers,
      linkKeys,
      payload,
      parser: 'image_doc',
      sourcePath: evidence.file_path,
    }),
  ];

  for (const resourceId of resourceIds) {
    const recordType = inferResourceType(text, resourceId);
    records.push(makeRecord({
      evidenceId: evidence.file_id,
      capturedAt: evidence.captured_at,
      observedAt: evidence.captured_at,
      system: guessSystem(resourceId),
      resourceId,
      recordType,
      state: inferState(text, recordType),
      identifiers: singleSubject ? subjectIdentifiers : {},
      linkKeys: singleSubject ? linkKeys : [],
      payload: { source: 'image_doc', file_id: evidence.file_id, text: text.slice(0, 5000) },
      parser: 'image_doc',
      sourcePath: evidence.file_path,
    }));
  }

  return {
    records,
    detail: `engine=${engine} chars=${text.length} resources=${resourceIds.length} subjects=${emails.length + userRefs.length}`,
  };
}

export { parse, normalizeOcr, inferResourceType };
