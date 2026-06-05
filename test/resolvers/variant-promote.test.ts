import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveVariantPromote } from "../../src/resolvers/variant-promote.js";

const originalFetch = globalThis.fetch;

describe("variant-promote resolver", () => {
  beforeAll(() => {
    process.env["METABOB_ENDPOINT"] = "https://activity.test";
    process.env["METABOB_API_KEY"] = "test-key";
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects when evidence.reason is missing", async () => {
    const result = await resolveVariantPromote({
      type: "variant_promote",
      family_id: "fam-1",
      winner_variant_id: "act:winner",
      loser_variant_ids: ["act:loser"],
      // @ts-expect-error — testing runtime guard
      evidence: { winner_alpha: 10, winner_beta: 1, loser_alpha: 1, loser_beta: 10 },
    });
    expect(result.shape).toBe("structuredError");
  });

  it("rejects when loser_variant_ids is empty", async () => {
    const result = await resolveVariantPromote({
      type: "variant_promote",
      family_id: "fam-1",
      winner_variant_id: "act:winner",
      loser_variant_ids: [],
      evidence: {
        winner_alpha: 10, winner_beta: 1,
        loser_alpha: 1, loser_beta: 10,
        reason: "winner dominates",
      },
    });
    expect(result.shape).toBe("structuredError");
  });

  it("dry_run returns variantPromoteResult without HTTP calls", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return new Response("nope", { status: 500 }); }) as unknown as typeof fetch;

    const result = await resolveVariantPromote({
      type: "variant_promote",
      family_id: "fam-1",
      winner_variant_id: "act:winner",
      loser_variant_ids: ["act:loser-a", "act:loser-b"],
      evidence: {
        winner_alpha: 18, winner_beta: 2,
        loser_alpha: 5, loser_beta: 15,
        loser_samples: 20,
        reason: "winner mean 0.9, loser mean 0.25, delta 0.65",
      },
      dry_run: true,
    });
    expect(calls).toBe(0);
    expect(result.shape).toBe("variantPromoteResult");
    const body = result.body as { decisions: unknown[]; admitted_count: number; rejected_count: number };
    expect(body.decisions.length).toBe(3); // 1 update + 2 deprecate
    expect(body.admitted_count).toBe(3);
    expect(body.rejected_count).toBe(0);
  });

  it("issues update + per-loser deprecate POSTs and aggregates outcomes", async () => {
    type FetchCall = { url: string; body: any };
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      // First call (update) succeeds, second call (deprecate loser-a) succeeds,
      // third call (deprecate loser-b) hits 422 (insufficient evidence).
      if (calls.length === 3) {
        return new Response(JSON.stringify({ success: false, error: "insufficient_evidence" }), { status: 422 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await resolveVariantPromote({
      type: "variant_promote",
      family_id: "fam-1",
      winner_variant_id: "act:winner",
      loser_variant_ids: ["act:loser-a", "act:loser-b"],
      evidence: {
        winner_alpha: 18, winner_beta: 2,
        loser_alpha: 5, loser_beta: 15,
        loser_samples: 20,
        reason: "winner mean 0.9, loser mean 0.25",
      },
    });

    expect(calls.length).toBe(3);
    expect(calls[0]?.body.pointer.type).toBe("activityTemplate_update");
    expect(calls[0]?.body.pointer.evidence.reason).toContain("winner of family fam-1");
    expect(calls[1]?.body.pointer.type).toBe("activityTemplate_deprecate");
    expect(calls[1]?.body.pointer.templateId).toBe("act:loser-a");
    expect(calls[1]?.body.pointer.evidence.loser_samples).toBe(20);
    expect(calls[2]?.body.pointer.templateId).toBe("act:loser-b");

    expect(result.shape).toBe("variantPromoteResult");
    const body = result.body as { admitted_count: number; rejected_count: number; complete: boolean };
    expect(body.admitted_count).toBe(2);
    expect(body.rejected_count).toBe(1);
    expect(body.complete).toBe(false);
  });
});
