import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { federatedLlmEgressUrls } from './federated-llm-egress';

/**
 * The hub fallback looped back to the local arm it existed to escape. See the module header for
 * the measurement. These tests pin the two properties that make it actually leave the substrate:
 * a target is always present, and only FEDERATED rows are used.
 */

const EGRESS = 'http://127.0.0.1:8401';
const MA = '/ip4/138.197.116.56/tcp/30333/p2p/12D3KooWJ9Jdv/p2p-circuit/p2p/12D3KooWJM1By';

function withFetch<T>(payload: unknown, fn: () => Promise<T>, capture?: (u: string) => void): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (u: string) => {
    capture?.(String(u));
    return { ok: true, json: async () => payload } as unknown as Response;
  }) as unknown as typeof fetch;
  return fn().finally(() => { globalThis.fetch = orig; });
}

describe('federatedLlmEgressUrls', () => {
  it('THE REGRESSION: every URL carries a target — by-name alone resolves to self', async () => {
    const urls = await withFetch(
      { content: { vessels: [{ vesselId: 'llm-resolver-google@syzygy-hub', endpoint: EGRESS, libp2p_multiaddr: [MA], health_score: 9 }] } },
      () => federatedLlmEgressUrls('http://d', 'k', EGRESS),
    );
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('target=');
    expect(urls[0]).toContain(encodeURIComponent(MA));
    // ...and the OWNING substrate's own name for the arm, not a hardcoded literal.
    expect(urls[0]).toContain('vessel=llm-resolver-google');
    expect(urls[0]).not.toContain('llm-resolver-vessel');
  });

  it('LOCAL rows are excluded — routing one through the egress is what caused the loop-back', async () => {
    const urls = await withFetch(
      { content: { vessels: [
        { vesselId: 'llm-resolver-vessel@spoke-739b76f1', endpoint: 'http://127.0.0.1:8225' }, // no multiaddr => local
      ] } },
      () => federatedLlmEgressUrls('http://d', 'k', EGRESS),
    );
    expect(urls).toEqual([]);
  });

  it('federated rows are ordered by health, best first', async () => {
    const urls = await withFetch(
      { content: { vessels: [
        { vesselId: 'low@hub', endpoint: EGRESS, libp2p_multiaddr: [MA], health_score: 1 },
        { vesselId: 'high@hub', endpoint: EGRESS, libp2p_multiaddr: [MA], health_score: 9 },
      ] } },
      () => federatedLlmEgressUrls('http://d', 'k', EGRESS),
    );
    expect(urls[0]).toContain('vessel=high');
    expect(urls[1]).toContain('vessel=low');
  });

  it('asks discovery for the capability, not for a vessel by name', async () => {
    let seen = '';
    await withFetch(
      { content: { vessels: [] } },
      () => federatedLlmEgressUrls('http://d', 'k', EGRESS),
      (u) => { seen = u; },
    );
    expect(seen).toContain('/resolve');
  });

  it('an unreachable discovery yields no URLs rather than a guessed one', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    try {
      expect(await federatedLlmEgressUrls('http://d', 'k', EGRESS)).toEqual([]);
    } finally { globalThis.fetch = orig; }
  });

  it('NEGATIVE CONTROL: the old hardcoded form would fail these assertions', () => {
    const oldForm = `${EGRESS}/egress/resolve?vessel=llm-resolver-vessel`;
    expect(oldForm.includes('target=')).toBe(false);
    expect(oldForm).toContain('llm-resolver-vessel');
  });
});

describe('the call sites no longer hardcode a peer name', () => {
  for (const f of ['feature-compose.ts', 'patch-with-tools.ts', 'llm-completion-dispatch.ts']) {
    it(`${f} pushes discovered federated arms`, () => {
      const s = readFileSync(new URL(`./${f}`, import.meta.url).pathname, 'utf8');
      expect(s).toContain('federatedLlmEgressUrls');
      // The bare literal must be gone from every call site — it was three siblings with the
      // same defect, and fixing one would have left the other two looping back.
      expect(s).not.toContain('egress/resolve?vessel=llm-resolver-vessel');
    });
  }
});
