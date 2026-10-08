// THE CLASS-1 CLASSIFIER MUST READ THE TREE ITS EVALUATOR READS.
//
// classifyFalsifier stamps class1 on a literal gap only when verifyGapCondition can measure it. The evaluator reads
// the edit site from the runtime tree (MITOSIS_RUNTIME_DIR, default /vessels, `repos/` stripped). The classifier read
// WORKSPACE_ROOT (the super-repo clone in the container, captured at module load) with the same stripped path, which
// in the container is never a vessel tree. So a literal present where the evaluator looks was stamped unresolvable
// with a FALSE reason ("hardcoded_url without edit_site/file_path"), and a literal present only in the workspace was
// stamped class1 for a check the evaluator would answer 'unknown'. Measured on node1: every hardcoded_url+edit_site
// gap classified since 2026-09-23 was unresolvable, none class1. Separately the reason never reached the stored row.
//
// Two temp roots, always set explicitly: WS (WORKSPACE_ROOT, the gap store and the tree the classifier used to read)
// and RT (MITOSIS_RUNTIME_DIR, the evaluator's tree). RT is set per test and restored, never left process-wide.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stubGapEventPublish } from "./stub-gap-event-publish.js";

const gapEventPublishStub = stubGapEventPublish();

const WS = mkdtempSync(join(tmpdir(), "c1-tree-ws-"));
const RT = mkdtempSync(join(tmpdir(), "c1-tree-rt-"));
const saved = { ws: process.env["WORKSPACE_ROOT"], skip: process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] };
process.env["WORKSPACE_ROOT"] = WS;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
// A FRESH module instance, so its load-time WORKSPACE_ROOT capture is this file's WS whatever loaded first.
const mod = await import(`../../src/resolvers/substrate-gap.js?${"c1-evaluator-tree"}`);
if (!mod.gapStoreRootForTest().startsWith(tmpdir())) throw new Error(`refusing to run: gap store ${mod.gapStoreRootForTest()} is not under ${tmpdir()}`);
const { classifyFalsifier, resolveSubstrateGapWrite, resolveSubstrateGap } = mod;
const { verifyGapCondition } = await import("../../src/resolvers/gap-to-feature.js");

const LIT = 'fetch("http://127.0.0.1:8080/impulses")';
const put = (root: string, rel: string, text: string): void => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
};
// Under RT only (the evaluator's tree): one with the literal once, one without it.
put(RT, "fixture-vessel/src/present.ts", `export const a = 1;\n${LIT};\n`);
put(RT, "fixture-vessel/src/absent.ts", "export const nothing = 1;\n");
// Under WS only: the literal where the evaluator never looks.
put(WS, "fixture-vessel/src/ws-only.ts", `${LIT};\n`);
// A directory where a file is expected, in BOTH trees, so the read fails EISDIR whichever tree is read.
mkdirSync(join(RT, "fixture-vessel/src/dir.ts"), { recursive: true });
mkdirSync(join(WS, "fixture-vessel/src/dir.ts"), { recursive: true });
mkdirSync(join(WS, "gaps"), { recursive: true });
writeFileSync(join(WS, "gaps", "gaps.json"), "[]");

const site = (f: string): string => `repos/fixture-vessel/src/${f}`;
let prevRt: string | undefined;
beforeEach(() => { prevRt = process.env["MITOSIS_RUNTIME_DIR"]; process.env["MITOSIS_RUNTIME_DIR"] = RT; });
afterEach(() => { if (prevRt === undefined) delete process.env["MITOSIS_RUNTIME_DIR"]; else process.env["MITOSIS_RUNTIME_DIR"] = prevRt; });
afterAll(() => {
  gapEventPublishStub.restore();
  for (const [k, v] of [["WORKSPACE_ROOT", saved.ws], ["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", saved.skip]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(WS, { recursive: true, force: true });
  rmSync(RT, { recursive: true, force: true });
});

type C = { falsifier: string; predicate_position?: string; unresolvable_reason?: string };
const classify = (meta: Record<string, unknown>): C => classifyFalsifier(meta, null) as C;

describe("hardcoded_url: the classifier reads the evaluator's tree", () => {
  it("(1) edit_site only under the evaluator's root, literal once -> class1", () => {
    const c = classify({ edit_site: site("present.ts"), hardcoded_url: LIT });
    expect(c.unresolvable_reason ?? "").not.toContain("without edit_site");
    expect(c.falsifier).toBe("class1");
    expect(c.predicate_position).toBe("hardcoded_url");
  });

  it("(1, negative partner) literal only under WORKSPACE_ROOT, edit_site absent from the evaluator's root -> unresolvable, reason names the missing site", () => {
    const c = classify({ edit_site: site("ws-only.ts"), hardcoded_url: LIT });
    expect(c.falsifier).toBe("unresolvable");
    expect(c.unresolvable_reason ?? "").toContain("edit_site_missing");
  });

  it("(2) literal absent from the evaluator's file -> unresolvable with a TRUE reason (literal_absent), not 'without edit_site'", () => {
    const c = classify({ edit_site: site("absent.ts"), hardcoded_url: LIT });
    expect(c.falsifier).toBe("unresolvable");
    expect(c.unresolvable_reason ?? "").toContain("literal_absent");
    expect(c.unresolvable_reason ?? "").not.toContain("without edit_site");
  });

  it("(3) an unreadable edit site (EISDIR) -> unresolvable with a reason, never a silent class1", () => {
    const c = classify({ edit_site: site("dir.ts"), hardcoded_url: LIT });
    expect(c.falsifier).toBe("unresolvable");
    expect(c.unresolvable_reason ?? "").toContain("edit_site_unreadable");
  });

  it("CONTROL: a hardcoded_url with no edit_site keeps the existing reason", () => {
    const c = classify({ hardcoded_url: LIT });
    expect(c.falsifier).toBe("unresolvable");
    expect(c.unresolvable_reason ?? "").toContain("without edit_site");
  });
});

describe("expected_literal (inverse polarity) on the evaluator's tree", () => {
  it("CONTROL: a literal absent from the evaluator's file -> class1 (the fix must add it)", () => {
    expect(classify({ edit_site: site("absent.ts"), expected_literal: LIT }).falsifier).toBe("class1");
  });

  it("CONTROL: a literal already present in the evaluator's file -> unresolvable, literal_already_present", () => {
    const c = classify({ edit_site: site("present.ts"), expected_literal: LIT });
    expect(c.falsifier).toBe("unresolvable");
    expect(c.unresolvable_reason ?? "").toContain("literal_already_present");
  });

  it("(3) an unreadable edit site (EISDIR) -> unresolvable with a reason; the read error is not a pass", () => {
    const c = classify({ edit_site: site("dir.ts"), expected_literal: "NOT_YET_PRESENT_LITERAL" });
    expect(c.falsifier).toBe("unresolvable");
    expect(c.unresolvable_reason ?? "").toContain("edit_site_unreadable");
  });
});

describe("(5) the classifier and verifyGapCondition agree: class1 <=> 'present' (same meta, same tree)", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["hardcoded_url present", { edit_site: site("present.ts"), hardcoded_url: LIT }],
    ["hardcoded_url absent", { edit_site: site("absent.ts"), hardcoded_url: LIT }],
    ["hardcoded_url, site only in the workspace", { edit_site: site("ws-only.ts"), hardcoded_url: LIT }],
    ["hardcoded_url, site is a directory", { edit_site: site("dir.ts"), hardcoded_url: LIT }],
    ["hardcoded_url, :line suffix", { edit_site: `${site("present.ts")}:2`, hardcoded_url: LIT }],
    ["hardcoded_url, file_path wins over edit_site", { file_path: site("present.ts"), edit_site: site("absent.ts"), hardcoded_url: LIT }],
    // Both literals: the evaluator measures hardcoded_url (Class 1b runs only without one), so the label must too.
    // absent.ts lacks the literal: hardcoded_url reads 'absent' (not class1), expected_literal alone would read class1.
    ["both literals, hardcoded_url absent", { edit_site: site("absent.ts"), hardcoded_url: LIT, expected_literal: LIT }],
    ["expected_literal absent", { edit_site: site("absent.ts"), expected_literal: LIT }],
    ["expected_literal present", { edit_site: site("present.ts"), expected_literal: LIT }],
  ];
  for (const [name, meta] of cases) {
    it(name, () => {
      const c = classify(meta);
      const v = verifyGapCondition({ id: `c1-agree-${name}`, classification_metadata: meta });
      expect({ name, class1: c.falsifier === "class1" }).toEqual({ name, class1: v === "present" });
    });
  }
  it("positive control: the address is live (a class1 here really is measured 'present')", () => {
    const meta = { edit_site: site("present.ts"), hardcoded_url: LIT };
    expect(verifyGapCondition({ id: "c1-agree-positive", classification_metadata: meta })).toBe("present");
    expect(classify(meta).falsifier).toBe("class1");
  });
});

describe("(4) the stored row keeps the unresolvable reason (real write seam, temp store)", () => {
  const write = (id: string, meta: Record<string, unknown>) =>
    resolveSubstrateGapWrite(
      { type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "substrate_detected", status: "open", summary: `evaluator-tree probe ${id}`, detected_at: new Date().toISOString(), classification_metadata: meta } } as never,
      { vocabulary: null, birthJudge: async () => "present" } as never,
    );
  const stored = async (id: string): Promise<Record<string, unknown>> => {
    const r = await resolveSubstrateGap({ type: "substrateGap", id });
    return (((r.body as { gaps: Array<Record<string, unknown>> }).gaps[0] ?? {})["classification_metadata"] ?? {}) as Record<string, unknown>;
  };

  it("a literal_absent verdict is on the stored row", async () => {
    const r = await write("c1-tree-store-absent", { edit_site: site("absent.ts"), hardcoded_url: LIT });
    expect(r.shape).toBe("substrateGapWriteResult");
    const m = await stored("c1-tree-store-absent");
    expect(m["falsifier"]).toBe("unresolvable");
    expect(String(m["falsifier_unresolvable_reason"] ?? "")).toContain("literal_absent");
  });

  it("the no-edit-site reason is on the stored row; a later class1 write clears it", async () => {
    await write("c1-tree-store-flip", { hardcoded_url: LIT });
    expect(String((await stored("c1-tree-store-flip"))["falsifier_unresolvable_reason"] ?? "")).toContain("without edit_site");
    await write("c1-tree-store-flip", { edit_site: site("present.ts"), hardcoded_url: LIT });
    const m = await stored("c1-tree-store-flip");
    expect(m["falsifier"]).toBe("class1");
    expect(m["falsifier_unresolvable_reason"]).toBeUndefined();
  });
});
