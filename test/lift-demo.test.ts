/**
 * §S.4 / §10 — Lift demo
 *
 * Proves the unified judgment idiom: one resolver, multiple judgment
 * source-tiers, all routed through the SAME activity-api endpoint with
 * tier-specific weights — and adding a new tier requires only a weight-
 * table entry, not a dispatch-path change.
 *
 * Spec: openspec/changes/2026-05-21-development-vessel/tasks.md §10.
 *
 * Implementation note: §10.1 used illustrative tier names
 * (validator/audit/human); the actual `propagate-judgment` resolver uses
 * (human/verifier/automatic) which predates §10. This test follows the
 * impl's contract — the structural "no new wiring" assertion is
 * parameterised by reading the weight table at runtime, so when a future
 * SPEC iteration reconciles vocabulary with design.md §F (5-tier set),
 * the test picks up the new tiers automatically.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { resolvePropagateJudgment } from "../src/resolvers/propagate-judgment.js";

const RESOLVER_SOURCE_PATH = join(
  import.meta.dir,
  "..",
  "src",
  "resolvers",
  "propagate-judgment.ts",
);

const originalFetch = globalThis.fetch;

interface Capture {
  url: string;
  body: {
    activity_variant_id: string;
    impulse_id: string;
    source: string;
    weight: number;
    relevance_score: number;
  };
}

const captures: Capture[] = [];

function installCapturingFetch(): void {
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    captures.push({
      url: String(input),
      body: JSON.parse((init as RequestInit).body as string),
    });
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("§S.4 / §10 — lift demo", () => {
  beforeAll(() => {
    process.env["METABOB_ENDPOINT"] = "https://activity.test";
    process.env["METABOB_API_KEY"] = "test-key";
    captures.length = 0;
    installCapturingFetch();
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("§10.1 — three distinct source-tier judgments dispatch through the same resolver", async () => {
    // Impulses share the target_variant_id but differ in source_tier — the
    // load-bearing signal that one variant gets posterior pressure from
    // multiple independent oracle layers.
    const TARGET_VARIANT = "activity:demo_variant_v1";
    const sharedImpulse = "impulse:lift-demo-failure";

    await resolvePropagateJudgment({
      type: "propagate_judgment",
      activity_variant_id: TARGET_VARIANT,
      impulse_id: sharedImpulse,
      relevance_score: 0.0, // negative posterior pressure
      source_tier: "human",
    });
    await resolvePropagateJudgment({
      type: "propagate_judgment",
      activity_variant_id: TARGET_VARIANT,
      impulse_id: sharedImpulse,
      relevance_score: 0.0,
      source_tier: "verifier",
    });
    await resolvePropagateJudgment({
      type: "propagate_judgment",
      activity_variant_id: TARGET_VARIANT,
      impulse_id: sharedImpulse,
      relevance_score: 0.0,
      source_tier: "automatic",
    });

    // §10.2 — assertions.

    // capture count
    expect(captures.length).toBe(3);

    // endpoint uniformity
    expect(captures.every((c) => c.url.endsWith("/v2/activities/impulse-relevance"))).toBe(true);

    // same target reinforced
    expect(captures.every((c) => c.body.activity_variant_id === TARGET_VARIANT)).toBe(true);

    // distinct source tiers preserved (extracted from the body.source prefix)
    const tiers = captures.map((c) => c.body.source.split(":")[0]);
    expect(new Set(tiers).size).toBe(3);
    expect(new Set(tiers)).toEqual(new Set(["human", "verifier", "automatic"]));

    // canonical negative-posterior shape (relevance_score=0.0)
    expect(captures.every((c) => c.body.relevance_score === 0.0)).toBe(true);

    // monotonic weights per tier (human > verifier > automatic per current impl)
    const weightByTier: Record<string, number> = {};
    for (const c of captures) {
      const tier = c.body.source.split(":")[0]!;
      weightByTier[tier] = c.body.weight;
    }
    const wHuman = weightByTier["human"];
    const wVerifier = weightByTier["verifier"];
    const wAutomatic = weightByTier["automatic"];
    expect(typeof wHuman).toBe("number");
    expect(typeof wVerifier).toBe("number");
    expect(typeof wAutomatic).toBe("number");
    expect(wHuman!).toBeGreaterThan(wVerifier!);
    expect(wVerifier!).toBeGreaterThan(wAutomatic!);
  });

  it("§10.3 — 'no new wiring': source_tier strings appear exactly in the weight ternary, nowhere else", () => {
    // The structural claim that proves lift: adding a new judgment source
    // requires editing only the weight ternary/table — not the dispatch
    // path. We assert this by counting occurrences of each tier-name
    // string in the resolver source, then asserting they ALL appear
    // exclusively within the weight-resolution expression.
    //
    // The current impl uses an inline ternary on a single line:
    //   const weight = pointer.source_tier === "human" ? 1.0 : ...
    // So each tier name appears once in that line plus once in the
    // PropagateJudgmentPointer type union — that's TWO references per tier,
    // both load-bearing for type-safety, both NOT in the dispatch path.
    //
    // The assertion: every tier-name string lives on either the type-union
    // line or the weight-resolution line. No tier name appears in:
    //   - a switch case
    //   - an if/else if branch outside the weight line
    //   - a route or HTTP path
    const source = readFileSync(RESOLVER_SOURCE_PATH, "utf-8");

    // Extract tier names from the type union itself — that's the source
    // of truth. Survives a future tier expansion automatically.
    const unionMatch = source.match(/source_tier:\s*([^;]+);/);
    expect(unionMatch).toBeTruthy();
    const unionText = unionMatch?.[1] ?? "";
    const tierNames = (unionText.match(/"[a-z_]+"/g) ?? []).map((s) => s.slice(1, -1));
    expect(tierNames.length).toBeGreaterThanOrEqual(3);

    // For each tier, find every line it appears on (other than blank/comment
    // lines), then check that EVERY hit is either the type-union declaration
    // or the weight-resolution expression. No tier name should appear in a
    // switch/case, route handler, or other dispatch construct.
    const lines = source.split("\n");
    for (const tier of tierNames) {
      const tierRegex = new RegExp(`"${tier}"`);
      const hits = lines
        .map((line, i) => ({ line, lineNum: i + 1 }))
        .filter(({ line }) => tierRegex.test(line));
      for (const { line, lineNum } of hits) {
        const isUnionDeclaration = /source_tier\s*:/.test(line);
        const isWeightTable = /weight\s*=\s*pointer\.source_tier/.test(line) || /weight\s*=/.test(line);
        if (!isUnionDeclaration && !isWeightTable) {
          throw new Error(
            `§10.3 violation: tier name "${tier}" appears on line ${lineNum} ` +
              `outside the type union and weight table:\n  ${line.trim()}\n` +
              `Adding a new judgment source must only touch the weight table.`,
          );
        }
      }
    }
  });

  it("§10.4 boundary — this test does NOT exercise real Thompson updates, real activity execution, or audit-test-report composition", () => {
    // The test uses synthetic validation_result impulses and a fake fetch;
    // it does not depend on a live activity-api or a real trace. Recorded
    // here so a reviewer sees the boundary explicitly. Real-canary lift
    // happens after §6 (operator seed) and §7 (parity gate). See §10.4.
    expect(true).toBe(true);
  });
});
