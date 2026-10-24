// THE REGION GATE READS MORE ANCHOR SOURCES, AND A MULTI-OCCURRENCE ANCHOR IS ONE MUTANT (qa anchor-source ruling, 2026-10-24).
//
// development-vessel 5e69d7a0's row (the-check-supply-mutation-gate-refuses-to-arm-a-check-without-logging-…) has no
// literal region and no quoted observed output, so the region gate derived nothing for it ("unmeasured: no region")
// and its check, which asserts on outcomeKindOf, a function the gap is not about, armed unmeasured. falsifiableAnchors
// now also reads the row's must_fail and control text, and (for the region gate only, `site_tokens`) a snake_case or
// camelCase identifier the evidence names that occurs 1 to 5 times in the edit site's code or strings, never its
// comments. An anchor occurring N > 1 times is ONE mutant replacing every enclosing statement together. The check goal
// passes neither, so what the drafter is told is unchanged. The site is gap-check-supply.ts at bf88c790 (fixture), the
// tree 5e69d7a0's check was measured against plus this branch's earlier commits.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const supply = await import("../../src/resolvers/gap-check-supply.js") as Record<string, unknown> & typeof import("../../src/resolvers/gap-check-supply.js");
const FIX = join(import.meta.dir, "..", "fixtures", "check-asserts-defect-output");
const SITE = readFileSync(join(FIX, "gap-check-supply.bf88c790.ts.txt"), "utf8");
const ROW = JSON.parse(readFileSync(join(FIX, "5e69d7a0-row-evidence.json"), "utf8")) as { summary: string; must_fail: string; control: string; falsifier_spec: string };
const SITE_REL = "src/resolvers/gap-check-supply.ts";
const more = { must_fail: ROW.must_fail, control: ROW.control };

describe("the region gate's anchor sources", () => {
  it("[MUST-FAIL] 5e69d7a0's row derives a region: the token red_independent_of_edit_site, both refusal returns replaced in ONE mutant", () => {
    const r = supply.derivedTextRegion(SITE, SITE_REL, ROW.summary, ROW.falsifier_spec, more);
    expect(r).not.toBeNull();
    expect(r!).toMatchObject({ anchor: "red_independent_of_edit_site", kind: "token", occurrences: 2 });
    const m = r!.mutant;
    expect(m.operator).toBe("replace_statement");
    expect(SITE.slice(m.start, m.end)).toBe(m.original);
    // Both occurrences' statements (the two refusal returns of editSiteMutationGate), and the code between them kept.
    expect(m.original.match(/red_independent_of_edit_site/g)?.length).toBe(2);
    expect(m.replacement.match(/return undefined as any;/g)?.length).toBe(2);
    expect(m.replacement).not.toContain("red_independent_of_edit_site");
    expect(m.replacement).toContain("const region = siteRegionSource(src, a.checkSrc);");
    expect(m.original.startsWith("return { kind: \"refuse\"")).toBe(true);
  });

  it("[CONTROL] the check goal's anchors are unchanged: no token anchors without site_tokens", () => {
    const goal = supply.falsifiableAnchors(ROW.summary, SITE, ROW.falsifier_spec);
    expect(goal.some((a) => a.kind === "token")).toBe(false);
    expect(supply.falsifiableAnchors(ROW.summary, SITE, ROW.falsifier_spec, null, { ...more, site_tokens: true }).some((a) => a.kind === "token" && a.value === "red_independent_of_edit_site")).toBe(true);
  });

  it("[CONTROL] a token is counted in code and strings, never comments", () => {
    const src = "// only_in_comment is named here\n/* and only_in_comment here */\nexport function f(x: number): string {\n  if (x > 1) return \"seen_twice\";\n  return \"seen_twice again\";\n}\n";
    const a = supply.falsifiableAnchors("gap: only_in_comment and seen_twice", src, "", null, { site_tokens: true }).filter((x) => x.kind === "token").map((x) => x.value);
    expect(a).toEqual(["seen_twice"]);
    const r = supply.derivedTextRegion(src, "src/f.ts", "gap: only_in_comment and seen_twice");
    expect(r).toMatchObject({ anchor: "seen_twice", occurrences: 2 });
    expect(r!.mutant.replacement).toBe("return undefined as any;\n  return undefined as any;");
  });

  it("[CONTROL] a quoted observed output in the row's must_fail is an anchor (read like the falsifier_spec)", () => {
    const src = "export function g(): string {\n  throw new Error(\"the widget is not configured\");\n}\n";
    const r = supply.derivedTextRegion(src, "src/g.ts", "g misbehaves", "", { must_fail: "g throws \"the widget is not configured\" today" });
    expect(r).toMatchObject({ anchor: "the widget is not configured", kind: "text", occurrences: 1 });
    expect(r!.mutant.replacement).toBe("void 0;");
  });

  it("[CONTROL] a TEXT anchor with an occurrence in a declaration is no region (tokens skip declarations: see the declaration-skip test)", () => {
    const src = "export const MESSAGE = \"the widget is not configured\";\nexport function h(): string {\n  throw new Error(\"the widget is not configured\");\n}\n";
    expect(supply.derivedTextRegion(src, "src/h.ts", "h throws \"the widget is not configured\"")).toBeNull();
  });
});

// RE-ASSERTED REPLAYS under the broadened sources (qa, research): neither wrong-function check is region-gated.
describe("[REPLAY] 40d50487 and 84460a91 under the broadened anchor sources", () => {
  const ev = (f: string) => JSON.parse(readFileSync(join(FIX, f), "utf8")) as { summary: string; falsifier_spec: string | null; region: string | null };
  const tokens = (site: string, e: { summary: string; falsifier_spec: string | null }) => {
    const free = supply.commentFreeSource(site);
    return supply.falsifiableAnchors(e.summary, site, e.falsifier_spec ?? "", null, { site_tokens: true }).filter((a) => a.kind === "token").map((a) => [a.value, supply.anchorOccurrences(free, a).length]);
  };
  it("development-vessel 40d50487: a literal region in its own site (no gate)", () => {
    const e = ev("40d50487-row-evidence.json");
    expect(supply.regionGateApplies({ region: e.region }, SITE)).toBe(false);
  });
  it("libp2p-federation-transport 84460a91: a literal region in another repo (no gate); its tokens occur only at their declarations", () => {
    const e = ev("84460a91-row-evidence.json");
    const site = readFileSync(join(FIX, "libp2p-federation-transport-index.84460a91.ts.txt"), "utf8");
    expect(supply.regionGateApplies({ region: e.region })).toBe(false);
    expect(tokens(site, e)).toEqual([["resolveViaLibp2p", 1], ["resolveViaHttp", 1]]);
    expect(supply.derivedTextRegion(site, "src/index.ts", e.summary, e.falsifier_spec ?? "")).toBeNull();
  });
});
