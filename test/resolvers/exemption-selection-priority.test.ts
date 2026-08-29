// A HUMAN-ANSWERED GAP MUST BE ABLE TO SPEND ITS EXEMPTION.
//
// escalation_disposition_apply grants a bounded exemption from the hopeless() category seal, but
// the exemption bought nothing in SELECTION, so the gap took one attempt and then lost the queue.
// Measured 2026-08-29: the lift-gate gap sat with 2 of 3 exemption attempts UNSPENT and was picked
// ZERO times in 25 minutes, while three competitors carrying failed_attempts of 122, 82 and 64
// were picked 8 times each — not a reset-penalty effect, they simply outranked it.
//
// An operator answering an escalation is the substrate's most expensive input. Stranding two
// thirds of it leaves the seal's only designed escape opening onto a full room.
//
// The rule is MIRRORED here rather than imported: gap-to-feature.ts has config-time side effects,
// the same reason the hashWork/bucketSignature tests in this directory mirror their subjects. A
// change to humanWeight MUST change this file too.

import { describe, it, expect } from "bun:test";

const SRC = new URL("../../src/resolvers/gap-to-feature.ts", import.meta.url);
const src = async (): Promise<string> => await Bun.file(SRC).text();

const HUMAN_REPORT_PRIORITY = 1.5;
function hasLiveHumanExemption(g: Record<string, unknown>): boolean {
  const m = (g.classification_metadata ?? g.metadata ?? {}) as Record<string, unknown>;
  return Number(m.human_exemption_attempts_remaining ?? 0) > 0;
}
function humanWeight(g: Record<string, unknown>): number {
  return String(g.source ?? "") === "human_reported" || hasLiveHumanExemption(g) ? HUMAN_REPORT_PRIORITY : 1;
}

describe("a live human exemption earns selection priority", () => {
  it("weights a gap with remaining exemption attempts like a human-reported one", () => {
    expect(humanWeight({ classification_metadata: { human_exemption_attempts_remaining: 3 } })).toBe(1.5);
    expect(humanWeight({ classification_metadata: { human_exemption_attempts_remaining: 1 } })).toBe(1.5);
  });

  it("EXPIRES when the exemption is spent — the preference is self-limiting", () => {
    // bumpFailedAttempts decrements on every non-landing attempt, so this is the state the gap
    // reaches on its own. Without expiry, one human answer would privilege a gap forever.
    expect(humanWeight({ classification_metadata: { human_exemption_attempts_remaining: 0 } })).toBe(1);
    expect(humanWeight({ classification_metadata: {} })).toBe(1);
  });

  it("does not disturb the existing human_reported path", () => {
    expect(humanWeight({ source: "human_reported" })).toBe(1.5);
    expect(humanWeight({ source: "substrate_detected" })).toBe(1);
  });

  it("is a TIE-BREAKER, not an override", () => {
    // 1.5x, so a gap with materially better landability x impact still wins on merit. A syntax
    // break that wedges a vessel must still outrank an answered legibility complaint.
    const exempt = 0.4 * 1.0 * humanWeight({ classification_metadata: { human_exemption_attempts_remaining: 3 } });
    const betterMachineGap = 0.9 * 1.5 * humanWeight({ source: "substrate_detected" });
    expect(betterMachineGap).toBeGreaterThan(exempt);
  });

  it("does NOT achieve priority by falsifying attempt history", async () => {
    // The narrowing defect: a verbatim child with failed_attempts:0 outranks its own parent
    // forever. This store already carries a closed gap for it; the fix must not recreate it.
    const s = await src();
    const i = s.indexOf("const hasLiveHumanExemption");
    const block = s.slice(i, i + 900);
    expect(block).not.toMatch(/failed_attempts\s*[:=]\s*0/);
  });
});
