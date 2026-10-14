// THE STORE-WIDE PICK BRAKE (user ruling 2026-10-14, "Build it before capacity"). Measured: 15 gaps were drafted on BOTH
// nodes in 24 h, every one SEQUENTIAL. The landing lease serialised the drafts, but the picker's own cooldowns are
// in-process, so the other node re-picked the gap 1-8 s after the first released it. The picker now reads the store-wide
// lease state (gap-to-feature crossNodeLeaseSkip), and an acquire is re-entrant only for the same attempt.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crossNodeLeaseSkip } from "../../src/resolvers/gap-to-feature.js";
import { decideLandingLease } from "../../src/resolvers/substrate-gap.js";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const iso = (dt: number) => new Date(NOW + dt).toISOString();
const COOL = 300_000;
const row = (meta: Record<string, unknown>) => ({ id: "g", status: "open", classification_metadata: meta });

describe("crossNodeLeaseSkip: another node's lease state keeps a gap out of the auto-pick", () => {
  it("MUST-FAIL: node B cannot pick a gap node A RELEASED less than the cooldown ago (today: a 1-8 s re-pick)", () => {
    const r = row({ landing_last_release: { holder: "node-a", attempt: "a1", at: iso(-5_000) } });
    expect(crossNodeLeaseSkip(r, NOW, "node-b", COOL)).toMatch(/released by node-a/);
  });
  it("MUST-FAIL: after the cooldown node B can pick it", () => {
    const r = row({ landing_last_release: { holder: "node-a", attempt: "a1", at: iso(-COOL - 1) } });
    expect(crossNodeLeaseSkip(r, NOW, "node-b", COOL)).toBeNull();
  });
  it("MUST-FAIL: a LIVE lease held by node A -> node B skips it at pick", () => {
    const r = row({ landing_lease: { holder: "node-a", attempt: "a1", acquired_at: iso(-60_000), until: iso(3_600_000) } });
    expect(crossNodeLeaseSkip(r, NOW, "node-b", COOL)).toMatch(/landing lease held by node-a/);
  });
  it("CONTROL: an EXPIRED lease by A does not keep B out", () => {
    const r = row({ landing_lease: { holder: "node-a", attempt: "a1", acquired_at: iso(-9_000_000), until: iso(-1) } });
    expect(crossNodeLeaseSkip(r, NOW, "node-b", COOL)).toBeNull();
  });
  it("CONTROL: same-node rules are unchanged: this node's own lease and own release do not skip (left to the in-process maps and gapBackoffMs)", () => {
    expect(crossNodeLeaseSkip(row({ landing_lease: { holder: "node-a", attempt: "a1", acquired_at: iso(0), until: iso(3_600_000) } }), NOW, "node-a", COOL)).toBeNull();
    expect(crossNodeLeaseSkip(row({ landing_last_release: { holder: "node-a", attempt: "a1", at: iso(-5_000) } }), NOW, "node-a", COOL)).toBeNull();
  });
  it("CONTROL: no lease field -> today's pick (no skip)", () => {
    expect(crossNodeLeaseSkip(row({}), NOW, "node-b", COOL)).toBeNull();
  });
  it("structural: the auto-pick filter applies it next to composeInFlight, with this node's identity and the existing cooldown", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "gap-to-feature.ts"), "utf8");
    expect(src).toContain("{ const why = crossNodeLeaseSkip(g, nowMs, pickNode, GAP_COMPOSE_COOLDOWN_MS); if (why) { crossNodeLines.push(`${String(g.id)}: ${why}`); return false; } }");
  });
});

describe("decideLandingLease: an acquire is re-entrant on holder + attempt", () => {
  const lease = (attempt: string, until = iso(3_600_000)) => ({ holder: "node-a", attempt, acquired_at: iso(-60_000), until });
  it("MUST-FAIL: a restarted process (a NEW attempt id) does not re-acquire its prior attempt's live lease", () => {
    const d = decideLandingLease(lease("pid1-slot"), { action: "acquire", gap_id: "g", holder: "node-a", attempt: "pid2-slot" }, NOW);
    expect(d.verdict).toMatchObject({ granted: false, reason: "held_by_prior_attempt" });
    expect(d.next).toBeUndefined();
  });
  it("CONTROL: the SAME attempt re-acquires (idempotent); an acquire naming no attempt keeps today's holder rule", () => {
    expect(decideLandingLease(lease("pid1-slot"), { action: "acquire", gap_id: "g", holder: "node-a", attempt: "pid1-slot" }, NOW).verdict.granted).toBe(true);
    expect(decideLandingLease(lease("pid1-slot"), { action: "acquire", gap_id: "g", holder: "node-a" }, NOW).verdict.granted).toBe(true);
  });
  it("CONTROL: renew and release stay holder-keyed (the cutover renews under its own attempt id)", () => {
    expect(decideLandingLease(lease("pid1-slot"), { action: "renew", gap_id: "g", holder: "node-a", attempt: "mitosis-xyz" }, NOW).verdict.granted).toBe(true);
    expect(decideLandingLease(lease("pid1-slot"), { action: "release", gap_id: "g", holder: "node-a", attempt: "other" }, NOW).verdict).toMatchObject({ released: true });
  });
  it("CONTROL: another holder is still refused, and an expired lease is still taken", () => {
    expect(decideLandingLease(lease("pid1-slot"), { action: "acquire", gap_id: "g", holder: "node-b", attempt: "b1" }, NOW).verdict).toMatchObject({ granted: false, reason: "held_by_other" });
    expect(decideLandingLease(lease("pid1-slot", iso(-1)), { action: "acquire", gap_id: "g", holder: "node-a", attempt: "pid2-slot" }, NOW).verdict.granted).toBe(true);
  });
});
