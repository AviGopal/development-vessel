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

  it('rows on DISTINCT peers are ordered by health, best first', async () => {
    const urls = await withFetch(
      { content: { vessels: [
        { vesselId: 'low@peer-a', endpoint: EGRESS, libp2p_multiaddr: [MA], health_score: 1 },
        { vesselId: 'high@peer-b', endpoint: EGRESS, libp2p_multiaddr: [MA], health_score: 9 },
      ] } },
      () => federatedLlmEgressUrls('http://d', 'k', EGRESS),
    );
    expect(urls[0]).toContain('vessel=high');
    expect(urls[1]).toContain('vessel=low');
  });

  it('MEASURED REGRESSION: a multiaddr does NOT mean remote — our own rows are excluded', async () => {
    // The first version of this filter kept every row with a multiaddr and asserted a local row
    // had none. Against a live spoke registry ALL FIVE rows carried one, four of them ours.
    const prev = process.env['FED_SUBSTRATE_ID'];
    process.env['FED_SUBSTRATE_ID'] = 'spoke-cfda39e7';
    try {
      const urls = await withFetch(
        { content: { vessels: [
          { vesselId: 'llm-resolver-vessel@spoke-cfda39e7', endpoint: EGRESS, libp2p_multiaddr: [MA] },
          { vesselId: 'llm-resolver-google@syzygy-hub', endpoint: EGRESS, libp2p_multiaddr: [MA] },
        ] } },
        () => federatedLlmEgressUrls('http://d', 'k', EGRESS),
      );
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain('vessel=llm-resolver-google');
    } finally {
      if (prev === undefined) delete process.env['FED_SUBSTRATE_ID']; else process.env['FED_SUBSTRATE_ID'] = prev;
    }
  });

  it('ONE CANDIDATE PER PEER — duplicates of one dead arm must not eat a bounded turn budget', async () => {
    // Measured: four rows for @spoke-739b76f1, a PREVIOUS INCARNATION of this spoke whose
    // registrations outlived its container, all resolving to the same dead resolver, ahead of
    // the single live @syzygy-hub row. patch-with-tools gives up after 3 turns, so it exhausted
    // them on duplicates and never reached the arm that works.
    const urls = await withFetch(
      { content: { vessels: [
        { vesselId: 'a@stale-spoke', endpoint: EGRESS, libp2p_multiaddr: [MA] },
        { vesselId: 'b@stale-spoke', endpoint: EGRESS, libp2p_multiaddr: [MA] },
        { vesselId: 'c@stale-spoke', endpoint: EGRESS, libp2p_multiaddr: [MA] },
        { vesselId: 'd@stale-spoke', endpoint: EGRESS, libp2p_multiaddr: [MA] },
        { vesselId: 'llm-resolver-google@syzygy-hub', endpoint: EGRESS, libp2p_multiaddr: [MA] },
      ] } },
      () => federatedLlmEgressUrls('http://d', 'k', EGRESS),
    );
    expect(urls).toHaveLength(2);
    expect(urls.some((u) => u.includes('syzygy-hub') || u.includes('llm-resolver-google'))).toBe(true);
  });

  it('a row with no substrate suffix is not routable and is dropped', async () => {
    const urls = await withFetch(
      { content: { vessels: [{ vesselId: 'bare-name', endpoint: EGRESS, libp2p_multiaddr: [MA] }] } },
      () => federatedLlmEgressUrls('http://d', 'k', EGRESS),
    );
    expect(urls).toEqual([]);
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
