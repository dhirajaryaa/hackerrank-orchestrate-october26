import { PHASE_ORDER, OPERATION_ORDER, OPERATION_STATE, STATE_PLAN } from './config.js';

function planFor(category, state) {
  const table = STATE_PLAN[category];
  if (!table) return [null, null, null];
  return table[state] || [null, null, null];
}

function isCompliant(category, state) {
  if (category === 'SECURITY_AUDIT_LOG' || category === 'LEGAL_HOLD_RECORD') {
    return ['PRESENT', 'RETAINED'].includes(state);
  }
  return ['ABSENT', 'REDACTED', 'ANONYMIZED', 'DISABLED', 'BLOCKED', 'RETAINED'].includes(state);
}

function stateForOperation(operation) {
  return OPERATION_STATE[operation] || 'PRESENT';
}

function buildSteps(resources, status) {
  if (status === 'NOT_APPLICABLE') return [];
  const planned = [];
  for (const resource of resources) {
    const category = resource.category || 'UNKNOWN';
    const state = resource.state || 'PRESENT';
    let [finding, remediation, verification] = planFor(category, state);
    if (!verification) continue;

    const base = { system_id: resource.system, resource_id: resource.resource_id };
    const findingState = finding === 'REPORT_ACTIVE_DATA_FLOW' || finding === 'REPORT_RESTORE_RISK'
      ? 'ACTIVE'
      : 'PRESENT';
    const findingEvidence = status === 'COMPLETE' ? '' : (resource.evidence_id || '');
    if (finding) {
      planned.push({
        ...base,
        phase: 'FINDING',
        operation: finding,
        state: findingState,
        evidence_id: findingEvidence,
      });
    }
    if (remediation) {
      planned.push({
        ...base,
        phase: 'REMEDIATION',
        operation: remediation,
        state: stateForOperation(remediation),
        evidence_id: '',
      });
    }
    const verificationEvidence = status === 'COMPLETE' && resource.evidence_kind === 'manifest'
      ? (resource.evidence_id || '')
      : '';
    planned.push({
      ...base,
      phase: 'VERIFICATION',
      operation: verification,
      state: stateForOperation(verification),
      evidence_id: verificationEvidence,
    });
  }

  planned.sort((a, b) => (
    (PHASE_ORDER[a.phase] ?? 9) - (PHASE_ORDER[b.phase] ?? 9)
    || (OPERATION_ORDER[a.operation] ?? 99) - (OPERATION_ORDER[b.operation] ?? 99)
    || a.system_id.localeCompare(b.system_id)
    || a.resource_id.localeCompare(b.resource_id)
  ));
  return planned.map((step, index) => ({
    step_no: index + 1,
    phase: step.phase,
    system_id: step.system_id,
    resource_id: step.resource_id,
    operation: step.operation,
    state: step.state,
    evidence_id: step.evidence_id,
  }));
}

function buildPlanView(resource) {
  return {
    system: resource.system,
    resource_id: resource.resource_id,
    category: resource.category,
    state: resource.state,
    evidence_id: resource.evidence_kind === 'manifest' ? (resource.evidence_id || '') : '',
  };
}

export { buildSteps, isCompliant, planFor, buildPlanView };
