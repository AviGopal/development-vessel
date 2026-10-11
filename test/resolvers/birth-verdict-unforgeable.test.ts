// THE BIRTH VERDICT IS UNFORGEABLE (PLAN4 finding 2).
//
// The write seam (substrate-gap.ts applyBirthStamp) takes one in-process trusted channel, `opts.birthVerdict`:
// a caller that has just run the birth judge on a class-2 check hands the verdict over so the check is not run
// twice. It used to be honoured for ANY object whose predicate_key matched the written check, so a caller could
// pass `{ predicate_key, verdict: "present" }` for a check it never ran and the row was born trusted
// (admissible; closable by its own 'absent'). The callers that pass it (gap-to-feature decomposeGap,
// gap-check-supply's arm step) are lane-editable. The seam now honours only a verdict MINTED by
// takeBirthVerdictWithReport (the seam's own judge), for the same gap id and the same check; anything else is
// ignored and the seam judges the check itself.
//
// Driven through the real write seam, the real decomposeGap and the real store. The birth judge is the test
// override (__setBirthJudgeForTests), counted per gap id, so "the seam judged it" and "the forgery was honoured"
// are both observable. No network: globalThis.fetch answers discovery, the open policy and the LLM.
//
// MUST-FAIL rows are red at the parent BEHAVIOURALLY (the parent honours the forgery: the row reads "present" and
// the judge never ran); they reference no symbol the fix introduces. Rows marked TIP-HARDENING pin properties of
// the minted verdict (frozen, bound to its gap id) and are green at the parent only because the parent mints
// nothing. CONTROL rows pin that genuine runs are still honoured without a second evaluation.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";

const ROOT = join(tmpdir(), `birth-unforgeable-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js");
const g2fPolicy = await import("../../src/judge/gap-policy.js");
const { resolveSubstrateGapWrite, resolveSubstrateGap, __settleBirthEvaluationsForTests, __setBirthJudgeForTests, __setFleetVocabularyForTests, class2PredicateKey } = sg;
const { decomposeGap } = g2f;
const { __resetPolicyReadsForTests } = g2fPolicy;

const RUN = Math.random().toString(36).slice(2, 8);
const CLONES = join(ROOT, "clones");
const SITE = "repos/fixture-vessel/src/widget.ts";
// What the judge reads for each named test on "the current tree". The defect is real for the first only.
const tree: Record<string, "present" | "absent"> = { "widget counts rejected frames": "present", "widget already passes": "absent" };
const judged: string[] = [];
const originalFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};
let llmReply: Record<string, unknown> = {};

const check = (name: string) => ({ evidence_resolve: { shape: "test_suite", input: { vessel: "repos/fixture-vessel", test_file: "test/widget.test.ts", only_tests: [name], timeout_ms: 180000 }, zero_field: "requested_not_passing" } });
const judgedFor = (id: string): number => judged.filter((x) => x === id).length;

async function write(id: string, meta: Record<string, unknown>, opts: Record<string, unknown> = {}): Promise<void> {
  const res = await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "substrate_detected", status: "open", summary: `gap ${id} for the unforgeable-birth tests`, detected_at: new Date().toISOString(), classification_metadata: { edit_site: SITE, ...meta } } } as never, { vocabulary: null, ...opts } as never);
  expect(res.shape).not.toBe("structuredError");
}
async function row(id: string): Promise<Record<string, unknown>> {
  const r = await resolveSubstrateGap({ type: "substrateGap", id } as never);
  const g = ((r.body as { gaps?: Array<Record<string, unknown>> }).gaps ?? []).find((x) => x.id === id);
  if (!g) throw new Error("row not found: " + id);
  return g;
}
const birthOf = async (id: string): Promise<unknown> => ((await row(id)).classification_metadata as Record<string, unknown>)["predicate_birth_verdict"];

let gapStore: { restore: () => Promise<void> } | null = null;
beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), __settleBirthEvaluationsForTests);
  __setFleetVocabularyForTests({ v: null });
  for (const k of ["VESSELS_CLONE_ROOT", "GAP_STORE_ENDPOINT"]) savedEnv[k] = process.env[k];
  delete process.env["GAP_STORE_ENDPOINT"];
  process.env["VESSELS_CLONE_ROOT"] = CLONES;
  mkdirSync(join(CLONES, "fixture-vessel", "src"), { recursive: true });
  mkdirSync(join(CLONES, "fixture-vessel", "test"), { recursive: true });
  writeFileSync(join(CLONES, "fixture-vessel", "src", "widget.ts"), "export function countRejected(fs: number[]): number { return fs.filter((f) => f <= 0).length; }\n");
  writeFileSync(join(CLONES, "fixture-vessel", "test", "widget.test.ts"), 'import { it } from "bun:test";\nit("widget counts rejected frames", () => {});\nit("widget already passes", () => {});\n');
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability") {
      if (body.pointer.shape === "llm_completion") return Response.json({ content: { vessels: [{ endpoint: "http://llm.test", resolve_endpoint: "/resolve" }] } });
      return Response.json({ content: { shape: body.pointer.shape, vessels: [{ vesselId: "dv", endpoint: "http://node.test", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
    }
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    if (url === "http://llm.test/resolve") return Response.json({ content: JSON.stringify(llmReply) });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  // THE BIRTH JUDGE: reads the named test against `tree`, and records which gap it judged.
  __setBirthJudgeForTests(async (g: Record<string, unknown>) => {
    judged.push(String(g["id"] ?? ""));
    const er = ((g["classification_metadata"] ?? {}) as Record<string, unknown>)["evidence_resolve"] as { input?: { only_tests?: string[] } } | undefined;
    const name = er?.input?.only_tests?.[0] ?? "";
    return tree[name] ?? "unknown";
  });
  __resetPolicyReadsForTests();
});
beforeEach(() => { judged.length = 0; });
afterAll(async () => {
  await gapStore?.restore();
  __setBirthJudgeForTests(null);
  __setFleetVocabularyForTests(null);
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  __resetPolicyReadsForTests();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

describe("the write seam honours only a minted birth verdict", () => {
  it("MUST-FAIL: a hand-built { predicate_key, verdict: 'present' } for the exact check is NOT honoured; the seam judges the check (absent)", async () => {
    const id = `bvu-literal-${RUN}`;
    const meta = check("widget already passes"); // the judge reads absent: the forged 'present' is a lie
    await write(id, meta, { birthVerdict: { predicate_key: class2PredicateKey(meta), verdict: "present" } });
    await __settleBirthEvaluationsForTests();
    expect(await birthOf(id)).toBe("absent");
    expect(judgedFor(id)).toBe(1);
  });

  it("MUST-FAIL: a literal shaped like a minted verdict (gap id, key, check, verdict) is NOT honoured", async () => {
    const id = `bvu-lookalike-${RUN}`;
    const meta = check("widget already passes");
    const key = class2PredicateKey(meta);
    await write(id, meta, { birthVerdict: Object.freeze({ gap_id: id, predicate_key: key, check: key, verdict: "present" }) });
    await __settleBirthEvaluationsForTests();
    expect(await birthOf(id)).toBe("absent");
    expect(judgedFor(id)).toBe(1);
  });

  it("MUST-FAIL (gap-check-supply's arm write, as the parent wrote it): a forged 'present' on the arm's exact write is refused", async () => {
    // The parent's arm step (gap-check-supply.ts) wrote the armed check with { birthVerdict: { predicate_key: key,
    // verdict: "present" } }, key = class2PredicateKey({ evidence_resolve, verify_shape }). A lane edit restoring
    // that line, or skipping the run before it, would hand the seam that literal. This is that write, verbatim.
    const id = `bvu-arm-${RUN}`;
    await write(id, { check_supply: { state: "goal_dispatched", vessel: "fixture-vessel", test_file: "test/widget.test.ts" } });
    const evidence_resolve = { shape: "test_suite", input: { vessel: "repos/fixture-vessel", test_file: "test/widget.test.ts", only_tests: ["widget already passes"] }, zero_field: "requested_not_passing" };
    const key = class2PredicateKey({ evidence_resolve, verify_shape: null });
    const r = await resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "substrate_detected", summary: `gap ${id} for the unforgeable-birth tests`, detected_at: new Date().toISOString(), status: "open", classification_metadata: { evidence_resolve, edit_site: SITE, predicate_source: "gap_check_supply", disposition: "", check_supply: { state: "armed", red_at_head: true, last_verdict: "present" } } } } as never, { birthVerdict: { predicate_key: key, verdict: "present" } } as never);
    expect(r.shape).not.toBe("structuredError");
    await __settleBirthEvaluationsForTests();
    expect(await birthOf(id)).toBe("absent");
    expect(judgedFor(id)).toBe(1);
  });

  it("CONTROL: a verdict minted by the real run (takeBirthVerdictWithReport) is honoured, with no second evaluation", async () => {
    const id = `bvu-minted-${RUN}`;
    const meta = check("widget counts rejected frames");
    const run = await sg.takeBirthVerdictWithReport(id, meta) as Record<string, unknown>;
    expect(run["verdict"]).toBe("present");
    expect(judgedFor(id)).toBe(1);
    await write(id, meta, { birthVerdict: run["stamp"] });
    await __settleBirthEvaluationsForTests();
    expect(await birthOf(id)).toBe("present");
    expect(judgedFor(id)).toBe(1); // the run above, not repeated by the seam
  });

  it("TIP-HARDENING: a minted 'absent' cannot be flipped to 'present' after minting", async () => {
    const id = `bvu-flip-${RUN}`;
    const meta = check("widget already passes");
    const run = await sg.takeBirthVerdictWithReport(id, meta) as Record<string, unknown>;
    expect(run["verdict"]).toBe("absent");
    const stamp = run["stamp"] as Record<string, unknown> | undefined;
    try { (stamp as Record<string, unknown>)["verdict"] = "present"; } catch { /* frozen (or, at the parent, no stamp) */ }
    await write(id, meta, { birthVerdict: stamp });
    await __settleBirthEvaluationsForTests();
    expect(await birthOf(id)).toBe("absent");
  });

  it("TIP-HARDENING: a verdict minted for one gap is not honoured on another gap with the same check", async () => {
    const meta = check("widget counts rejected frames");
    const run = await sg.takeBirthVerdictWithReport(`bvu-owner-${RUN}`, meta) as Record<string, unknown>;
    expect(run["verdict"]).toBe("present");
    const other = `bvu-borrower-${RUN}`;
    await write(other, meta, { birthVerdict: run["stamp"] });
    await __settleBirthEvaluationsForTests();
    expect(judgedFor(other)).toBe(1); // the seam judged the borrower itself
  });

  it("TIP-HARDENING: a spread copy of a minted verdict is not one", async () => {
    const id = `bvu-copy-${RUN}`;
    const meta = check("widget already passes");
    const run = await sg.takeBirthVerdictWithReport(id, meta) as Record<string, unknown>;
    const copy = { ...((run["stamp"] ?? {}) as Record<string, unknown>), verdict: "present" };
    await write(id, meta, { birthVerdict: copy });
    await __settleBirthEvaluationsForTests();
    expect(await birthOf(id)).toBe("absent");
  });
});

describe("decomposeGap's genuine run still hands the seam its verdict", () => {
  it("CONTROL: a parent check and a step check judged present are stamped present, each judged exactly once", async () => {
    const parentId = `bvu-parent-${RUN}`;
    await write(parentId, {});
    const parent = await row(parentId);
    llmReply = {
      parent_check: check("widget counts rejected frames"),
      steps: [{ edit_site: SITE, change: "countRejected must count zero frames", falsifier: { evidence_resolve: { shape: "widget_frame_report", input: {}, zero_field: "defects" } } }],
    };
    // The step's shape check: the judge reads it present (its evidence_resolve names no test).
    tree[""] = "present";
    try {
      const d = await decomposeGap(parent, { parentCheck: true, deps: { llm: async () => JSON.stringify(llmReply), shapeDescriptions: async () => ({ widget_frame_report: "counts widget frames rejected (defects)" }) } });
      await __settleBirthEvaluationsForTests();
      expect(d.parent_check).toBe("written");
      expect(d.written).toEqual([`${parentId}-step-1`]);
    } finally { delete tree[""]; }
    expect(await birthOf(parentId)).toBe("present");
    expect(judgedFor(parentId)).toBe(1);
    expect(await birthOf(`${parentId}-step-1`)).toBe("present");
    expect(judgedFor(`${parentId}-step-1`)).toBe(1);
  });
});
