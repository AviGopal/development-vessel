import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * A LOCAL TOOL MUST BE LOCAL.
 *
 * findLocalToolsEndpoint() picked the highest-health shellResult producer from discovery with
 * no locality filter, so a FEDERATED row could win — and did.
 *
 * MEASURED 2026-08-18. feature_compose's grounding reads came back
 *
 *   produced_by: local-tools-vessel@federation-transport-vessel@spoke-739b76f1
 *
 * a substrate on neither this workstation nor the hub, which had joined the fleet through the
 * public libp2p relay. It does not have our repository, so every read returned nothing,
 * grounding was 0 bytes, and compose REFUSED "blind decompose" on a file that exists here and
 * that the same process had been reading all along. Teaching by goal stopped working, and the
 * refusal named the file rather than the routing, so it read as a missing file.
 *
 * ★ THE OUTAGE IS THE MILD FAILURE. These calls are fs_read / code_search over OUR source
 *   paths. A peer answering with PLAUSIBLE content instead of nothing would have had the
 *   drafter author patches against a stranger's files, and the resulting diff would have looked
 *   entirely reasonable. Reading local files over the federation is not a capability, it is a
 *   confusion — "local" is the whole meaning of the vessel.
 */

const SRC = new URL('../../src/resolvers/patch-with-tools.ts', import.meta.url).pathname;
const source = () => readFileSync(SRC, 'utf8');

// The predicate exactly as written in the resolver.
const isLocal = (v: { endpoint?: string; libp2p_multiaddr?: string[] }): boolean => {
  if (Array.isArray(v.libp2p_multiaddr) && v.libp2p_multiaddr.length > 0) return false;
  const ep = String(v.endpoint ?? '');
  return ep.includes('127.0.0.1') || ep.includes('localhost');
};

describe('findLocalToolsEndpoint — locality', () => {
  it('guards the instrument: the resolver and filter are present', () => {
    const s = source();
    expect(s).toContain('findLocalToolsEndpoint');
    expect(s).toContain('A LOCAL TOOL MUST BE LOCAL');
  });

  it('THE REGRESSION: selection is made from LOCAL rows only', () => {
    const s = source();
    expect(s).toMatch(/const local = vs\.filter\(isLocal\);/);
    expect(s).toMatch(/const best = local\.sort/);
    // The unfiltered selection must be gone, or the filter is decoration.
    expect(s).not.toMatch(/const best = vs\.sort/);
  });

  it('it REFUSES rather than falling back to a remote reader', () => {
    const s = source();
    const i = s.indexOf('const local = vs.filter(isLocal);');
    const block = s.slice(i, i + 600);
    expect(block).toMatch(/if \(local\.length === 0\)/);
    expect(block).toContain('return null');
    expect(block).toMatch(/refusing rather than reading our source from another substrate/);
  });

  it('THE OBSERVED HIJACK ROW is rejected', () => {
    // A federated row always carries a circuit multiaddr.
    expect(isLocal({
      endpoint: 'http://127.0.0.1:8401',
      libp2p_multiaddr: ['/ip4/138.197.116.56/tcp/30333/p2p/12D3KooW…/p2p-circuit/p2p/12D3KooW…'],
    })).toBe(false);
  });

  it('a genuine local row is accepted', () => {
    expect(isLocal({ endpoint: 'http://127.0.0.1:8230' })).toBe(true);
    expect(isLocal({ endpoint: 'http://localhost:8230/resolve' })).toBe(true);
  });

  it('NEGATIVE CONTROL: a non-loopback row with no multiaddr is still NOT local', () => {
    // Loopback is the positive signal. Absence of a multiaddr alone is not enough — a
    // hub-mirrored row could lack one and still name another host.
    expect(isLocal({ endpoint: 'http://syzygy.host:8230' })).toBe(false);
    expect(isLocal({})).toBe(false);
  });
});
