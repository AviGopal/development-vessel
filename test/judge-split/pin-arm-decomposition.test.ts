// BEHAVIOUR PIN: decomposition arming (judge split, extractions `decompositionRefusal` and `armDecomposition` out of
// decomposeGap, and the shared `parentPredicate`). For a scripted LLM proposal the arming decides which steps
// become child gaps `<parent>-step-<k>` (category decomposed_step), with what check, and what the parent's
// decomposition record says:
//   - depth refusal: a step (or a non-dissent child) is never decomposed again; no LLM call, no write;
//   - literal steps: the literal must be absent from the clone and the running tree, and the reader must be a
//     function in the file;
//   - refused changes: helper-only, silencing a detector or check, observation-only, a missing file, no falsifier;
//   - shape steps: advertised, not a write, no defect_field, a plain zero_field/nonzero_field, not the parent's own
//     check; RED BEFORE WRITE when the store is held here (the birth judge must read it 'present', and the child is
//     born with the minted verdict); deferred to the holder when the store is held elsewhere;
//   - never overwrite: an existing step is kept unless it was closed as superseded or rejected;
//   - a directed decomposition marks its steps directed;
//   - an unparseable proposal writes nothing; cannot_falsify is recorded as the reason.
// Driven through resolveGapToFeature({decompose_gap_id}) over stored rows, the LLM answering through the fetch
// router. Written against the tree before the extraction (which waits for F2; F2 is in this base); it must hold
// after it.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginPin, endPin, restoreHarness, seed, stored, metaOf, writesFor, store, route, hitsOf, tick, RUN, SCRATCH, STORE_URL, type Row } from "./harness.js";

const sg = await import("../../src/resolvers/substrate-gap.js");
const { DISCOVERY_SHAPES } = await import("../../src/config.js");
const { resolveGapToFeature } = await import("../../src/resolvers/gap-to-feature.js");

const VESSEL = `pinarm-${RUN}`;
const READER_SRC = "export function readerFn(x: string) { return x; }\nexport type ReaderType = { a: string };\n";
let n = 0;
/** A step file in the clone tree (where the arming reads it), optionally also in the running tree. */
function stepFile(clone: string = READER_SRC, running?: string): string {
  const rel = `src/arm-${++n}.ts`;
  mkdirSync(join(SCRATCH, "clones", VESSEL, "src"), { recursive: true });
  writeFileSync(join(SCRATCH, "clones", VESSEL, rel), clone);
  if (running !== undefined) {
    mkdirSync(join(SCRATCH, "runtime", VESSEL, "src"), { recursive: true });
    writeFileSync(join(SCRATCH, "runtime", VESSEL, rel), running);
  }
  return `repos/${VESSEL}/${rel}`;
}
function proposal(answer: unknown): void {
  route({ name: "llm", match: (u, b) => u.startsWith("http://llm.judge-pin") && b?.type === "llm_completion", respond: () => Response.json({ content: typeof answer === "string" ? answer : JSON.stringify(answer) }) });
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
const parentId = (tag: string) => `pin-arm-${tag}-${RUN}`;
function parent(tag: string, meta: Row = {}): string {
  const id = parentId(tag);
  seed({ id, summary: `decompose me ${tag}`, classification_metadata: { falsifier: "class2", edit_site: stepFile(), evidence_resolve: { shape: "pin_parent_shape", input: {}, zero_field: "n" }, ...meta } });
  return id;
}
const decompose = (id: string, extra: Row = {}) => tick(() => resolveGapToFeature({ type: "gap_to_feature", decompose_gap_id: id, ...extra } as never));
const literalStep = (site: string, change = "route the request through the guard", lit = `pinLiteral_${RUN}`, reader = "readerFn") => ({ edit_site: site, change, falsifier: { expected_literal: lit, reader } });
const shapeStep = (site: string, shape: string, er: Row = { zero_field: "defects" }) => ({ edit_site: site, change: "reject the malformed row", falsifier: { evidence_resolve: { shape, input: {}, ...er } } });

beforeEach(() => { beginPin(); routeDiscovery(); });
afterEach(() => { expect(endPin()).toEqual({ fetch: [], fs: [], exec: [] }); });
afterAll(() => restoreHarness());

describe("depth: a step is never decomposed again", () => {
  for (const [tag, meta, idSuffix] of [["child", { parent_gap_id: "pin-some-parent" }, ""], ["step", {}, "-step-2"]] as const) {
    it(`[PIN] ${tag}: refused before any LLM call; nothing written`, async () => {
      const id = `${parentId(tag)}${idSuffix}`;
      seed({ id, classification_metadata: { falsifier: "class1", edit_site: stepFile(), ...meta } });
      proposal({ steps: [literalStep(stepFile())] });
      const { result } = await decompose(id);
      expect(result.body).toEqual({ ok: false, stage: "decompose", gap_id: id, children: [], reason: "a decomposed step is not decomposed again" });
      expect(hitsOf("llm").length).toBe(0);
      expect(store.writes).toEqual([]);
    });
  }
});

describe("literal steps", () => {
  it("[PIN] a valid literal step is written as <parent>-step-1 with its own check and the cleared sentinels; the parent records it", async () => {
    const id = parent("lit-ok");
    const site = stepFile();
    proposal({ steps: [literalStep(site)] });
    const { result, lines } = await decompose(id);
    expect(result.body).toEqual({ ok: true, stage: "decompose", gap_id: id, children: [`${id}-step-1`], reason: "wrote 1 step(s)" });
    const child = stored(`${id}-step-1`)!;
    expect(child.category).toBe("decomposed_step");
    expect(child.source).toBe("substrate_detected");
    expect(child.status).toBe("open");
    expect(child.summary).toBe(`[step 1 of ${id}] route the request through the guard`);
    expect(child.classification_metadata).toEqual({
      edit_site: site, parent_gap_id: id, predicate_source: "decompose",
      hardcoded_url: "", predicate_derived_at: "", predicate_commit: "", pending_outcome_verification: "",
      evidence_resolve: null, verify_shape: "",
      expected_literal: `pinLiteral_${RUN}`, literal_reader: "readerFn",
    });
    const pm = metaOf(id);
    expect(typeof pm.decomposed_at).toBe("string");
    expect(pm.decomposition).toEqual({ children: [`${id}-step-1`], reason: "wrote 1 step(s)" });
    expect(writesFor(id).length).toBe(1);
    expect(lines).toContain(`[gap-decompose] ${id}: wrote 1 step(s)`);
    // The prompt carries the parent's own falsifier (parentPredicate, shared by the prompt and the arming).
    expect(String(hitsOf("llm")[0]!.body.prompt)).toContain(`ITS FALSIFIER: {"evidence_resolve":{"shape":"pin_parent_shape","input":{},"zero_field":"n"}}`);
  });

  for (const [tag, mk, why] of [
    ["lit-present", () => literalStep(stepFile(READER_SRC + `const pinLiteral_${RUN} = 1;\n`)), (s: Row) => `step 1: literal pinLiteral_${RUN} already present`],
    ["lit-running", () => literalStep(stepFile(READER_SRC, `const pinLiteral_${RUN} = 1;\n`)), () => `step 1: literal pinLiteral_${RUN} already present in the running tree`],
    ["reader-missing", () => literalStep(stepFile(), undefined, undefined, "noSuchReader"), (s: Row) => `step 1: reader noSuchReader not found in ${s.edit_site}`],
    ["reader-type", () => literalStep(stepFile(), undefined, undefined, "ReaderType"), (s: Row) => `step 1: reader ReaderType is not a function in ${s.edit_site}`],
    ["helper-only", () => literalStep(stepFile(), "add a helper function for the guard"), () => "step 1: only adds a helper nothing calls, which the compose gate refuses as hollow"],
    ["silence", () => literalStep(stepFile(), "disable the stale detector"), () => "step 1: would silence a detector or check"],
    ["observation", () => literalStep(stepFile(), "log the malformed rows"), () => "step 1: observation-only change"],
    ["no-file", () => literalStep(`repos/${VESSEL}/src/missing-${RUN}.ts`), (s: Row) => `step 1: ${s.edit_site} does not exist`],
    ["not-source", () => literalStep(`repos/${VESSEL}/README.md`), () => "step 1: no single source file or no change"],
    ["no-falsifier", () => ({ edit_site: stepFile(), change: "route the request through the guard", falsifier: {} }), () => "step 1: no machine-checkable falsifier"],
  ] as const) {
    it(`[PIN] refused (${tag}): no child; the parent records the refusal`, async () => {
      const id = parent(tag);
      const step = (mk as () => Row)();
      proposal({ steps: [step] });
      const { result } = await decompose(id);
      const reason = `no valid step: ${(why as (s: Row) => string)(step)}`;
      expect(result.body).toEqual({ ok: false, stage: "decompose", gap_id: id, children: [], reason });
      expect(stored(`${id}-step-1`)).toBeUndefined();
      expect(metaOf(id).decomposition).toEqual({ children: [], reason });
    });
  }

  it("[PIN] mixed: steps are numbered by position; a refused step leaves its number unused", async () => {
    const id = parent("mixed");
    const good = stepFile();
    proposal({ steps: [literalStep(stepFile(), "log the rows"), literalStep(good), literalStep(stepFile(), "x", `pinOther_${RUN}`, "noSuchReader")] });
    const { result } = await decompose(id);
    expect((result.body as Row).children).toEqual([`${id}-step-2`]);
    expect((result.body as Row).reason).toMatch(/^wrote 1 step\(s\); refused: step 1: observation-only change; step 3: reader noSuchReader not found in /);
  });
});

describe("shape steps (store held elsewhere: the red-before-write judgement is deferred to the holder)", () => {
  it("[PIN] an advertised shape with a plain zero_field is written with its evidence_resolve", async () => {
    const id = parent("shape-ok");
    const shape = `pin_shape_ok_${RUN}`;
    advertised.add(shape);
    const site = stepFile();
    proposal({ steps: [shapeStep(site, shape)] });
    const { result } = await decompose(id);
    expect((result.body as Row).children).toEqual([`${id}-step-1`]);
    const m = metaOf(`${id}-step-1`);
    expect(m.evidence_resolve).toEqual({ shape, input: {}, zero_field: "defects" });
    expect(m.expected_literal).toBe("");
    expect(m.literal_reader).toBe("");
    expect(m.verify_shape).toBe("");
  });

  for (const [tag, mk, why] of [
    ["not-advertised", (site: string) => shapeStep(site, `pin_shape_unadv_${RUN}`), () => `step 1: shape pin_shape_unadv_${RUN} is not advertised`],
    ["write-shape", (site: string) => shapeStep(site, `pin_shape_${RUN}_write`), () => `step 1: shape pin_shape_${RUN}_write is a write, not a read`],
    ["defect-field", (site: string) => shapeStep(site, `pin_shape_df_${RUN}`, { defect_field: "bad" }), () => "step 1: a defect_field check is refused: a missing key reads as fixed"],
    ["no-field", (site: string) => shapeStep(site, `pin_shape_nf_${RUN}`, {}), () => "step 1: its shape check names no zero_field/nonzero_field, so it could never be judged"],
    ["path-field", (site: string) => shapeStep(site, `pin_shape_pf_${RUN}`, { zero_field: "entries.length" }), () => "step 1: its shape check names no zero_field/nonzero_field, so it could never be judged"],
    ["parents-own", (site: string) => ({ edit_site: site, change: "reject the malformed row", falsifier: { evidence_resolve: { shape: "pin_parent_shape", input: {}, zero_field: "m" } } }), () => "step 1: its falsifier is the parent's own check, which one step will not flip"],
  ] as const) {
    it(`[PIN] refused (${tag})`, async () => {
      const id = parent(tag);
      for (const s of [`pin_shape_${RUN}_write`, `pin_shape_df_${RUN}`, `pin_shape_nf_${RUN}`, `pin_shape_pf_${RUN}`, "pin_parent_shape"]) advertised.add(s);
      proposal({ steps: [(mk as (s: string) => Row)(stepFile())] });
      const { result } = await decompose(id);
      expect((result.body as Row).reason).toBe(`no valid step: ${(why as () => string)()}`);
      expect(stored(`${id}-step-1`)).toBeUndefined();
    });
  }
});

describe("never overwrite a step", () => {
  it("[PIN] an existing open step is kept; a step closed as superseded is replaced", async () => {
    const id = parent("overwrite");
    seed({ id: `${id}-step-1`, status: "open", classification_metadata: { expected_literal: "keepMe" } });
    seed({ id: `${id}-step-2`, status: "closed", classification_metadata: { closed_reason: "superseded by a better step" } });
    proposal({ steps: [literalStep(stepFile()), literalStep(stepFile(), undefined, `pinTwo_${RUN}`)] });
    const { result } = await decompose(id);
    expect((result.body as Row).children).toEqual([`${id}-step-2`]);
    expect((result.body as Row).reason).toBe(`wrote 1 step(s); refused: step 1: ${id}-step-1 already exists; not overwritten`);
    expect(metaOf(`${id}-step-1`).expected_literal).toBe("keepMe");
    expect(stored(`${id}-step-2`)!.status).toBe("open");
    expect(metaOf(`${id}-step-2`).expected_literal).toBe(`pinTwo_${RUN}`);
  });
});

describe("directed, unparseable, cannot_falsify", () => {
  it("[PIN] a directed decomposition marks its steps directed", async () => {
    const id = parent("directed");
    proposal({ steps: [literalStep(stepFile())] });
    await decompose(id, { directed: true });
    expect(metaOf(`${id}-step-1`).directed).toBe(true);
  });
  it("[CONTROL] undirected: no directed key", async () => {
    const id = parent("undirected");
    proposal({ steps: [literalStep(stepFile())] });
    await decompose(id);
    expect("directed" in metaOf(`${id}-step-1`)).toBe(false);
  });
  it("[PIN] an unparseable proposal writes nothing, not even the parent record", async () => {
    const id = parent("unparseable");
    proposal("no json here");
    const { result } = await decompose(id);
    expect(result.body).toEqual({ ok: false, stage: "decompose", gap_id: id, children: [], reason: "unparseable decomposition" });
    expect(store.writes).toEqual([]);
  });
  it("[PIN] cannot_falsify with no steps: recorded as the reason on the parent", async () => {
    const id = parent("cannot");
    proposal({ steps: [], cannot_falsify: "the defect is a design choice" });
    const { result } = await decompose(id);
    expect((result.body as Row).reason).toBe("cannot_falsify: the defect is a design choice");
    expect(metaOf(id).decomposition).toEqual({ children: [], reason: "cannot_falsify: the defect is a design choice" });
  });
});

describe("red before write, with the store held here (GAP_STORE_ENDPOINT unset; the shared store under a temp root)", () => {
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
  // A CHECK THAT IS BORN WITH A VERDICT must name a shape the write-time classifier does not call unadvertised.
  // That classifier scans the fleet's config.ts files at load-time roots (/vessels, the super-repo clone, the push
  // clones): on a host none exist, the scan is not judgeable and it fails open; in the container it reads the live
  // fleet, where an invented shape is "unresolvable" (an inert predicate) and the seam ignores any birth verdict for
  // it. A shape this vessel advertises (DISCOVERY_SHAPES, always in the vocabulary) reads the same in both.
  const ownShape = (name: string): string => {
    if (!DISCOVERY_SHAPES.includes(name)) throw new Error(`fixture shape ${name} is no longer in development-vessel's DISCOVERY_SHAPES; pick another advertised read shape`);
    return name;
  };
  const readLocal = async (id: string): Promise<Row | null> => (((await sg.resolveSubstrateGap({ type: "substrateGap", id } as never)).body as { gaps?: Row[] }).gaps ?? []).find((g) => g.id === id) ?? null;
  async function putParent(tag: string): Promise<string> {
    const id = parentId(tag);
    const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: "2026-10-01T00:00:00.000Z", summary: `decompose me ${tag}`, classification_metadata: { edit_site: stepFile() } } } as never);
    if (w.shape === "structuredError") throw new Error(JSON.stringify(w.body));
    return id;
  }

  it("[PIN] the birth judge reads the step's check 'present': written, born with that verdict", async () => {
    const judged: Row[] = [];
    sg.__setBirthJudgeForTests(async (g) => { judged.push(g); return "present"; });
    const id = await putParent("red-present");
    const shape = ownShape("fossil_rank_report");
    advertised.add(shape);
    proposal({ steps: [shapeStep(stepFile(), shape)] });
    const { result } = await decompose(id);
    expect((result.body as Row).children).toEqual([`${id}-step-1`]);
    expect(judged.some((g) => g.id === `${id}-step-1`)).toBe(true);
    await sg.__settleBirthEvaluationsForTests();
    const child = await readLocal(`${id}-step-1`);
    expect(child?.classification_metadata?.predicate_birth_verdict).toBe("present");
  });

  for (const verdict of ["absent", "unknown"] as const) {
    it(`[PIN] the birth judge reads it '${verdict}': refused, no child written`, async () => {
      sg.__setBirthJudgeForTests(async () => verdict);
      const id = await putParent(`red-${verdict}`);
      const shape = `pin_shape_red_${verdict}_${RUN}`;
      advertised.add(shape);
      proposal({ steps: [shapeStep(stepFile(), shape)] });
      const { result } = await decompose(id);
      expect((result.body as Row).reason).toBe(`no valid step: step 1: its check reads ${verdict} on the current tree, not present`);
      expect(await readLocal(`${id}-step-1`)).toBeNull();
    });
  }

  // PARENT-CHECK MODE (k=0) is reached through decomposeGap(gap, {parentCheck: true}), the residue entry
  // gap-lifecycle-scan calls; decompose_gap_id never asks for it.
  describe("parent-check mode (decomposeGap with parentCheck, as gap-lifecycle-scan calls it)", () => {
    const decomposeParentCheck = async (id: string) => {
      const { decomposeGap } = await import("../../src/resolvers/gap-to-feature.js");
      const row = await readLocal(id);
      return tick(() => decomposeGap(row!, { parentCheck: true }));
    };
    it("[PIN] a valid parent check read 'present' is written onto the parent with its verdict; a step restating it is refused", async () => {
      sg.__setBirthJudgeForTests(async () => "present");
      const id = await putParent("pc-ok");
      const shape = ownShape("vessel_exercise_scan");
      advertised.add(shape);
      const pc = { evidence_resolve: { shape, input: {}, zero_field: "defects" } };
      proposal({ parent_check: pc, steps: [{ edit_site: stepFile(), change: "reject the malformed row", falsifier: pc }] });
      const { result } = await decomposeParentCheck(id);
      expect(result.parent_check).toBe("written");
      expect(result.written).toEqual([]);
      expect(result.reason).toBe("wrote the parent's own check; no valid step: step 1: its falsifier is the parent's own check, which one step will not flip");
      await sg.__settleBirthEvaluationsForTests();
      const m = (await readLocal(id))!.classification_metadata as Row;
      expect(m.evidence_resolve).toEqual(pc.evidence_resolve);
      expect(m.predicate_source).toBe("gap_falsify:parent_check");
      expect(m.verify_shape).toBe("");
      expect(typeof m.falsified_at).toBe("string");
      expect((m.decomposition as Row).parent_check).toBe("written");
      expect(m.predicate_birth_verdict).toBe("present");
    });
    for (const [tag, pcAnswer, verdict, note] of [
      ["pc-literal", { expected_literal: "someLiteral" }, "present", "parent check: a literal is not a parent check (a word absent now is trivially red)"],
      ["pc-none", null, "present", "parent check: none proposed"],
      ["pc-absent", "SHAPE", "absent", "parent check: its check reads absent on the current tree, not present"],
    ] as const) {
      it(`[PIN] ${tag}: the parent's check is not written; the note is recorded`, async () => {
        sg.__setBirthJudgeForTests(async () => verdict);
        const id = await putParent(tag);
        const shape = `pin_shape_${tag.replace(/-/g, "_")}_${RUN}`;
        advertised.add(shape);
        proposal({ parent_check: pcAnswer === "SHAPE" ? { evidence_resolve: { shape, input: {}, zero_field: "defects" } } : pcAnswer, steps: [] });
        const { result } = await decomposeParentCheck(id);
        expect(result.parent_check).toBe(note);
        const m = (await readLocal(id))!.classification_metadata as Row;
        expect(m.evidence_resolve).toBeUndefined();
        expect((m.decomposition as Row).parent_check).toBe(note);
      });
    }
  });
});
