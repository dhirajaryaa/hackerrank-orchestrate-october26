import { buildSteps, planFor } from './planner.js';
import { classifyIntent } from './request_intent.js';

function findingsFor(resources) {
  const findings = [];
  for (const resource of resources) {
    const [finding] = planFor(resource.category, resource.state);
    if (finding) findings.push(resource);
  }
  return findings;
}

function decideCase(context, intentOverride = null) {
  const intent = intentOverride || classifyIntent(context.request_text);
  if (!intent.is_deletion) {
    return {
      case_id: context.case_id,
      deletion_status: 'NOT_APPLICABLE',
      steps: [],
      intent,
      resources: context.resources || [],
    };
  }

  const findings = findingsFor(context.resources || []);
  const deletionStatus = findings.length ? 'INCOMPLETE' : 'COMPLETE';
  const steps = buildSteps(context.resources || [], deletionStatus);
  return {
    case_id: context.case_id,
    deletion_status: deletionStatus,
    steps,
    intent,
    resources: context.resources || [],
  };
}

function serializeDecision(decision) {
  return {
    case_id: decision.case_id,
    deletion_status: decision.deletion_status,
    steps_json: JSON.stringify(decision.steps),
  };
}

export { decideCase, serializeDecision, findingsFor };
