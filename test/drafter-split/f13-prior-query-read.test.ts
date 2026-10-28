// Checklist 2.2: variants may request bounded concept priors through the closed core.
import { describe, expect, it } from "bun:test";

const fc = await import("../../src/resolvers/feature-compose.ts");

const SCOPE = { verifyVessels: ["repos/development-vessel"], targets: [], checkPaths: [] };
const EMPTY_CONTEXT = {
  grounding: "", targetWindows: {}, priorFeedback: "", principles: "", composeLessons: "",
  netNewTargets: [], opBudgetHint: 24, journal: [], version: "test",
};

describe("drafter priorQueries read request (checklist 2.2)", () => {
  it("clamps the variant's query and source types under the shared token ceiling", () => {
    const result = fc.clampDrafterReadPlan({
      reads: [{ kind: "priorQueries", query: "adapter timeout contract", sourceTypes: ["memo", "vessel_construction_pattern"], budgetTokens: 900 }],
      lessonQueries: [], ancestorDepth: 0,
    }, SCOPE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reads).toEqual([{ kind: "priorQueries", query: "adapter timeout contract", sourceTypes: ["memo", "vessel_construction_pattern"], budgetTokens: 900 }]);
    expect(fc.MAX_DRAFT_PRIOR_QUERY_TOKENS).toBeGreaterThanOrEqual(900);
  });

  it("refuses an over-budget request whole instead of truncating its budget", () => {
    const result = fc.clampDrafterReadPlan({
      reads: [{ kind: "priorQueries", query: "adapter timeout contract", sourceTypes: ["memo"], budgetTokens: fc.MAX_DRAFT_PRIOR_QUERY_TOKENS + 1 }],
      lessonQueries: [], ancestorDepth: 0,
    }, SCOPE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reads).toEqual([]);
      expect(result.dropped.join("\n")).toContain(String(fc.MAX_DRAFT_PRIOR_QUERY_TOKENS));
      expect(result.dropped.join("\n")).not.toContain("truncat");
    }
    const aggregate = fc.clampDrafterReadPlan({
      reads: [
        { kind: "priorQueries", query: "first", sourceTypes: ["memo"], budgetTokens: 900 },
        { kind: "priorQueries", query: "second", sourceTypes: ["memo"], budgetTokens: 601 },
      ],
      lessonQueries: [], ancestorDepth: 0,
    }, SCOPE);
    expect(aggregate.ok).toBe(true);
    if (aggregate.ok) {
      expect(aggregate.reads).toEqual([{ kind: "priorQueries", query: "first", sourceTypes: ["memo"], budgetTokens: 900 }]);
      expect(aggregate.dropped.join("\n")).toContain("request refused whole");
    }
  });

  it("drops an oversized selector response whole instead of truncating its content", async () => {
    let shown: unknown;
    const result = await fc.draftContextThroughOpenModule({
      facts: { contents: {}, lessonHits: [] }, scope: SCOPE,
      expect: { ceiling: 24, netNew: [], targets: [], targetContents: {}, mandatory: [], floorPrompt: "", prompts: () => ({ decompose: "", refine: "" }) },
      floorBudget: 24, readFile: async () => null,
      readPriorQuery: async () => [{ id: "concept:large", source_type: "memo", name: null, content: "x".repeat(8000) }],
      readGapRow: async () => null, lessonRows: async () => [], ancestorStart: "", selfId: "", variant: "drafter-v9-priors", mode: "named",
      load: async () => ({
        planDrafterReads: () => ({ reads: [{ kind: "priorQueries", query: "large", sourceTypes: ["memo"], budgetTokens: 900 }], lessonQueries: [], ancestorDepth: 0 }),
        assembleDrafterContext: (facts: unknown) => {
          shown = (facts as { priorQueries?: unknown }).priorQueries;
          return EMPTY_CONTEXT;
        },
      }),
    });
    expect(result.record.fell_back).toBeNull();
    expect(shown).toEqual([]);
    expect(result.priorQueryIds).toEqual([]);
    expect(result.record.dropped?.join("\n")).toContain("not read");
  });

  it("fulfills only accepted queries and credits only ids actually shown by the selected assembly", async () => {
    const accepted = { kind: "priorQueries", query: "adapter timeout contract", sourceTypes: ["memo"], budgetTokens: 900 };
    let received: unknown;
    const result = await fc.draftContextThroughOpenModule({
      facts: { contents: {}, lessonHits: [] },
      scope: SCOPE,
      expect: {
        ceiling: 24, netNew: [], targets: [], targetContents: {}, mandatory: [], floorPrompt: "",
        prompts: () => ({ decompose: "", refine: "" }),
      },
      floorBudget: 24,
      readFile: async () => null,
      readPriorQuery: async (request: unknown) => {
        received = request;
        return [
          { id: "concept:shown", source_type: "memo", name: "bounded prior", content: "Use the returned contract." },
          { id: "concept:not-shown", source_type: "goal", name: "wrong source", content: "Not selected by the query." },
        ];
      },
      readGapRow: async () => null,
      lessonRows: async () => [],
      ancestorStart: "", selfId: "", variant: "drafter-v9-priors", mode: "named",
      load: async () => ({
        planDrafterReads: () => ({ reads: [accepted], lessonQueries: [], ancestorDepth: 0 }),
        assembleDrafterContext: (facts: unknown) => {
          const f = facts as { priorQueries?: Array<{ query: string; rows: Array<{ id: string; content: string }> }> };
          expect(f.priorQueries).toEqual([{ query: "adapter timeout contract", rows: [{ id: "concept:shown", source_type: "memo", name: "bounded prior", content: "Use the returned contract." }] }]);
          return { ...EMPTY_CONTEXT, principles: "[concept:shown] Use the returned contract." };
        },
      }),
    });
    expect(received).toEqual({ query: accepted.query, sourceTypes: accepted.sourceTypes, budgetTokens: accepted.budgetTokens });
    expect(result.record.fell_back).toBeNull();
    expect(result.priorQueryIds).toEqual(["concept:shown"]);
    const shown = result.priorQueryIds.filter((id: string) => result.ctx?.principles.includes(`[${id}]`));
    expect(fc.appliedConceptIds({ applied_ids: ["concept:shown", "concept:not-shown"] }, shown)).toEqual({
      applied: ["concept:shown"], dropped: ["concept:not-shown"],
    });
  });
});
