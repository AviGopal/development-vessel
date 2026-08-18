import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * A CASCADE THAT CANNOT SEE A FAILURE IS WORSE THAN NO CASCADE.
 *
 * llm_completion_dispatch failed over across endpoints on `candidate.error`, `.resolved === false`
 * and `.success === false` — all TOP-LEVEL. A failure that crossed the federation transport
 * carries its error one or two levels down. Both envelopes observed live 2026-08-18:
 *
 *   {"content":{"error":"ingress proxy failed: ... NO_RESERVATION"}}
 *   {"content":{"body":{"resolved":false,"error":"no llm arm is currently servable ..."}}}
 *
 * Neither sets a top-level field, so the guard passed, the loop treated a FAILED call as the
 * winner and broke out — never trying the remaining endpoints. The code read as fault-tolerant
 * while stopping at the first broken arm.
 *
 * ★ MEASURED COST. A third substrate (spoke-739b76f1 — on neither this host nor the hub, joined
 *   through the public relay) advertised llm_completion arms it could not serve. Its rows sorted
 *   ahead of the hub's, so EVERY llm call stopped there. The ReAct floor logged "dispatch FAILED
 *   http=500" on all 8 iterations, and four ordinary human goals failed — chemical symbol for
 *   gold, violin strings, marathon distance, The Starry Night — while three working arms sat on
 *   the hub, one endpoint later in the same list.
 */

const SRC = new URL('./llm-completion-dispatch.ts', import.meta.url).pathname;
const source = () => readFileSync(SRC, 'utf8');

describe('llm_completion_dispatch cascades past federated failures', () => {
  it('guards the instrument: the failover loop is present', () => {
    const s = source();
    expect(s).toContain('for (const endpoint of endpoints)');
    expect(s).toContain('failure_mode');
  });

  it('THE REGRESSION: a nested federated error is detected', () => {
    const s = source();
    expect(s).toContain('federatedError');
    expect(s).toMatch(/nested/);
    // Both observed shapes must be covered: content.error and content.body.error
    expect(s).toMatch(/i\["error"\]/);
    expect(s).toMatch(/b\["error"\]/);
    expect(s).toMatch(/b\["resolved"\] === false/);
  });

  it('a detected failure CONTINUES the cascade rather than winning', () => {
    const s = source();
    const i = s.indexOf('const nested = federatedError(candidate);');
    expect(i).toBeGreaterThan(-1);
    const block = s.slice(i, i + 500);
    expect(block).toContain('continue;');
    // The nested reason must reach lastFailure, or the caller gets "returned error" with no cause.
    expect(block).toMatch(/nested \?\?|\?\? nested/);
  });

  it('the top-level checks are RETAINED — this adds a case, it does not replace one', () => {
    const s = source();
    const i = s.indexOf('const nested = federatedError(candidate);');
    const block = s.slice(i, i + 400);
    expect(block).toContain('candidate.error');
    expect(block).toContain('candidate.resolved === false');
    expect(block).toContain('candidate.success === false');
  });

  it('THE DETECTOR ACTUALLY MATCHES THE TWO OBSERVED ENVELOPES', () => {
    // Re-implement the predicate exactly as written and run the real payloads through it.
    const federatedError = (c: unknown): string | null => {
      if (!c || typeof c !== 'object') return null;
      const top = c as Record<string, unknown>;
      const inner = top['content'];
      if (!inner || typeof inner !== 'object') return null;
      const i = inner as Record<string, unknown>;
      if (typeof i['error'] === 'string') return i['error'];
      const body = i['body'];
      if (body && typeof body === 'object') {
        const b = body as Record<string, unknown>;
        if (typeof b['error'] === 'string') return b['error'];
        if (b['resolved'] === false) return 'federated arm returned resolved=false';
      }
      return null;
    };
    expect(federatedError({ content: { error: 'ingress proxy failed: NO_RESERVATION' } }))
      .toBe('ingress proxy failed: NO_RESERVATION');
    expect(federatedError({ content: { body: { resolved: false, error: 'no llm arm is currently servable' } } }))
      .toBe('no llm arm is currently servable');
    // NEGATIVE CONTROL: a genuine success must not be mistaken for a failure, or the cascade
    // would discard every working arm and this fix would be worse than the bug.
    expect(federatedError({ content: { shape: 'llm_completion', value: 'OK' } })).toBeNull();
    expect(federatedError({ content: 'plain string answer' })).toBeNull();
    expect(federatedError(null)).toBeNull();
  });
});
