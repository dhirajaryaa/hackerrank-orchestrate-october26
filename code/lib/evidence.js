import path from 'node:path';
import { loadManifest } from './tables.js';
import { ObservationStore } from './model.js';
import { parse as parseJson } from './parsers/json.js';
import { parse as parseLog } from './parsers/log.js';
import { parse as parseSql } from './parsers/sql.js';
import { parse as parseText } from './parsers/text.js';
import { parse as parsePdf } from './parsers/pdf.js';
import { parse as parseImage } from './parsers/image.js';
import { buildActivityRecords } from './activity.js';
import { loadActivity } from './tables.js';

const PARSERS = {
  '.json': parseJson,
  '.log': parseLog,
  '.sql': parseSql,
  '.txt': parseText,
  '.pdf': parsePdf,
  '.png': parseImage,
  '.jpg': parseImage,
  '.jpeg': parseImage,
};

async function parseEvidenceFile(evidence) {
  const parser = PARSERS[evidence.suffix];
  if (!parser) return { records: [], detail: `no-parser suffix=${evidence.suffix}` };
  try {
    return await parser(evidence);
  } catch (error) {
    return { records: [], detail: `error=${error.message.slice(0, 200)}` };
  }
}

async function buildEvidenceStore({ includeManifest = true } = {}) {
  const store = new ObservationStore();
  const manifest = loadManifest();

  if (includeManifest) {
    for (const evidence of manifest) {
      const result = await parseEvidenceFile(evidence);
      for (const record of result.records) {
        record.evidenceOrigin = evidence.origin;
        record.evidenceCapturedAt = evidence.captured_at;
        store.add(record);
      }
      store.logFile(
        evidence.file_id,
        evidence.file_path,
        path.basename(evidence.absolute_path),
        result.records.length,
        result.detail.startsWith('error=') ? 'error' : 'ok',
        result.detail,
      );
    }
  }

  const activity = loadActivity();
  const activityRecords = buildActivityRecords(activity);
  store.extend(activityRecords);
  store.logFile('system_activity.csv', 'dataset/system_activity.csv', 'activity', activityRecords.length, 'ok', `events=${activity.length}`);

  return { store, manifest, activity };
}

export { buildEvidenceStore, parseEvidenceFile };
