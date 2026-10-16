// A DECOMPOSITION'S REFUSALS ARE NEVER HIDDEN, AND ITS CHILDREN ACCUMULATE (CHANGE-37c; user ruling 2026-10-16T20:05:03Z).
//
// (1) When nothing was written, ANY non-empty cannot_falsify replaced the step refusals in the reason, so an LLM's "none"
//     masked why every step was refused. (2) The parent write set decomposition.children = written FRESH, so any
//     re-decomposition (an all-refused one included) replaced the prior list: the gapDecomposition route's prior_children
//     under-counted the next call, and its `created` (written minus prior children) reported a step re-written after the
//     wipe as NEW, which CHANGE-35's reach oracle counts as the investigation's product.
//   [MUST-FAIL] prior children [s1, s2]; a re-decomposition rewrites s1 (superseded) and refuses s2 (already exists):
//               children stay [s1, s2], and s1 is not "created" by this call (it was a prior child).
//   [MUST-FAIL] an all-refused decomposition with cannot_falsify "none": the reason carries the real refusal (a step
//               file that does not exist — a refusal that must stay red).
//   [CONTROL]   a cannot_falsify is recorded verbatim alongside the refusals; with no refusals it is the reason, as before;
//               a first decomposition's children are what it wrote.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginPin, endPin, restoreHarness, seed, metaOf, route, tick, RUN, SCRATCH, type Row } from "./harness.js";

const { resolveGapToFeature } = await import("../../src/resolvers/gap-to-feature.js");

const VESSEL = `armacc-${RUN}`;
const READER_SRC = "export function readerFn(x: string) { return x; }\n";
let n = 0;
function stepFile(): string {
  const rel = `src/armacc-${++n}.ts`;
  mkdirSync(join(SCRATCH, "clones", VESSEL, "src"), { recursive: true });
  writeFileSync(join(SCRATCH, "clones", VESSEL, rel), READER_SRC);
  return `repos/${VESSEL}/${rel}`;
}
function proposal(answer: unknown): void {
  route({ name: "llm", match: (u, b) => u.startsWith("http://llm.judge-pin") && b?.type === "llm_completion", respond: () => Response.json({ content: JSON.stringify(answer) }) });
  route({ name: "shape descriptions", match: (u) => { try { return new URL(u).pathname === "/registry/shape-descriptions"; } catch { return false; } }, respond: () => Response.json({ shape_descriptions: {} }) });
}
const pid = (tag: string) => `armacc-${tag}-${RUN}`;
function parent(tag: string, meta: Row = {}): string {
  const id = pid(tag);
  seed({ id, summary: `decompose me ${tag}`, classification_metadata: { falsifier: "class2", edit_site: stepFile(), evidence_resolve: { shape: "pin_parent_shape", input: {}, zero_field: "n" }, ...meta } });
  return id;
}
const decompose = (id: string) => tick(() => resolveGapToFeature({ type: "gap_to_feature", decompose_gap_id: id } as never));
const literalStep = (site: string) => ({ edit_site: site, change: "route the request through the guard", falsifier: { expected_literal: `armAccLiteral_${RUN}_${++n}`, reader: "readerFn" } });
const reasonOf = (r: unknown) => String(((r as { body?: { reason?: unknown } }).body ?? {}).reason ?? "");

beforeEach(() => { beginPin(); });
afterEach(() => { expect(endPin()).toEqual({ fetch: [], fs: [], exec: [] }); });
afterAll(() => restoreHarness());

describe("refusals are kept, children accumulate", () => {
  it("[MUST-FAIL] a re-decomposition keeps the prior children; a re-written prior step is not created by this call", async () => {
    const id = pid("redo");
    const s1 = `${id}-step-1`, s2 = `${id}-step-2`;
    seed({ id: s1, status: "superseded", summary: "old step 1", classification_metadata: { parent_gap_id: id, closed_reason: "superseded" } });
    seed({ id: s2, status: "open", summary: "old step 2", classification_metadata: { parent_gap_id: id } });
    parent("redo", { decomposition: { children: [s1, s2], reason: "wrote 2 step(s)" } });
    proposal({ steps: [literalStep(stepFile()), literalStep(stepFile())] });
    const { result } = await decompose(id);
    const written = ((result as { body?: { children?: string[] } }).body?.children ?? []);
    expect(written).toEqual([s1]);
    expect(reasonOf(result)).toContain(`${s2} already exists`);
    expect(((metaOf(id).decomposition ?? {}) as { children?: string[] }).children).toEqual([s1, s2]);
  });

  it("[MUST-FAIL] an all-refused decomposition with cannot_falsify \"none\" keeps the real refusal", async () => {
    const id = parent("none");
    proposal({ steps: [{ edit_site: `repos/${VESSEL}/src/absent-${RUN}.ts`, change: "route the request through the guard", falsifier: { expected_literal: `armAccAbsent_${RUN}`, reader: "readerFn" } }], cannot_falsify: "none" });
    const { result } = await decompose(id);
    expect(reasonOf(result)).toMatch(/^no valid step: .*does not exist/);
  });

  it("[PARAPHRASE] however the decomposer words 'nothing to say', the refusal leads the reason (no wording is judged)", async () => {
    for (const [i, cf] of ["None.", "no", "N/A", "false", "nothing", "there is nothing further to add here"].entries()) {
      const id = parent(`para${i}`);
      proposal({ steps: [{ edit_site: `repos/${VESSEL}/src/absent-p${i}-${RUN}.ts`, change: "route the request through the guard", falsifier: { expected_literal: `armAccPara${i}_${RUN}`, reader: "readerFn" } }], cannot_falsify: cf });
      const { result } = await decompose(id);
      expect(reasonOf(result)).toMatch(/^no valid step: .*does not exist/);
      expect(reasonOf(result)).toContain(`; cannot_falsify: ${cf}`);
    }
  });

  it("[HELD-OUT] a refusal of another kind (a step in a vessel this tree does not hold) is never replaced either", async () => {
    const id = parent("held");
    proposal({ steps: [{ edit_site: `repos/held-out-vessel-${RUN}/src/x.ts`, change: "route the request through the guard", falsifier: { expected_literal: `armAccHeld_${RUN}`, reader: "readerFn" } }], cannot_falsify: "none" });
    const { result } = await decompose(id);
    expect(reasonOf(result)).toMatch(/^no valid step: /);
    expect(reasonOf(result)).not.toMatch(/^cannot_falsify/);
  });

  it("[CONTROL] prose cannot_falsify sits alongside the refusals; alone, it is the reason; a first decomposition's children are what it wrote", async () => {
    const a = parent("prose");
    proposal({ steps: [{ edit_site: `repos/${VESSEL}/src/absent2-${RUN}.ts`, change: "route the request through the guard", falsifier: { expected_literal: `armAccAbsent2_${RUN}`, reader: "readerFn" } }], cannot_falsify: "the defect is a design choice" });
    const ra = await decompose(a);
    expect(reasonOf(ra.result)).toContain("does not exist");
    expect(reasonOf(ra.result)).toContain("cannot_falsify: the defect is a design choice");
    const b = parent("alone");
    proposal({ steps: [], cannot_falsify: "the defect is a design choice" });
    expect(reasonOf((await decompose(b)).result)).toBe("cannot_falsify: the defect is a design choice");
    const c = parent("first");
    proposal({ steps: [literalStep(stepFile())] });
    await decompose(c);
    expect(((metaOf(c).decomposition ?? {}) as { children?: string[] }).children).toEqual([`${c}-step-1`]);
  });
});
