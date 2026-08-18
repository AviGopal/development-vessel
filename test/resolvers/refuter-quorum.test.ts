import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * A QUORUM OF ONE IS NOT A QUORUM.
 *
 * The semantic gate's refuter block calls itself an "adversarial-verify quorum" and let a
 * SINGLE refuter overturn a judge that had already passed the patch. Its only guard on
 * "specific" was `reason.trim().length >= 20` — string length standing in for specificity,
 * which it does not measure.
 *
 * MEASURED 2026-08-18, twice on the same file, in opposite directions:
 *
 *   vague spec  -> drafter edited the WRONG regex (field-name list, not the counting-trigger
 *                  alternation). Refuter caught it at conf 1.00, citing the exact confusion.
 *                  CORRECT rejection.
 *   precise spec -> drafter produced the RIGHT one-line change. Refuter rejected it anyway at
 *                  conf 0.90: "only adds 'quantity of' to the regex in line 54, but it does not
 *                  address the underlying logic of the regex match within the context of the
 *                  gap" — 110 characters of generality clearing a 20-character bar.
 *                  FALSE rejection; a correct minimal patch was rolled back.
 *
 * ★ A FALSE REJECTION IS THE FAILURE MODE THAT MAKES THE SUBSTRATE UNTEACHABLE BY GOAL. The
 *   operator writes a precise instruction, the drafter follows it exactly, and the gate throws
 *   the result away. Requiring two INDEPENDENT refutations means one bad draw cannot sink a
 *   clean patch, while a genuine false-pass (inert rename, stub, dead code) refutes
 *   consistently and is still caught.
 */

const SRC = new URL('../../src/resolvers/feature-compose.ts', import.meta.url).pathname;
const source = () => readFileSync(SRC, 'utf8');

const block = (): string => {
  const s = source();
  const i = s.indexOf('A QUORUM OF ONE IS NOT A QUORUM');
  expect(i).toBeGreaterThan(-1);
  return s.slice(i, i + 4000);
};

describe('semantic gate — adversarial refuter quorum', () => {
  it('guards the instrument: the refuter block is findable', () => {
    expect(source()).toContain('refutationPrompt');
    expect(block()).toContain('addresses = false');
  });

  it('THE REGRESSION: two independent refutations are required to overturn a pass', () => {
    const b = block();
    expect(b).toMatch(/const first = await refute\(\);/);
    expect(b).toMatch(/const second = await refute\(\);/);
    // The flip must sit INSIDE the second refutation's branch.
    const iSecond = b.indexOf('const second = await refute();');
    const iFlip = b.indexOf('addresses = false');
    expect(iFlip).toBeGreaterThan(iSecond);
  });

  it('a SPLIT keeps the first judge\'s pass, and says so', () => {
    const b = block();
    expect(b).toContain('refuter SPLIT 1/2');
    expect(b).toMatch(/keeping the first judge's PASS/);
  });

  it('the per-refutation bar is retained — this adds a vote, it does not lower the bar', () => {
    const b = block();
    expect(b).toMatch(/rp\.confidence < 0\.8/);
    expect(b).toMatch(/rp\.reason\.trim\(\)\.length < 20/);
    expect(b).toMatch(/rp\.refuted !== true/);
  });

  it('the second call is only paid on the rare branch', () => {
    // Judge passed AND first refuter refuted. If `second` were hoisted out of that branch,
    // every clean compose would pay two extra LLM calls.
    const b = block();
    const iFirstIf = b.indexOf('if (first) {');
    const iSecond = b.indexOf('const second = await refute();');
    expect(iFirstIf).toBeGreaterThan(-1);
    expect(iSecond).toBeGreaterThan(iFirstIf);
  });

  it('FAIL-OPEN IS PRESERVED: a refuter outage must not wedge landing', () => {
    const b = block();
    expect(b).toMatch(/catch \{ \/\* refuter unavailable/);
  });

  it('NEGATIVE CONTROL: the single-vote shape would fail these assertions', () => {
    const preFix = `
      const rp = rm ? parseJsonObject(rm[0]) : null;
      if (rp && rp.refuted === true && rp.confidence >= 0.8 && rp.reason.trim().length >= 20) {
        addresses = false;
      }`;
    expect(/const second = await refute\(\);/.test(preFix)).toBe(false);
    expect(preFix.includes('refuter SPLIT 1/2')).toBe(false);
  });
});
