import { describe, expect, it } from 'vitest';
import { decideCase } from '../code/lib/engine.js';
import { classifyIntent } from '../code/lib/request_intent.js';

// Participant-created evaluation cases. These are synthetic, hand-written
// scenarios that are not part of dataset/sample_* and cover behaviours the
// public samples do not exercise together: non-deletion intents, explicit
// negation, tombstone redaction with an active sync flow, and a fully
// compliant case that must end in evidence-backed verification only.

const ctx = (overrides = {}) => ({
  case_id: 'custom_01',
  request_text: 'Please permanently delete my account and all personal data.',
  resources: [],
  ...overrides,
});

const res = (overrides = {}) => ({
  system: 'account_service',
  resource_id: 'account_9001',
  category: 'USER_PROFILE',
  state: 'PRESENT',
  evidence_id: 'evidence_900',
  evidence_kind: 'manifest',
  ...overrides,
});

describe('custom evaluation cases', () => {
  it('custom_01 access request is NOT_APPLICABLE even when data remains', () => {
    const decision = decideCase(ctx({
      case_id: 'custom_01',
      request_text: 'Please send me a copy of my personal information that you hold.',
      resources: [res()],
    }));
    expect(decision.deletion_status).toBe('NOT_APPLICABLE');
    expect(decision.steps).toEqual([]);
  });

  it('custom_02 explicit negation of deletion is NOT_APPLICABLE', () => {
    const intent = classifyIntent('Please do not delete my account, I still need it.');
    expect(intent.is_deletion).toBe(false);
    const decision = decideCase(ctx({
      case_id: 'custom_02',
      request_text: 'Please do not delete my account, I still need it.',
      resources: [res()],
    }));
    expect(decision.deletion_status).toBe('NOT_APPLICABLE');
    expect(decision.steps).toEqual([]);
  });

  it('custom_03 tombstone redaction plus active sync is INCOMPLETE and ordered', () => {
    const decision = decideCase(ctx({
      case_id: 'custom_03',
      resources: [
        res({ system: 'identity_service', resource_id: 'tombstone_9001', category: 'ACCOUNT_TOMBSTONE', state: 'IDENTIFIABLE' }),
        res({ system: 'security_service', resource_id: 'audit_record_9001', category: 'SECURITY_AUDIT_LOG', state: 'PRESENT' }),
        res({ system: 'integration_service', resource_id: 'data_flow_9001', category: 'DATA_FLOW', state: 'ACTIVE' }),
      ],
    }));
    expect(decision.deletion_status).toBe('INCOMPLETE');
    const ops = decision.steps.map((step) => step.operation);
    // Flow must be disabled before dependent records are touched.
    expect(ops.indexOf('DISABLE_DATA_FLOW')).toBeLessThan(ops.indexOf('REDACT_RECORD'));
    expect(ops).toContain('REPORT_EXPOSED_PII');
    expect(ops).toContain('REPORT_ACTIVE_DATA_FLOW');
    expect(ops).toContain('VERIFY_RECORD_REDACTED');
    expect(ops).toContain('VERIFY_DATA_FLOW_DISABLED');
    expect(ops).not.toContain('REPORT_REMAINING_RECORD');
    expect(decision.steps.map((step) => step.step_no))
      .toEqual(decision.steps.map((_, index) => index + 1));
  });

  it('custom_04 compliant case returns verification-only steps with evidence', () => {
    const decision = decideCase(ctx({
      case_id: 'custom_04',
      resources: [
        res({ state: 'ABSENT' }),
        res({ system: 'security_service', resource_id: 'audit_record_9002', category: 'SECURITY_AUDIT_LOG', state: 'PRESENT' }),
        res({ system: 'identity_service', resource_id: 'tombstone_9002', category: 'ACCOUNT_TOMBSTONE', state: 'REDACTED' }),
        res({ system: 'integration_service', resource_id: 'data_flow_9002', category: 'DATA_FLOW', state: 'DISABLED' }),
        res({ system: 'backup_service', resource_id: 'backup_9002', category: 'BACKUP_ARCHIVE', state: 'BLOCKED' }),
      ],
    }));
    expect(decision.deletion_status).toBe('COMPLETE');
    expect(decision.steps.length).toBe(5);
    expect(decision.steps.every((step) => step.phase === 'VERIFICATION')).toBe(true);
    expect(decision.steps.every((step) => step.evidence_id === 'evidence_900')).toBe(true);
  });
});
