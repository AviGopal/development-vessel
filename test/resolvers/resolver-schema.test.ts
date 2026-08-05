// Per-resolver test for `resolver_schema` (R8.1), plus the invariant that gives it its value.
//
// goal-host asks the OWNING vessel for a payload contract before synthesizing pointer args, and
// builds an "AUTHORITATIVE PAYLOAD CONTRACT" block from the answer. This vessel owns most of the
// fleet's write shapes and answered nothing, so those shapes reached synthesis with no contract —
// and the documented fallback (a concept-db how-to lookup) is a severed wire. Measured
// 2026-08-05: four separate minted arms for `substrateGap_write` failed in ONE dispatch, every
// one with missing_required_field, because nothing told the synthesizer about the `gap` envelope.
//
// THE LOAD-BEARING TEST is "a contract is ACCEPTED by the resolver it describes". A contract that
// drifts from its resolver is worse than no contract: it sends every caller confidently to the
// wrong structure, and the failure looks like the caller's fault. This is deliberately a test
// that CAN disagree — it builds the payload from the declared `required` list and calls the real
// resolver, rather than asserting the declaration against itself.
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
// The conformance tests call the REAL gap writer, which persists to
// `${WORKSPACE_ROOT}/gaps/gaps.json`. Point it at a throwaway root BEFORE importing, or the
// probe rows land in the repo's tracked gap store — a test that mutates shared substrate state
// is a test that changes the thing it is measuring.
process.env["WORKSPACE_ROOT"] = mkdtempSync(`${tmpdir()}/dv-resolver-schema-`);
const { CONTRACT_SHAPES, resolveResolverSchema } = await import("../../src/resolvers/resolver-schema.js");
const { resolveSubstrateGapWrite } = await import("../../src/resolvers/substrate-gap.js");

const body = (r: unknown): Record<string, unknown> => (r as { body: Record<string, unknown> }).body;

describe("resolver_schema", () => {
  it("reports known:false for a shape it has no contract for, instead of erroring", () => {
    // known:false is a real answer — it tells the synthesizer to fall back to goal-text
    // extraction. An error here would make an unknown shape indistinguishable from a broken vessel.
    const r = body(resolveResolverSchema({ shape: "definitely_not_a_shape" }));
    expect(r.known).toBe(false);
    expect(r.shape).toBe("definitely_not_a_shape");
  });

  it("requires a shape to describe", () => {
    expect((resolveResolverSchema({}) as { shape: string }).shape).toBe("structuredError");
  });

  it("gives substrateGap_write the gap envelope and its required fields", () => {
    const r = body(resolveResolverSchema({ shape: "substrateGap_write" }));
    expect(r.known).toBe(true);
    expect(r.envelope).toBe("gap");
    expect(r.required).toEqual(["id", "category", "source", "status", "detected_at", "summary"]);
  });

  // goal-host builds `{ [envelope]: {...} }` when an envelope is present and a flat object when
  // it is absent, so "no envelope" must be conveyed by ABSENCE, never by an empty string.
  it("omits envelope entirely for flat-pointer shapes", () => {
    for (const shape of ["memoryNote_write", "test_suite"]) {
      const r = body(resolveResolverSchema({ shape }));
      expect(r.known).toBe(true);
      expect(r.envelope).toBeUndefined();
    }
  });

  it("every declared shape answers known:true with a non-empty required list", () => {
    expect(CONTRACT_SHAPES.length).toBeGreaterThan(0);
    for (const shape of CONTRACT_SHAPES) {
      const r = body(resolveResolverSchema({ shape }));
      expect(r.known).toBe(true);
      expect((r.required as string[]).length).toBeGreaterThan(0);
    }
  });
});

describe("CONTRACT CONFORMANCE — a declared contract must be accepted by its own resolver", () => {
  // Build the payload the contract tells a caller to send, then send it. If the resolver rejects
  // it, the contract is lying and every synthesized call built from it will fail the same way.
  it("substrateGap_write accepts a payload built from its own declared contract", async () => {
    const c = body(resolveResolverSchema({ shape: "substrateGap_write" }));
    const gap: Record<string, unknown> = {};
    for (const f of c.required as string[]) {
      gap[f] =
        f === "detected_at" ? new Date().toISOString()
        : f === "status" ? "open"
        : f === "category" ? "other"
        : f === "id" ? "contract-conformance-probe"
        // summary must be real prose — the description gate rejects empties and {{placeholders}}.
        : f === "summary" ? "Contract conformance probe: payload built from the declared contract."
        : "contract-conformance-probe";
    }
    const res = await resolveSubstrateGapWrite({ type: "substrateGap_write", [c.envelope as string]: gap } as never);
    expect((res as { shape: string }).shape).not.toBe("structuredError");
  });
});

describe("substrateGap_write accepts however an activity threads the data", () => {
  // The regression these exist for: an activity carries its data as pointer fields, and producers
  // name the prose differently. Accepting only `summary` is what made four minted arms unusable.
  for (const key of ["summary", "detail", "description", "text", "title"]) {
    it(`builds a gap from a flat pointer carrying '${key}'`, async () => {
      const res = await resolveSubstrateGapWrite({
        type: "substrateGap_write",
        id: `flat-${key}-probe`,
        [key]: `Flat pointer threaded via ${key} — this must not be rejected.`,
      } as never);
      expect((res as { shape: string }).shape).not.toBe("structuredError");
    });
  }

  // An EMPTY pointer must still be refused. A write resolver that invents content it was never
  // given would turn "the activity threaded nothing" into a plausible-looking row — the swallowed
  // -failure class. Refusing is correct behavior, not the defect.
  it("still refuses a pointer carrying no gap content at all", async () => {
    const res = await resolveSubstrateGapWrite({ type: "substrateGap_write" } as never);
    expect((res as { shape: string }).shape).toBe("structuredError");
    // And the refusal must teach the caller the structure, since goal-host feeds this message
    // back verbatim as the retry correction.
    expect(String(body(res).message)).toContain("gap:{");
  });
});
