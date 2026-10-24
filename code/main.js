import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { buildEvidenceStore } from './lib/evidence.js';
import { createIdentityResolver } from './lib/identity.js';
import { Linker } from './lib/linker.js';
import { inferResources } from './lib/inference.js';
import { buildCaseContexts } from './lib/context.js';
import { decideCase, serializeDecision } from './lib/engine.js';
import { loadRequests, loadSampleOutput } from './lib/tables.js';
import { ROOT_DIR, BUILD_DIR, PHASE_ORDER, OPERATION_STATE, STATE_PLAN } from './lib/config.js';
import { readCsv, writeCsv, parseTs } from './lib/util.js';

dotenv.config({ path: path.join(ROOT_DIR, 'code', '.env') });
dotenv.config({ path: path.join(ROOT_DIR, '.env') });

const OUTPUT_PATH = path.join(ROOT_DIR, 'output.csv');
const OUT_COLUMNS = ['case_id', 'deletion_status', 'steps_json'];
const ALLOWED_STATUS = new Set(['COMPLETE', 'INCOMPLETE', 'NOT_APPLICABLE']);
const ALLOWED_PHASES = new Set(['FINDING', 'REMEDIATION', 'VERIFICATION']);
const ALLOWED_OPS = new Set(Object.keys(OPERATION_STATE));
const STEP_FIELDS = ['step_no', 'phase', 'system_id', 'resource_id', 'operation', 'state', 'evidence_id'];

async function runPipeline({ sample = false, caseId = '' } = {}) {
  const { store } = await buildEvidenceStore();
  const resolver = createIdentityResolver();
  const linker = new Linker(resolver, store);
  linker.run();

  const source = sample ? loadRequests(true) : loadRequests(false);
  const requests = caseId ? source.filter((row) => row.case_id === caseId) : source;
  if (caseId && !requests.length) throw new Error(`Unknown case: ${caseId}`);
  const caseUsers = new Map(requests.map((request) => [request.case_id, resolver.resolveCase(request).userId]));
  const inference = inferResources(store, caseUsers, requests);
  const contexts = buildCaseContexts({
    store,
    resourceUsers: inference.resourceUsers,
    requests,
    resolver,
  });
  const decisions = contexts.map(decideCase);
  return { store, resolver, linker, inference, contexts, decisions };
}

function summaryOf(decisions) {
  const counts = { COMPLETE: 0, INCOMPLETE: 0, NOT_APPLICABLE: 0 };
  for (const decision of decisions) counts[decision.deletion_status] += 1;
  return counts;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseSteps(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function compareSteps(actual, expected) {
  const max = Math.max(actual.length, expected.length);
  const fields = ['phase', 'system_id', 'resource_id', 'operation', 'state', 'evidence_id'];
  const fieldCorrect = Object.fromEntries(fields.map((field) => [field, 0]));
  let positionCorrect = 0;
  for (let index = 0; index < max; index += 1) {
    const a = actual[index];
    const b = expected[index];
    if (!a || !b) continue;
    if (fields.every((field) => a[field] === b[field])) positionCorrect += 1;
    for (const field of fields) if (a[field] === b[field]) fieldCorrect[field] += 1;
  }
  const sequence = actual.length === expected.length
    && actual.every((step, index) => (
      step.phase === expected[index].phase
      && step.system_id === expected[index].system_id
      && step.resource_id === expected[index].resource_id
      && step.operation === expected[index].operation
    ));
  const exact = canonical(actual) === canonical(expected);
  return { exact, sequence, positionCorrect, fieldCorrect, denominator: max };
}

function scoreSample() {
  return runPipeline({ sample: true }).then(({ decisions }) => {
    const golden = loadSampleOutput();
    const rows = [];
    let statusCorrect = 0;
    let exact = 0;
    let sequenceCorrect = 0;
    let positionCorrect = 0;
    let positionTotal = 0;
    const fieldCorrect = { phase: 0, system_id: 0, resource_id: 0, operation: 0, state: 0, evidence_id: 0 };
    const failures = [];

    for (const decision of decisions) {
      const expectedRow = golden.get(decision.case_id);
      if (!expectedRow) continue;
      const expectedStatus = expectedRow.deletion_status;
      const expectedSteps = parseSteps(expectedRow.steps_json);
      const actualSteps = decision.steps;
      if (decision.deletion_status === expectedStatus) statusCorrect += 1;
      const cmp = compareSteps(actualSteps, expectedSteps);
      if (cmp.exact) exact += 1;
      if (cmp.sequence) sequenceCorrect += 1;
      positionCorrect += cmp.positionCorrect;
      positionTotal += cmp.denominator;
      for (const key of Object.keys(fieldCorrect)) fieldCorrect[key] += cmp.fieldCorrect[key];
      if (!cmp.exact) {
        failures.push({
          case_id: decision.case_id,
          status: decision.deletion_status,
          expected_status: expectedStatus,
          actual_count: actualSteps.length,
          expected_count: expectedSteps.length,
          actual: actualSteps,
          expected: expectedSteps,
        });
      }
      rows.push({ case_id: decision.case_id, status: decision.deletion_status, expected_status: expectedStatus, cmp });
    }

    const count = decisions.length;
    const report = {
      cases: count,
      status_accuracy: count ? statusCorrect / count : 0,
      status_correct: statusCorrect,
      exact_case_accuracy: count ? exact / count : 0,
      exact_cases: exact,
      sequence_accuracy: count ? sequenceCorrect / count : 0,
      sequence_cases: sequenceCorrect,
      step_position_accuracy: positionTotal ? positionCorrect / positionTotal : 0,
      step_positions_correct: positionCorrect,
      step_positions_total: positionTotal,
      field_accuracy: Object.fromEntries(Object.entries(fieldCorrect).map(([key, value]) => [key, positionTotal ? value / positionTotal : 0])),
      field_correct: fieldCorrect,
      failures,
      rows,
    };
    writeJson(path.join(BUILD_DIR, 'sample-score.json'), report);
    return report;
  });
}

function predict() {
  return runPipeline({ sample: false }).then(({ decisions, inference, contexts }) => {
    const rows = decisions
      .slice()
      .sort((a, b) => a.case_id.localeCompare(b.case_id))
      .map(serializeDecision);
    writeCsv(OUTPUT_PATH, rows, OUT_COLUMNS);
    writeJson(path.join(BUILD_DIR, 'predictions.json'), decisions.map((decision) => ({
      case_id: decision.case_id,
      deletion_status: decision.deletion_status,
      intent: decision.intent,
      resources: decision.resources,
      steps: decision.steps,
    })));
    writeJson(path.join(BUILD_DIR, 'assignments.json'), inference.assignments);
    writeJson(path.join(BUILD_DIR, 'case-contexts.json'), contexts);
    console.log(`Wrote ${rows.length} rows to ${OUTPUT_PATH}`);
    console.log('Status counts:', summaryOf(decisions));
    return { rows, decisions };
  });
}

function build() {
  return runPipeline({ sample: false }).then(({ store, contexts, decisions, inference }) => {
    const stats = store.stats();
    writeJson(path.join(BUILD_DIR, 'store-summary.json'), {
      stats,
      parse_log: store.parseLog,
      assignments: inference.assignments.length,
    });
    writeJson(path.join(BUILD_DIR, 'contexts.json'), contexts);
    writeJson(path.join(BUILD_DIR, 'decisions.json'), decisions);
    console.log(JSON.stringify({ stats, assignments: inference.assignments.length, status: summaryOf(decisions) }, null, 2));
    return { store, stats };
  });
}

function validateOutput() {
  const errors = [];
  const rows = readCsv(OUTPUT_PATH);
  const expected = loadRequests(false);
  if (rows.length !== expected.length) errors.push(`row count ${rows.length} != ${expected.length}`);
  if (rows.length && Object.keys(rows[0]).join(',') !== OUT_COLUMNS.join(',')) {
    errors.push(`columns ${Object.keys(rows[0]).join(',')} != ${OUT_COLUMNS.join(',')}`);
  }
  const expectedIds = expected.map((row) => row.case_id);
  const seen = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const caseId = row.case_id;
    if (seen.has(caseId)) errors.push(`duplicate case ${caseId}`);
    seen.add(caseId);
    if (expectedIds[index] !== caseId) errors.push(`row ${index + 1} case ${caseId} != ${expectedIds[index]}`);
    if (!ALLOWED_STATUS.has(row.deletion_status)) errors.push(`${caseId}: bad status ${row.deletion_status}`);
    let steps;
    try {
      steps = JSON.parse(row.steps_json);
    } catch {
      errors.push(`${caseId}: steps_json is not valid JSON`);
      continue;
    }
    if (!Array.isArray(steps)) {
      errors.push(`${caseId}: steps_json is not an array`);
      continue;
    }
    if (row.deletion_status === 'NOT_APPLICABLE' && (steps.length !== 0 || row.steps_json !== '[]')) {
      errors.push(`${caseId}: NOT_APPLICABLE must have []`);
    }
    let phase = -1;
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      const step = steps[stepIndex];
      const keys = Object.keys(step).sort().join(',');
      if (keys !== STEP_FIELDS.slice().sort().join(',')) errors.push(`${caseId} step ${stepIndex + 1}: bad fields ${keys}`);
      if (step.step_no !== stepIndex + 1) errors.push(`${caseId} step ${stepIndex + 1}: step_no ${step.step_no}`);
      if (!ALLOWED_PHASES.has(step.phase)) errors.push(`${caseId} step ${stepIndex + 1}: bad phase ${step.phase}`);
      if (!ALLOWED_OPS.has(step.operation)) errors.push(`${caseId} step ${stepIndex + 1}: bad operation ${step.operation}`);
      if (OPERATION_STATE[step.operation] !== step.state) errors.push(`${caseId} step ${stepIndex + 1}: bad state ${step.state} for ${step.operation}`);
      if (!step.system_id || !step.resource_id) errors.push(`${caseId} step ${stepIndex + 1}: missing system/resource`);
      if (step.phase === 'FINDING' && step.evidence_id === '') errors.push(`${caseId} step ${stepIndex + 1}: finding needs evidence`);
      if (step.phase !== 'FINDING' && step.evidence_id !== '') errors.push(`${caseId} step ${stepIndex + 1}: non-finding must have empty evidence`);
      const order = PHASE_ORDER[step.phase];
      if (order < phase) errors.push(`${caseId} step ${stepIndex + 1}: phase order`);
      phase = Math.max(phase, order);
    }
  }
  if (errors.length) {
    console.error(`Validation failed with ${errors.length} issue(s):`);
    for (const error of errors.slice(0, 100)) console.error(`- ${error}`);
    process.exitCode = 1;
    return { ok: false, errors };
  }
  console.log(`Validated ${rows.length} rows (${seen.size} unique cases).`);
  return { ok: true, errors: [] };
}

function printScore(report) {
  console.log(`Cases: ${report.cases}`);
  console.log(`Status accuracy: ${report.status_correct}/${report.cases} (${(report.status_accuracy * 100).toFixed(1)}%)`);
  console.log(`Exact cases: ${report.exact_cases}/${report.cases} (${(report.exact_case_accuracy * 100).toFixed(1)}%)`);
  console.log(`Sequence cases: ${report.sequence_cases}/${report.cases} (${(report.sequence_accuracy * 100).toFixed(1)}%)`);
  console.log(`Step position accuracy: ${report.step_positions_correct}/${report.step_positions_total} (${(report.step_position_accuracy * 100).toFixed(1)}%)`);
  for (const [field, value] of Object.entries(report.field_accuracy)) {
    console.log(`  ${field}: ${(value * 100).toFixed(1)}%`);
  }
  console.log('\nFailures:');
  for (const failure of report.failures) {
    console.log(`- ${failure.case_id}: status ${failure.status} (expected ${failure.expected_status}), steps ${failure.actual_count} (expected ${failure.expected_count})`);
  }
}

async function main() {
  const command = process.argv[2] || 'predict';
  const caseArgIndex = process.argv.indexOf('--case');
  const caseId = caseArgIndex >= 0 ? process.argv[caseArgIndex + 1] : '';
  if (command === 'build') await build();
  else if (command === 'predict') await predict();
  else if (command === 'score') printScore(await scoreSample());
  else if (command === 'validate') validateOutput();
  else if (command === 'debug') {
    const { decisions } = await runPipeline({ sample: !process.argv.includes('--eval'), caseId });
    console.log(JSON.stringify(decisions, null, 2));
  } else {
    console.error(`Unknown command: ${command}`);
    console.error('Usage: node code/main.js <build|predict|score|validate|debug> [--case case_XX] [--eval]');
    process.exitCode = 2;
  }
}

main().then(() => {
  // tesseract.js keeps a worker alive after OCR; exit deterministically.
  process.exit(process.exitCode || 0);
}).catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
