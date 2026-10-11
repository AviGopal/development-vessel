// BEHAVIOUR PIN: THE DECOMPOSITION ARMING HOLDS ITS OWN GATES (judge split, qa amendment to A2).
//
// The closed armDecomposition used to rely on two things only the residue's decomposeGap did or could change:
//   1. the depth refusal (a step, or a non-dissent child, is never decomposed again) ran only in decomposeGap,
//      before the LLM call. Dropping that one residue line would let a step be armed again;
//   2. a caller-supplied judge (DecomposeDeps.judge, forwarded by decomposeGap) replaced the red-before-write
//      judge.
// Now the arming refuses a step itself, first, before any read or write, with the same function and so the same
// reason as the residue's pre-check. It reads no caller-supplied judge: its verdict is always the seam's
// (takeBirthVerdictWithReport), which tests replace only through substrate-gap's closed __setBirthJudgeForTests
// (F2's one pattern). The residue's pre-check stays as the cost short-circuit before the LLM call.
// Mutants, each seen red: the arming's own refusal call dropped (the direct arm writes a child); the residue's
// pre-check dropped (the LLM is called for a step); the arming reading opts.deps.judge again (the injected
// 'present' arms a check the seam's judge reads absent).
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginPin, endPin, restoreHarness, seed, store, route, hitsOf, tick, RUN, SCRATCH, STORE_URL, type Row } from "./harness.js";

const sg = await import("../../src/resolvers/substrate-gap.js");
const { decomposeGap } = await import("../../src/resolvers/gap-to-feature.js");
const { armDecomposition, decompositionRefusal } = await import("../../src/judge/gap-admission.js");

const VESSEL = `pinarmgate-${RUN}`;
const READER_SRC = "export function readerFn(x: string) { return x; }\n";
let n = 0;
function stepFile(): string {
  const rel = `src/armgate-${++n}.ts`;
  mkdirSync(join(SCRATCH, "clones", VESSEL, "src"), { recursive: true });
  writeFileSync(join(SCRATCH, "clones", VESSEL, rel), READER_SRC);
  return `repos/${VESSEL}/${rel}`;
}
function proposal(answer: unknown): void {
  route({ name: "llm", match: (u, b) => u.startsWith("http://llm.judge-pin") && b?.type === "llm_completion", respond: () => Response.json({ content: JSON.stringify(answer) }) });
}
const advertised = new Set<string>();
function routeDiscovery(): void {
  route({ name: "shape descriptions", match: (u) => { try { return new URL(u).pathname === "/registry/shape-descriptions"; } catch { return false; } }, respond: () => Response.json({ shape_descriptions: {} }) });
  route({
    name: "discovery advertised",
    match: (_u, b) => b?.pointer?.type === "vesselCapability" && advertised.has(String(b.pointer.shape)),
    respond: (_u, b) => Response.json({ content: { shape: b.pointer.shape, vessels: [{ vesselId: "producer-fixture", endpoint: "http://producer.judge-pin", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } }),
  });
}
const literalStep = (site: string) => ({ edit_site: site, change: "route the request through the guard", falsifier: { expected_literal: `pinGateLiteral_${RUN}`, reader: "readerFn" } });
const REASON = "a decomposed step is not decomposed again";

beforeEach(() => { beginPin(); routeDiscovery(); });
afterEach(() => { expect(endPin()).toEqual({ fetch: [], fs: [], exec: [] }); });
afterAll(() => restoreHarness());

describe("the depth refusal is the arming's own, first, with the residue pre-check's reason", () => {
  for (const [tag, meta, suffix] of [["child", { parent_gap_id: "pin-some-parent" }, ""], ["step", {}, "-step-2"]] as const) {
    it(`[MUST-FAIL] ${tag}: a DIRECT arm is refused before any read or write; nothing written`, async () => {
      const id = `pin-armgate-direct-${tag}-${RUN}${suffix}`;
      const row = seed({ id, classification_metadata: { falsifier: "class1", edit_site: stepFile(), ...meta } });
      const r = await armDecomposition(row, { steps: [literalStep(stepFile())] });
      expect(r).toEqual({ written: [], reason: REASON });
      expect(store.writes).toEqual([]);
      expect(store.rows.has(`${id}-step-1`)).toBe(false);
    });

    it(`[MUST-FAIL] ${tag}: the residue's pre-check refuses before the LLM call, with the identical reason`, async () => {
      const id = `pin-armgate-pre-${tag}-${RUN}${suffix}`;
      const row = seed({ id, classification_metadata: { falsifier: "class1", edit_site: stepFile(), ...meta } });
      proposal({ steps: [literalStep(stepFile())] });
      const { result: viaResidue } = await tick(() => decomposeGap(row));
      const viaGate = await armDecomposition(row, { steps: [literalStep(stepFile())] });
      // One reason on both paths, and it is the refusal function's own: the pre-check and the gate cannot drift.
      expect(decompositionRefusal(row)).toBe(REASON);
      expect(viaResidue).toEqual({ written: [], reason: REASON });
      expect(viaGate).toEqual(viaResidue);
      expect(hitsOf("llm").length).toBe(0);
      expect(store.writes).toEqual([]);
    });
  }

  it("[CONTROL] a top-level gap is not refused: the direct arm writes its step", async () => {
    const id = `pin-armgate-top-${RUN}`;
    const row = seed({ id, classification_metadata: { falsifier: "class1", edit_site: stepFile() } });
    expect(decompositionRefusal(row)).toBeNull();
    const r = await armDecomposition(row, { steps: [literalStep(stepFile())] });
    expect(r.written).toEqual([`${id}-step-1`]);
  });
});

describe("no caller-supplied judge: the seam's judge decides (store held here)", () => {
  let storeFile = "";
  let storeBefore: string | null = null;
  beforeEach(() => {
    delete process.env["GAP_STORE_ENDPOINT"];
    const root = sg.gapStoreRootForTest();
    if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir; refusing to write it`);
    storeFile = join(root, "gaps", "gaps.json");
    try { storeBefore = readFileSync(storeFile, "utf8"); } catch { storeBefore = null; }
    mkdirSync(join(root, "gaps"), { recursive: true });
  });
  afterEach(async () => {
    sg.__setBirthJudgeForTests(null);
    await sg.__settleBirthEvaluationsForTests();
    if (storeBefore === null) rmSync(storeFile, { force: true }); else writeFileSync(storeFile, storeBefore);
    process.env["GAP_STORE_ENDPOINT"] = STORE_URL;
  });
  const readLocal = async (id: string): Promise<Row | null> => (((await sg.resolveSubstrateGap({ type: "substrateGap", id } as never)).body as { gaps?: Row[] }).gaps ?? []).find((g) => g.id === id) ?? null;
  async function putParent(tag: string): Promise<Row> {
    const id = `pin-armgate-${tag}-${RUN}`;
    const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: "2026-10-01T00:00:00.000Z", summary: `decompose me ${tag}`, classification_metadata: { edit_site: stepFile() } } } as never);
    if (w.shape === "structuredError") throw new Error(JSON.stringify(w.body));
    return (await readLocal(id))!;
  }
  const shapeStep = (shape: string) => ({ edit_site: stepFile(), change: "reject the malformed row", falsifier: { evidence_resolve: { shape, input: {}, zero_field: "defects" } } });

  for (const [tag, call] of [
    ["decomposeGap forwarding it", (row: Row, judge: unknown, parsed: Row) => { proposal(parsed); return decomposeGap(row, { deps: { judge } } as never); }],
    ["a direct arm passing it", (row: Row, judge: unknown, parsed: Row) => armDecomposition(row, parsed, { deps: { judge } } as never)],
  ] as const) {
    it(`[MUST-FAIL] ${tag}: an injected 'present' is never consulted; the seam's judge reads absent and nothing is armed`, async () => {
      const seamJudged: string[] = [];
      sg.__setBirthJudgeForTests(async (g) => { seamJudged.push(String(g.id)); return "absent"; });
      let injected = 0;
      const judge = async () => { injected++; return "present"; };
      const row = await putParent(`inject-${tag.split(" ")[0]}`);
      const shape = `pin_gate_inject_${tag.split(" ")[0]}_${RUN}`;
      advertised.add(shape);
      const { result } = await tick(() => (call as (r: Row, j: unknown, p: Row) => Promise<{ written: string[]; reason: string }>)(row, judge, { steps: [shapeStep(shape)] }));
      expect(injected).toBe(0);
      expect(seamJudged).toContain(`${row.id}-step-1`);
      expect(result.written).toEqual([]);
      expect(result.reason).toBe("no valid step: step 1: its check reads absent on the current tree, not present");
      expect(await readLocal(`${row.id}-step-1`)).toBeNull();
    });
  }
});
