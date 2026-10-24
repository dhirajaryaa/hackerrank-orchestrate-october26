import { describe, expect, it } from 'vitest';
import { classifyIntent } from '../code/lib/request_intent.js';

describe('request intent', () => {
  it('recognizes an English deletion request', () => {
    const result = classifyIntent('Please close my account and erase all personal data.');
    expect(result.is_deletion).toBe(true);
    expect(result.label).toBe('deletion');
  });

  it('recognizes multilingual deletion requests', () => {
    expect(classifyIntent('Por favor elimine mi cuenta y todos mis datos personales.').label).toBe('deletion');
    expect(classifyIntent('이 이메일 주소에 연결된 계정의 영구 삭제를 요청합니다.').label).toBe('deletion');
  });

  it('does not treat an access request as deletion', () => {
    const result = classifyIntent('Please send me a copy of the personal information you hold about me.');
    expect(result.is_deletion).toBe(false);
    expect(result.label).toBe('not_deletion');
    expect(result.non_deletion_action).toBe('access');
  });

  it('honors an explicit refusal of deletion', () => {
    const result = classifyIntent('Do not delete my account. I still need it.');
    expect(result.is_deletion).toBe(false);
    expect(result.label).toBe('not_deletion');
    expect(result.matched_negations.length).toBeGreaterThan(0);
  });

  it('returns unclear for an empty or non-actionable message', () => {
    expect(classifyIntent('').label).toBe('unclear');
    expect(classifyIntent('Hello, I have a question.').label).toBe('unclear');
  });
});
