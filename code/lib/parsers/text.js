import fs from 'node:fs';
import { makeRecord, guessRecordType, guessSystem } from '../model.js';

const SNAPSHOT_RE = /Snapshot:\s*(\S+)/;
const ROW_RE = /^-\s*(?<ts>\S+)\s*\|\s*(?<system>[^|]+)\|\s*(?<resource>[^|]+)\|\s*(?<type>[^|]+)\|\s*(?<state>[^|]+)\|\s*(?<subject>.+?)\s*$/;

const RAW_STATE = {
  FOUND: 'PRESENT',
  PRESENT: 'PRESENT',
  HIT: 'PRESENT',
  EXISTS: 'PRESENT',
  '200': 'PRESENT',
  NOT_FOUND: 'ABSENT',
  ABSENT: 'ABSENT',
  MISS: 'ABSENT',
  '404': 'ABSENT',
  DELETED: 'ABSENT',
  GONE: 'ABSENT',
  IDENTIFIABLE: 'IDENTIFIABLE',
  EXPOSED: 'IDENTIFIABLE',
  PARTIAL: 'IDENTIFIABLE',
  REDACTED: 'REDACTED',
  ANONYMIZED: 'ANONYMIZED',
  ANONYMISED: 'ANONYMIZED',
  ACTIVE: 'ACTIVE',
  ENABLED: 'ACTIVE',
  RUNNING: 'ACTIVE',
  RESTORE_ALLOWED: 'ACTIVE',
  DISABLED: 'DISABLED',
  STOPPED: 'DISABLED',
  INACTIVE: 'DISABLED',
  BLOCKED: 'BLOCKED',
  RESTORE_BLOCKED: 'BLOCKED',
  RETAINED: 'RETAINED',
  RETAIN: 'RETAINED',
  SUCCESS: 'PRESENT',
  FAILED: 'FAILED',
};

function stateOf(token) {
  const key = String(token || '').trim().toUpperCase();
  if (RAW_STATE[key]) return RAW_STATE[key];
  if (key === 'ANONYMISED') return 'ANONYMIZED';
  return key || 'PRESENT';
}

function parse(evidence) {
  const lines = fs.readFileSync(evidence.absolute_path, 'utf8').split(/\r?\n/);
  let snapshot = evidence.captured_at;
  for (const line of lines) {
    const match = SNAPSHOT_RE.exec(line);
    if (match) {
      snapshot = match[1];
      break;
    }
  }
  const records = [];
  for (const line of lines) {
    const match = ROW_RE.exec(line.trim());
    if (!match) continue;
    const system = match.groups.system.trim();
    const resourceId = match.groups.resource.trim();
    const recordType = guessRecordType(system, null, match.groups.type.trim());
    const subject = match.groups.subject.trim();
    const identifiers = {};
    if (subject && subject.toLowerCase() !== 'no direct identifier') {
      if (/^user_\d+$/.test(subject)) identifiers.subject_reference = subject;
      else if (subject.includes('@')) identifiers.email = subject;
      else identifiers.phone = subject;
    }
    records.push(makeRecord({
      evidenceId: evidence.file_id,
      capturedAt: evidence.captured_at,
      observedAt: match.groups.ts.trim(),
      system: system || guessSystem(resourceId),
      resourceId,
      recordType,
      state: stateOf(match.groups.state),
      identifiers,
      linkKeys: subject && subject.toLowerCase() !== 'no direct identifier' ? [subject] : [],
      payload: { raw_subject: subject, _format: 'handover' },
      parser: 'text_report',
      sourcePath: evidence.file_path,
    }));
  }
  return { records, detail: `snapshot=${snapshot} rows=${records.length}` };
}

export { parse, stateOf };
