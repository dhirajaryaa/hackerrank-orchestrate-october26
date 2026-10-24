import { describe, expect, it } from 'vitest';
import { buildSteps, isCompliant, planFor } from '../code/lib/planner.js';

const resource = (overrides = {}) => ({
  system: 'account_service',
  resource_id: 'account_001',
  category: 'USER_PROFILE',
  state: 'PRESENT',
  evidence_id: 'evidence_01',
  evidence_kind: 'manifest',
  ...overrides,
});

describe('deletion rules and planning', () => {
  it('maps a present profile to delete remediation', () => {
    expect(planFor('USER_PROFILE', 'PRESENT')).toEqual([
      'REPORT_REMAINING_RECORD',
      'DELETE_RECORD',
      'VERIFY_RECORD_ABSENT',
    ]);
  });

  it('maps an account tombstone to redaction, not deletion', () => {
    expect(planFor('ACCOUNT_TOMBSTONE', 'PRESENT')).toEqual([
      'REPORT_EXPOSED_PII',
      'REDACT_RECORD',
      'VERIFY_RECORD_REDACTED',
    ]);
  });

  it('treats retained security records as compliant only when present', () => {
    expect(isCompliant('SECURITY_AUDIT_LOG', 'PRESENT')).toBe(true);
    expect(isCompliant('SECURITY_AUDIT_LOG', 'ABSENT')).toBe(false);
    expect(isCompliant('USER_PROFILE', 'ABSENT')).toBe(true);
  });

  it('orders findings, remediation, and verification deterministically', () => {
    const steps = buildSteps([
      resource(),
      resource({
        system: 'analytics_platform',
        resource_id: 'analytics_001',
        category: 'ANALYTICS_PROFILE',
        evidence_kind: 'manifest',
      }),
    ], 'INCOMPLETE');

    expect(steps.map((step) => step.phase)).toEqual([
      'FINDING',
      'FINDING',
      'REMEDIATION',
      'REMEDIATION',
      'VERIFICATION',
      'VERIFICATION',
    ]);
    expect(steps.map((step) => step.step_no)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(steps.filter((step) => step.phase === 'FINDING').map((step) => step.resource_id))
      .toEqual(['account_001', 'analytics_001']);
    expect(steps.filter((step) => step.phase === 'REMEDIATION').every((step) => step.evidence_id === ''))
      .toBe(true);
    expect(steps.filter((step) => step.phase === 'VERIFICATION').every((step) => step.evidence_id === ''))
      .toBe(true);
  });

  it('cites evidence only for evidence-backed complete verification', () => {
    const steps = buildSteps([
      resource({ state: 'ABSENT', category: 'USER_PROFILE' }),
      resource({
        system: 'analytics_platform',
        resource_id: 'analytics_001',
        category: 'ANALYTICS_PROFILE',
        state: 'ANONYMIZED',
        evidence_kind: 'activity',
      }),
    ], 'COMPLETE');

    expect(steps).toHaveLength(1);
    expect(steps[0].operation).toBe('VERIFY_RECORD_ABSENT');
    expect(steps[0].evidence_id).toBe('evidence_01');
  });
});
