import { describe, it, expect } from "bun:test";
import {
  verifyPatchAddressesGap,
  type ReachabilityFact,
} from "../../src/resolvers/feature-compose.js";

// The B7 row (a landed draft is not required to be wired or to carry a non-self-confirming check, so dead and
// tautological code lands as a fix), case by case.
//
// must_fail clause 1 ("a draft whose only added symbols are unreachable from any caller is refused (hard_fail),
// regardless of the LLM verdict") and the goal-host 81c9d93e replay are
// feature-compose-semantic-gate-self-reference.test.ts: "MUST-FAIL: the 81c9d93e shape is refused without the judge,
// though the judge says addresses:true" and "MUST-FAIL: a symbol called only by another added symbol nobody calls is not
// live either". This file holds the row's control and its development-vessel 0f64cbbc clause.

function judgeSays(addresses: boolean) {
  const prompts: string[] = [];
  const llm = async (prompt: string): Promise<string> => {
    prompts.push(prompt);
    return prompts.length === 1
      ? JSON.stringify({ addresses, on_live_path: true, reason: "judged" })
      : JSON.stringify({ refuted: false, confidence: 0, reason: "" });
  };
  return { llm, prompts };
}

describe("B7 row control: a wired draft whose check recomputes its expected value independently is admitted", () => {
  it("CONTROL: new symbol with a live caller + a check that reads the registry itself -> admitted, no hard_fail", async () => {
    const diff = [
      "### /vessels/goal-host-vessel/src/registry-count.ts",
      "--- a/goal-host-vessel/src/registry-count.ts",
      "+export function countRegistryEntries(entries: ReadonlyArray<{ id: string }>): number {",
      "+  return new Set(entries.map((e) => e.id)).size;",
      "+}",
      "### /vessels/goal-host-vessel/src/index.ts",
      "--- a/goal-host-vessel/src/index.ts",
      "+  const count = countRegistryEntries(await readRegistry());",
      "### /vessels/goal-host-vessel/test/registry-count.test.ts",
      "--- a/goal-host-vessel/test/registry-count.test.ts",
      "+  const entries = JSON.parse(readFileSync(REGISTRY_FIXTURE, 'utf8')).entries;",
      "+  const expected = new Set(entries.map((e) => e.id)).size;",
      "+  expect(countRegistryEntries(entries)).toBe(expected);",
    ].join("\n");
    const facts: ReachabilityFact[] = [
      { symbol: "countRegistryEntries", isNewFunction: true, callerCount: 2, isEntrypoint: true, reachable: true, callerScopes: ["handleReport", null] },
    ];
    const j = judgeSays(true);
    const v = await verifyPatchAddressesGap({ gapSummary: "report the registry count from the registry itself", diff, reachability: facts, llm: j.llm });
    expect(v.hard_fail).not.toBe(true);
    expect(v.llm_consulted).toBe(true);
    expect(v.addresses).toBe(true);
  });
});

// KNOWN PENDING — NOT REFUSED TODAY, a different class (a live no-op, not unreachability).
//
// development-vessel 0f64cbbc edits readRows (live: resolveSelfFactReconcile calls it, self-fact-reconcile.ts:2183) to count a `cause`
// field per row and append cause-count rows. No self-facts row carries `cause` (0 of 18 on origin/dev), so the loop
// never counts and the append never runs: reachable, typechecks, does nothing. It defines no new symbol, so it takes the
// enclosing-symbol path (readRows, reachable), no deterministic floor fires (not a regex literal, not comment-only, not a
// stub), and the judge's addresses:true admits it. Its inertness is a fact about the DATA the code reads, which no
// diff-only gate can see. Kept as a todo carrying the row's must-fail, for the row that builds that check.
const DIFF_0F64CBBC = [
  "### /vessels/development-vessel/src/resolvers/self-fact-reconcile.ts",
  "--- a/development-vessel/src/resolvers/self-fact-reconcile.ts",
  "@@ -259,7 +259,33 @@ function readRows(): SelfFactRow[] | null {",
  "   try {",
  "     const j = JSON.parse(raw) as { rows?: unknown };",
  "     if (!Array.isArray(j.rows)) return noteReadError(`rows ${rowsSource}`, \"no rows[] array\");",
  "-    return (j.rows as SelfFactRow[]).filter((r) => r && typeof r.id === \"string\" && typeof r.instrument === \"string\" && Array.isArray(r.profiles));",
  "+    const rows = (j.rows as SelfFactRow[]).filter(",
  "+      (r) => r && typeof r.id === \"string\" && typeof r.instrument === \"string\" && Array.isArray(r.profiles),",
  "+    );",
  "+",
  "+    const countsByCause: Record<string, number> = {};",
  "+    for (const row of rows) {",
  "+      const cause = (row as unknown as Record<string, unknown>).cause;",
  "+      if (cause && typeof cause === \"string\") {",
  "+        countsByCause[cause] = (countsByCause[cause] ?? 0) + 1;",
  "+      }",
  "+    }",
  "+",
  "+    if (Object.keys(countsByCause).length > 0) {",
  "+      const generatedAt = new Date().toISOString();",
  "+      for (const cause of Object.keys(countsByCause)) {",
  "+        rows.push({",
  "+          id: `cause-count:${cause}:${generatedAt}`,",
  "+          instrument: \"self-fact-reconcile:cause-count\",",
  "+          profiles: [\"all\"],",
  "+          cause,",
  "+          count: countsByCause[cause]!,",
  "+          edit_site: \"\",",
  "+          must_fail: \"\",",
  "+        } as SelfFactRow);",
  "+      }",
  "+    }",
  "+    return rows;",
  "   } catch (err) {",
  "     return noteReadError(`rows ${rowsSource}`, err);",
  "   }",
].join("\n");

describe("B7 row must_fail clause 3: the dv 0f64cbbc live no-op", () => {
  it.todo("KNOWN PENDING MUST-FAIL: replaying dv 0f64cbbc (counts a cause field no self-facts row has) is refused", async () => {
    const facts: ReachabilityFact[] = [
      { symbol: "readRows", isNewFunction: false, callerCount: 1, isEntrypoint: false, reachable: true },
    ];
    const j = judgeSays(true);
    const v = await verifyPatchAddressesGap({ gapSummary: "self-fact-reconcile: count self-facts rows by cause", diff: DIFF_0F64CBBC, reachability: facts, llm: j.llm });
    expect(v.addresses).toBe(false);
    expect(v.hard_fail).toBe(true);
  });
});
