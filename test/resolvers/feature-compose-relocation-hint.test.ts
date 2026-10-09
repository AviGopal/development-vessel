// A DRAFT THAT DOES NOT MOVE ITS OWN CHECK MUST LEAVE A RELOCATION HINT (check-first).
//
// Measured on node 1, 2026-10-03 06:03-08:13Z: the largest consumer of compose time (about 42 min,
// 7 composes) was one concept-db gap whose class-2 check exercises an advertising list in config.ts
// while its edit_site is routes/impulses.ts. Every attempt failed the check identically with and
// without its edit (no_effect_vs_parent:true), repair wrote nothing, and the next attempt went back
// to the same file: suspected_real_location is written only by the semantic gate, which runs only on
// a FAVORABLE verdict, which a red own check never reaches. So localizeGap kept the edit_site and the
// file-scope gate DROPPED the edits to the file that needed changing ("file-scope gate: DROPPED 3
// off-target edit op(s) [repos/concept-db/src/config.ts]"), silently.
//
// Expected:
//   - a no-effect own check derives a RELOCATION hint from the check's own evidence: the source module
//     the FAILING ASSERTION exercises, i.e. where the failing test's imports resolve (qa ruling: not the
//     draft's file, not arbitrary stack frames), excluding test files and the current edit_site; it is
//     written to the gap as classification_metadata.relocation_hint {files, derived_from, at};
//   - the next attempt's localization reads it, and the file-scope gate ADMITS the hinted file;
//   - a hinted file inside the autonomy scope's excluded_paths is not composed: the gap keeps the hint
//     and carries an operator routing marker;
//   - a file-scope drop is RECORDED (dropped_paths + reason), never silent;
//   - a check that moved, or whose failing assertion exercises nothing new, writes no hint;
//   - without a hint the gate stays strict.
// The hint is DERIVED from evidence only: the generality test puts the module at an arbitrary path.
//
// Round 2 (qa): the runtime tree is an image layer that omits most test/ files, so the check's test file
// is read from the vessel clone (VESSELS_CLONE_ROOT), never from the runtime tree; a FAVORABLE compose that
// dropped an op says so on its landing evidence; a compose whose every op was dropped does not land
// (no_effect class); the hint write is a merge (only relocation_hint), not a whole-row replace.
//
// Seams. Real appendComposeLesson, localizeGap and admitActionableGaps against two fixture trees: the
// runtime tree (MITOSIS_RUNTIME_DIR / MITOSIS_REPO_ROOT: sources, no tests) and the vessel clone
// (VESSELS_CLONE_ROOT: sources and tests), both read at call time. The gap store is the real store module
// forwarding through GAP_STORE_ENDPOINT to an in-memory fixture store (the cutover-stale-base pattern):
// its file root is captured at module load, so under a full `bun test` it is whichever root the first
// importer saw, the repo itself when WORKSPACE_ROOT is unset. The fixture store carries omitted
// classification_metadata keys forward like the real one (substrate-gap.ts, the carry-forward loop) and
// records every write payload, so the merge-style write is asserted on the PAYLOAD. globalThis.fetch is
// replaced for the store, discovery, the policy pool and the concept-db mirror (the compose-lesson-store /
// gap-to-feature-admission pattern; no mock.module). "The runtime tree is never read for test files" is
// asserted behaviourally: the runtime holds a STALE copy of a check that imports a different module, and
// a check present only in the runtime tree yields no hint.
//
// Seams that do not exist yet are reached as optional exports, so their absence reads as a red assertion,
// never a skip: deriveRelocationHint, composeTargetFiles, fileScopeGate and composeLandingEvidence (all
// feature-compose). The file-scope gate and the landing evidence are inline in resolveFeatureCompose today
// (the evidence is the evaluation_evidence literal handed to vessel_mitosis_cutover), so the landing
// contract is pinned on fileScopeGate's return plus composeLandingEvidence, not on a driven compose. The
// tests named CONTRACT are red at base only because their function does not exist yet.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

// The runtime tree is this file's own temp root, also where feature-compose's load-time RUNTIME_ROOT /
// REPO_ROOT point whatever loaded the module first (test/helpers/runtime-root.ts; refuses when it cannot).
const { root: ROOT, runtime: VESSELS } = await isolateRuntimeRoot("reloc-hint", { who: "feature-compose-relocation-hint.test.ts" });
const CLONE = join(ROOT, "clone");
const savedEnv: Record<string, string | undefined> = {};
for (const k of ["MITOSIS_RUNTIME_DIR", "MITOSIS_REPO_ROOT", "VESSELS_CLONE_ROOT", "GAP_STORE_ENDPOINT"]) savedEnv[k] = process.env[k];
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const FIXTURE_GAP_STORE = "http://gap-store.reloc-fixture/v2/impulses/resolve";
const setTreeEnv = (): void => {
  process.env["MITOSIS_RUNTIME_DIR"] = VESSELS;
  process.env["MITOSIS_REPO_ROOT"] = VESSELS;
  process.env["VESSELS_CLONE_ROOT"] = CLONE;
  process.env["GAP_STORE_ENDPOINT"] = FIXTURE_GAP_STORE; // never the module-load-captured file store
};
setTreeEnv();

const sg = await import("../../src/resolvers/substrate-gap.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js");
const fc = await import("../../src/resolvers/feature-compose.js");
const RUN = Math.random().toString(36).slice(2, 8);

// ─── the fixture vessel ─────────────────────────────────────────────────────
const VESSEL = `reloc-fixture-${RUN}-vessel`;
const repo = (rel: string): string => `repos/${VESSEL}/${rel}`;
// Sources go to both trees; a test file goes to the clone only (the runtime image layer omits test/).
const putIn = (root: string, rel: string, text: string): void => {
  const abs = join(root, VESSEL, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
};
const isTestPath = (rel: string): boolean => /(^|\/)(tests?|__tests__)\//.test(rel) || /\.test\.[cm]?[jt]sx?$/.test(rel);
const put = (rel: string, text: string): void => {
  putIn(CLONE, rel, text);
  if (!isTestPath(rel)) putIn(VESSELS, rel, text);
};
const cloneRoot = join(CLONE, VESSEL);
// A: the gap's edit_site. B: the module the failing assertion exercises. C: a file that appears only in
// the failure's printed text (a decoy: the hint follows the assertion's import, not the log).
const A = "src/routes/handler.ts";
const B = "src/settings/advertised.ts";
const C = "src/util/frame-only.ts";
const OWN_TEST = "test/own-check.test.ts";
const MOVED_TEST = "test/own-check-site-only.test.ts";
// D: the module a STALE runtime-tree copy of a check imports (the clone's copy imports B).
const D = "src/legacy/decoy.ts";
const STALE_TEST = "test/stale-in-runtime.test.ts";
const RUNTIME_ONLY_TEST = "test/runtime-only.test.ts";
const ownCheckSource = (modulePath: string, fnName: string): string => [
  `import { describe, it, expect } from "bun:test";`,
  `import { handle } from "../src/routes/handler.js";`,
  `import { ${fnName} } from "../${modulePath.replace(/\.ts$/, ".js")}";`,
  `import { fixtureRows } from "./helpers/rows.js";`,
  ``,
  `describe("own check", () => {`,
  `  it("the handler answers a known shape", () => {`,
  `    expect(handle("alpha")).toBe(true);`,
  `  });`,
  `  it(${JSON.stringify("the advertised list names the shape the handler serves")}, () => {`,
  `    expect(${fnName}()).toContain(fixtureRows()[0]);`,
  `  });`,
  `});`,
  ``,
].join("\n");
const FAILING_B = "the advertised list names the shape the handler serves";
const FAILING_A_ONLY = "the handler answers the shape its helper rows name";

beforeAll(() => {
  put("package.json", JSON.stringify({ name: VESSEL }));
  put(A, `export function handle(shape: string): boolean { return shape.length > 0; }\n`);
  put(B, `export function advertisedShapes(): string[] { return ["alpha"]; }\n`);
  put(C, `export const frameOnly = 1;\n`);
  put(D, `export function legacyShapes(): string[] { return []; }\n`);
  // The stale copy in the runtime tree imports D; the clone's (the check that actually runs) imports B.
  putIn(VESSELS, STALE_TEST, ownCheckSource(D, "legacyShapes"));
  putIn(CLONE, STALE_TEST, ownCheckSource(B, "advertisedShapes"));
  // Present ONLY in the runtime tree: reading it would be reading the runtime tree for a test file.
  putIn(VESSELS, RUNTIME_ONLY_TEST, ownCheckSource(B, "advertisedShapes"));
  put("test/helpers/rows.ts", `export function fixtureRows(): string[] { return ["beta"]; }\n`);
  put(OWN_TEST, [
    `import { describe, it, expect } from "bun:test";`,
    `import { handle } from "../src/routes/handler.js";`,
    `import { advertisedShapes } from "../src/settings/advertised.js";`,
    `import { fixtureRows } from "./helpers/rows.js";`,
    ``,
    `describe("own check", () => {`,
    `  it("the handler answers a known shape", () => {`,
    `    expect(handle("alpha")).toBe(true);`,
    `  });`,
    `  it(${JSON.stringify(FAILING_B)}, () => {`,
    `    expect(advertisedShapes()).toContain(fixtureRows()[0]);`,
    `  });`,
    `});`,
    ``,
  ].join("\n"));
  // The failing assertion exercises only the edit_site and a test helper: nothing new to relocate to.
  put(MOVED_TEST, [
    `import { describe, it, expect } from "bun:test";`,
    `import { handle } from "../src/routes/handler.js";`,
    `import { advertisedShapes } from "../src/settings/advertised.js";`,
    `import { fixtureRows } from "./helpers/rows.js";`,
    ``,
    `describe("own check", () => {`,
    `  it("the advertised list is non-empty", () => {`,
    `    expect(advertisedShapes().length).toBeGreaterThan(0);`,
    `  });`,
    `  it(${JSON.stringify(FAILING_A_ONLY)}, () => {`,
    `    expect(handle(fixtureRows()[0] ?? "")).toBe(false);`,
    `  });`,
    `});`,
    ``,
  ].join("\n"));
});

// ─── network: discovery, policy pool, concept-db mirror ─────────────────────
type Scope = { excluded_paths?: string[]; unrestricted?: boolean; reason: string };
let scopeRecord: Scope = { unrestricted: true, reason: "test fixture: explicitly unrestricted" };
const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
let logs: string[] = [];
const gapStore = new Map<string, Record<string, any>>();
const storeWrites: Array<{ id: string; gap: Record<string, any> }> = [];
beforeAll(() => {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    let body: Record<string, any> = {};
    try { body = init?.body ? JSON.parse(String(init.body)) : {}; } catch { body = {}; }
    const p = body?.pointer ?? body?.impulse?.pointer;
    if (url === FIXTURE_GAP_STORE) {
      // The fixture store: like the real one, a write carries the row's omitted classification_metadata
      // keys forward; every payload is recorded so a test can assert what a writer SENT.
      if (p?.type === "substrateGap_write" && p.gap?.id) {
        const sent = JSON.parse(JSON.stringify(p.gap));
        storeWrites.push({ id: String(p.gap.id), gap: JSON.parse(JSON.stringify(p.gap)) });
        const prior = gapStore.get(String(p.gap.id));
        if (prior) sent.classification_metadata = { ...(prior.classification_metadata ?? {}), ...(sent.classification_metadata ?? {}) };
        gapStore.set(String(p.gap.id), { ...(prior ?? {}), ...sent });
        return Response.json({ shape: "substrateGap_write", body: { ok: true, id: p.gap.id } });
      }
      if (p?.type === "substrateGap") {
        const row = p.id ? gapStore.get(String(p.id)) : undefined;
        return Response.json({ shape: "substrateGap", body: { gaps: p.id ? (row ? [row] : []) : [...gapStore.values()] } });
      }
      return Response.json({ shape: "structuredError", body: { detail: "fixture store: unsupported pointer" } });
    }
    if (p?.type === "vesselCapability") {
      if (p.shape === "poolImpulse") return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
      return Response.json({ content: { vessels: [], found: false } });
    }
    if (body?.impulse?.type === "poolImpulse") {
      const shape = body.impulse.shape;
      const records = [
        { shape: "autonomyScope", updated_at: "2026-01-01T00:00:00Z", body: scopeRecord },
        { shape: "spendEnvelope", updated_at: "2026-01-01T00:00:00Z", body: { uncapped: true, paused: false, reason: "test fixture: explicitly uncapped" } },
      ];
      return Response.json({ body: { impulses: records.filter((r) => r.shape === shape) } });
    }
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  console.log = origLog;
  console.warn = origWarn;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  g2f.__resetPolicyReadsForTests();
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(() => {
  setTreeEnv();
  logs = [];
  scopeRecord = { unrestricted: true, reason: "test fixture: explicitly unrestricted" };
  g2f.__resetPolicyReadsForTests();
});

// ─── helpers ────────────────────────────────────────────────────────────────
type Row = Record<string, any>;
async function storeRow(id: string): Promise<Row | undefined> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
}
const ownCheckMeta = (testFile: string, only: string[]): Row => ({
  edit_site: repo(A),
  falsifier: "class2",
  evidence_resolve: { shape: "test_suite", input: { vessel: VESSEL, test_file: testFile, only_tests: only } },
});
async function seedGap(id: string, meta: Row): Promise<Row> {
  const gap = { id, category: "missing_capability", source: "operator", status: "open", detected_at: new Date().toISOString(), summary: `relocation fixture ${id}: the check exercises a module the edit_site is not`, classification_metadata: { failure_lessons: [], ...meta } };
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap } as never);
  if (w.shape === "structuredError") throw new Error("seed refused: " + JSON.stringify(w.body));
  return JSON.parse(JSON.stringify((await storeRow(id))!)) as Row;
}
// The structured record composeAttemptEvidence builds for an own-check failure (feature-compose ~4031).
const ownCheckAttempt = (testFile: string, failingName: string, noEffect: boolean, decoy = true): Row => ({
  stage: "own_check",
  edited_spans: [],
  own_check: {
    test_file: testFile,
    failing: [{
      name: `own check > ${failingName}`,
      // The printed failure names C (a frame of the run, not the module the assertion exercises).
      ...(decoy ? { error: `error: expect(received).toContain(expected) at frameOnly (${join(VESSELS, VESSEL, C)}:1:14)` } : {}),
      expected: `Expected to contain: "beta"`,
      received: `Received: [ "alpha" ]`,
    }],
  },
  no_effect_vs_parent: noEffect,
  base_sha: "0123456789abcdef0123456789abcdef01234567",
});
const metaOf = (row: Row | undefined): Row => (row?.["classification_metadata"] ?? {}) as Row;
type Hint = { files?: string[]; derived_from?: string; at?: string };
type Deriver = (input: { vessel_root: string; vessel: string; test_file: string; failing: Array<Record<string, unknown>>; no_effect_vs_parent?: boolean; edit_site?: string }) => Hint | null;
const deriver = (fc as unknown as { deriveRelocationHint?: Deriver }).deriveRelocationHint;
type Op = { kind: "edit" | "create_file" | "replace_lines"; path: string; old_string?: string; new_string?: string; content?: string };
type GateResult = { ops: Op[]; dropped_paths: string[]; dropped_reason?: string; refused?: string; refusal_class?: string };
const composeTargetFiles = (fc as unknown as { composeTargetFiles?: (meta: Row, spec: string) => string[] }).composeTargetFiles;
const fileScopeGate = (fc as unknown as { fileScopeGate?: (ops: Op[], targetFiles: string[]) => GateResult }).fileScopeGate;
const SEAM_ABSENT = "CONTRACT, red at base only because the function does not exist yet: the file-scope gate is inline in resolveFeatureCompose; the fix exports fileScopeGate/composeTargetFiles";
type LandingEvidence = { verdict?: string; cited_check_names?: string[]; dropped_paths?: string[]; dropped_reason?: string };
const composeLandingEvidence = (fc as unknown as { composeLandingEvidence?: (input: { own_check_ran: string[]; scope_drops?: GateResult | null }) => LandingEvidence }).composeLandingEvidence;
const LANDING_ABSENT = "CONTRACT, red at base only because the function does not exist yet: the landing evidence is the inline evaluation_evidence literal; the fix exports composeLandingEvidence";

// ─── derivation ─────────────────────────────────────────────────────────────
describe("relocation hint: derived from the failing assertion's imports", () => {
  it("MUST-FAIL: a no-effect own check whose failing assertion exercises a module other than the edit_site derives that module (not the edit_site, not a test helper, not a printed frame)", () => {
    expect(typeof deriver).toBe("function");
    const attempt = ownCheckAttempt(OWN_TEST, FAILING_B, true);
    const hint = deriver!({ vessel_root: cloneRoot, vessel: VESSEL, test_file: OWN_TEST, failing: attempt.own_check.failing, no_effect_vs_parent: true, edit_site: repo(A) });
    expect(hint?.files).toEqual([repo(B)]);
    expect(hint?.derived_from).toBe("own_check_failure");
    expect(hint?.files).not.toContain(repo(C));
    expect(hint?.files).not.toContain(repo(A));
  });

  it("MUST-FAIL (generality): a module at an arbitrary path is named as the import resolves, so the hint comes from evidence, never from a name list", () => {
    expect(typeof deriver).toBe("function");
    const seg = Math.random().toString(36).slice(2, 9);
    const leaf = `${Math.random().toString(36).slice(2, 8)}-${seg}`;
    const anyB = `src/${seg}/${leaf}.ts`;
    const anyTest = `test/${seg}-check.test.ts`;
    put(anyB, `export function q${seg}(): number { return 1; }\n`);
    put(anyTest, [
      `import { it, expect } from "bun:test";`,
      `import { handle } from "../src/routes/handler.js";`,
      `import { q${seg} as probe } from "../src/${seg}/${leaf}.js";`,
      `it("probe answers two", () => { expect(probe()).toBe(2); });`,
      `it("handler answers", () => { expect(handle("x")).toBe(true); });`,
      ``,
    ].join("\n"));
    const hint = deriver!({ vessel_root: cloneRoot, vessel: VESSEL, test_file: anyTest, failing: [{ name: "probe answers two", expected: "Expected: 2", received: "Received: 1" }], no_effect_vs_parent: true, edit_site: repo(A) });
    expect(hint?.files).toEqual([repo(anyB)]);
  });
});

// ─── the write ──────────────────────────────────────────────────────────────
describe("relocation hint: written to the gap by the failed attempt's lesson", () => {
  it("MUST-FAIL: appendComposeLesson for a no-effect own-check failure writes classification_metadata.relocation_hint {files:[B], derived_from:'own_check_failure', at}", async () => {
    const id = `reloc-write-${RUN}`;
    const snap = await seedGap(id, ownCheckMeta(OWN_TEST, [FAILING_B]));
    await fc.appendComposeLesson("verify_failed", `(fail) own check > ${FAILING_B}`, repo(""), snap as never, ownCheckAttempt(OWN_TEST, FAILING_B, true) as never);
    await fc.__lastComposeLessonMirrorForTests();
    const hint = metaOf(await storeRow(id))["relocation_hint"] as Hint | undefined;
    expect(hint?.files).toEqual([repo(B)]);
    expect(hint?.derived_from).toBe("own_check_failure");
    expect(Number.isFinite(Date.parse(String(hint?.at)))).toBe(true);
  });

  it("CONTROL: an own check that moved (red to green, or a different failure: no_effect_vs_parent false) writes no hint", async () => {
    const id = `reloc-moved-${RUN}`;
    const snap = await seedGap(id, ownCheckMeta(OWN_TEST, [FAILING_B]));
    await fc.appendComposeLesson("verify_failed", `(fail) own check > ${FAILING_B}`, repo(""), snap as never, ownCheckAttempt(OWN_TEST, FAILING_B, false) as never);
    await fc.__lastComposeLessonMirrorForTests();
    const row = await storeRow(id);
    expect((metaOf(row)["failure_lessons"] as Row[]).length).toBe(1);
    expect(metaOf(row)["relocation_hint"]).toBeUndefined();
    if (deriver) expect(deriver({ vessel_root: cloneRoot, vessel: VESSEL, test_file: OWN_TEST, failing: ownCheckAttempt(OWN_TEST, FAILING_B, false).own_check.failing, no_effect_vs_parent: false, edit_site: repo(A) })).toBeNull();
  });

  it("CONTROL: a no-effect check whose failing assertion exercises only the edit_site and test helpers writes no hint (nothing new to relocate to)", async () => {
    const id = `reloc-siteonly-${RUN}`;
    const snap = await seedGap(id, ownCheckMeta(MOVED_TEST, [FAILING_A_ONLY]));
    await fc.appendComposeLesson("verify_failed", `(fail) own check > ${FAILING_A_ONLY}`, repo(""), snap as never, ownCheckAttempt(MOVED_TEST, FAILING_A_ONLY, true) as never);
    await fc.__lastComposeLessonMirrorForTests();
    const row = await storeRow(id);
    expect((metaOf(row)["failure_lessons"] as Row[]).length).toBe(1);
    const hint = metaOf(row)["relocation_hint"] as Hint | undefined;
    // No hint, or one that adds nothing beyond the edit_site.
    expect((hint?.files ?? []).filter((f) => f !== repo(A))).toEqual([]);
  });
});

// ─── the next attempt ───────────────────────────────────────────────────────
describe("relocation hint: the next attempt localizes to the hinted file", () => {
  it("MUST-FAIL: after a no-effect result the second attempt's edit_site differs from the first's (localizeGap reads the hint the lesson wrote)", async () => {
    const id = `reloc-next-${RUN}`;
    const snap = await seedGap(id, ownCheckMeta(OWN_TEST, [FAILING_B]));
    const first = await g2f.localizeGap(snap);
    expect(first?.file).toBe(repo(A));
    await fc.appendComposeLesson("verify_failed", `(fail) own check > ${FAILING_B}`, repo(""), snap as never, ownCheckAttempt(OWN_TEST, FAILING_B, true) as never);
    await fc.__lastComposeLessonMirrorForTests();
    const second = await g2f.localizeGap((await storeRow(id))!);
    expect(second?.file).toBe(repo(B));
    expect(second?.file).not.toBe(first?.file);
  });

  it("CONTROL: without a relocation hint, localizeGap keeps the edit_site", async () => {
    const id = `reloc-nohint-${RUN}`;
    const snap = await seedGap(id, ownCheckMeta(OWN_TEST, [FAILING_B]));
    const loc = await g2f.localizeGap(snap);
    expect(loc?.file).toBe(repo(A));
    expect(loc?.method).toBe("metadata_edit_site");
  });
});

// ─── the file-scope gate ────────────────────────────────────────────────────
const editOn = (rel: string): Op => ({ kind: "edit", path: repo(rel), old_string: "return", new_string: "return /* changed */" });

describe("relocation hint: the file-scope gate admits the hinted file and records what it drops", () => {
  it("MUST-FAIL: with the gap's relocation hint the target files include B and an edit op on B is kept, not dropped as off-target", () => {
    expect(typeof composeTargetFiles).toBe("function");
    expect(typeof fileScopeGate).toBe("function");
    const meta = { ...ownCheckMeta(OWN_TEST, [FAILING_B]), relocation_hint: { files: [repo(B)], derived_from: "own_check_failure", at: new Date().toISOString() } };
    const targets = composeTargetFiles!(meta, `Fix the gap at ${repo(A)}.`);
    expect(targets).toContain(repo(A));
    expect(targets).toContain(repo(B));
    const g = fileScopeGate!([editOn(A), editOn(B)], targets);
    expect(g.ops.map((o) => o.path)).toEqual([repo(A), repo(B)]);
    expect(g.dropped_paths).toEqual([]);
  });

  it("CONTRACT (red at base only because fileScopeGate does not exist yet): without a hint an off-target edit is still dropped (the gate stays strict by default)", () => {
    expect(typeof composeTargetFiles, SEAM_ABSENT).toBe("function");
    expect(typeof fileScopeGate, SEAM_ABSENT).toBe("function");
    const targets = composeTargetFiles!(ownCheckMeta(OWN_TEST, [FAILING_B]), `Fix the gap at ${repo(A)}.`);
    expect(targets).toEqual([repo(A)]);
    const g = fileScopeGate!([editOn(A), editOn(B)], targets);
    expect(g.ops.map((o) => o.path)).toEqual([repo(A)]);
  });

  it("MUST-FAIL: an off-target edit's drop is recorded as dropped_paths:[<path>] with a reason, not silent", () => {
    expect(typeof fileScopeGate).toBe("function");
    const g = fileScopeGate!([editOn(A), editOn(C)], [repo(A)]);
    expect(g.dropped_paths).toEqual([repo(C)]);
    expect(String(g.dropped_reason ?? "")).toContain(repo(A));
    expect(String(g.dropped_reason ?? "").length).toBeGreaterThan(20);
  });

  it("CONTRACT (red at base only because fileScopeGate does not exist yet): an in-scope edit records no drop", () => {
    expect(typeof fileScopeGate, SEAM_ABSENT).toBe("function");
    const g = fileScopeGate!([editOn(A)], [repo(A)]);
    expect(g.dropped_paths).toEqual([]);
    expect(g.dropped_reason).toBeUndefined();
    expect(g.ops.map((o) => o.path)).toEqual([repo(A)]);
  });
});

// ─── the autonomy scope ─────────────────────────────────────────────────────
const cleanRunner = (_vessel: string) => ({ ran: true, clean: true });
describe("relocation hint: a hinted file outside the autonomy scope is operator work", () => {
  it("MUST-FAIL: a hinted file in excluded_paths is NOT composed; the gap carries the hint and an operator routing marker", async () => {
    scopeRecord = { excluded_paths: [repo(B)], reason: "test fixture: the hinted module is lane core" };
    const id = `reloc-excluded-${RUN}`;
    const hint = { files: [repo(B)], derived_from: "own_check_failure", at: new Date().toISOString() };
    const snap = await seedGap(id, { ...ownCheckMeta(OWN_TEST, [FAILING_B]), relocation_hint: hint });
    const r = await g2f.admitActionableGaps([snap], { typecheckRunner: cleanRunner });
    expect(r.admitted.map((g) => String(g.id))).not.toContain(id);
    const ex = r.excluded.find((e) => e.id === id);
    expect(String(ex?.reason ?? "")).toContain("relocation_hint");
    const meta = metaOf(await storeRow(id));
    expect((meta["relocation_hint"] as Hint | undefined)?.files).toEqual([repo(B)]);
    expect(g2f.isParkingDisposition(meta["disposition"])).toBe(true);
    const routing = meta["operator_routing"] as { files?: string[]; reason?: string } | undefined;
    expect(routing?.files).toEqual([repo(B)]);
    expect(String(routing?.reason ?? "").length).toBeGreaterThan(0);
  });

  it("CONTROL: a hinted file inside the autonomy scope is admitted (the hint never excludes on its own)", async () => {
    scopeRecord = { excluded_paths: [repo("src/lane-core/")], reason: "test fixture: an unrelated lane-core dir" };
    const id = `reloc-inscope-${RUN}`;
    const hint = { files: [repo(B)], derived_from: "own_check_failure", at: new Date().toISOString() };
    const snap = await seedGap(id, { ...ownCheckMeta(OWN_TEST, [FAILING_B]), relocation_hint: hint });
    const r = await g2f.admitActionableGaps([snap], { typecheckRunner: cleanRunner });
    expect(r.admitted.map((g) => String(g.id))).toContain(id);
    expect(metaOf(await storeRow(id))["operator_routing"]).toBeUndefined();
  });
});

// ─── round 2: where the check's test file is read from ──────────────────────
describe("relocation hint: the check's test file is read from the vessel clone, never the runtime tree", () => {
  it("MUST-FAIL: the failing test file is absent from the runtime tree and present in the vessel clone, and the hint is still derived", async () => {
    expect(existsSync(join(VESSELS, VESSEL, OWN_TEST))).toBe(false);
    expect(existsSync(join(CLONE, VESSEL, OWN_TEST))).toBe(true);
    const id = `reloc-clone-only-${RUN}`;
    const snap = await seedGap(id, ownCheckMeta(OWN_TEST, [FAILING_B]));
    await fc.appendComposeLesson("verify_failed", `(fail) own check > ${FAILING_B}`, repo(""), snap as never, ownCheckAttempt(OWN_TEST, FAILING_B, true) as never);
    await fc.__lastComposeLessonMirrorForTests();
    expect((metaOf(await storeRow(id))["relocation_hint"] as Hint | undefined)?.files).toEqual([repo(B)]);
  });

  it("MUST-FAIL: a stale runtime-tree copy of the check is never read: the hint follows the clone's copy (B), never the module the runtime copy imports (D)", async () => {
    const id = `reloc-stale-runtime-${RUN}`;
    const snap = await seedGap(id, ownCheckMeta(STALE_TEST, [FAILING_B]));
    await fc.appendComposeLesson("verify_failed", `(fail) own check > ${FAILING_B}`, repo(""), snap as never, ownCheckAttempt(STALE_TEST, FAILING_B, true) as never);
    await fc.__lastComposeLessonMirrorForTests();
    const files = (metaOf(await storeRow(id))["relocation_hint"] as Hint | undefined)?.files;
    expect(files).toEqual([repo(B)]);
    expect(files ?? []).not.toContain(repo(D));
  });

  it("CONTROL: a check present only in the runtime tree yields no hint (the runtime tree is never read for test files)", async () => {
    expect(existsSync(join(CLONE, VESSEL, RUNTIME_ONLY_TEST))).toBe(false);
    const id = `reloc-runtime-only-${RUN}`;
    const snap = await seedGap(id, ownCheckMeta(RUNTIME_ONLY_TEST, [FAILING_B]));
    await fc.appendComposeLesson("verify_failed", `(fail) own check > ${FAILING_B}`, repo(""), snap as never, ownCheckAttempt(RUNTIME_ONLY_TEST, FAILING_B, true) as never);
    await fc.__lastComposeLessonMirrorForTests();
    const row = await storeRow(id);
    expect((metaOf(row)["failure_lessons"] as Row[]).length).toBe(1);
    expect(metaOf(row)["relocation_hint"]).toBeUndefined();
  });
});

// ─── round 2: what a drop means for landing ─────────────────────────────────
describe("relocation hint: a dropped op is on the landing evidence, and an all-dropped plan does not land", () => {
  it("MUST-FAIL: a FAVORABLE compose that dropped an off-target op carries dropped_paths and a reason on its landing evidence", () => {
    expect(typeof fileScopeGate).toBe("function");
    expect(typeof composeLandingEvidence).toBe("function");
    const g = fileScopeGate!([editOn(A), editOn(C)], [repo(A)]);
    const ev = composeLandingEvidence!({ own_check_ran: [OWN_TEST], scope_drops: g });
    expect(ev.verdict).toBe("FAVORABLE");
    expect(ev.cited_check_names ?? []).toContain("typecheck");
    expect(ev.dropped_paths).toEqual([repo(C)]);
    expect(String(ev.dropped_reason ?? "")).toContain(repo(A));
  });

  it("CONTRACT (red at base only because composeLandingEvidence does not exist yet): a FAVORABLE compose that dropped nothing carries no dropped_paths on its landing evidence", () => {
    expect(typeof fileScopeGate, SEAM_ABSENT).toBe("function");
    expect(typeof composeLandingEvidence, LANDING_ABSENT).toBe("function");
    const ev = composeLandingEvidence!({ own_check_ran: [], scope_drops: fileScopeGate!([editOn(A)], [repo(A)]) });
    expect(ev.verdict).toBe("FAVORABLE");
    expect(ev.dropped_paths).toBeUndefined();
    expect(ev.dropped_reason).toBeUndefined();
  });

  it("MUST-FAIL: a compose whose only ops were all dropped does not land: no op survives and the refusal is no_effect-classed", () => {
    expect(typeof fileScopeGate).toBe("function");
    const g = fileScopeGate!([editOn(C), editOn(D)], [repo(A)]);
    expect(g.ops).toEqual([]);
    expect(String(g.refused ?? "").length).toBeGreaterThan(0);
    expect(String(g.refusal_class ?? "")).toMatch(/^no_effect/);
    expect(g.dropped_paths).toEqual([repo(C), repo(D)]);
  });
});

// ─── round 2: the hint write is a merge ─────────────────────────────────────
describe("relocation hint: the hint write is a merge, not a whole-row replace", () => {
  it("MUST-FAIL: the relocation-hint write sends only relocation_hint in classification_metadata, and the row keeps its other keys", async () => {
    const id = `reloc-merge-${RUN}`;
    const snap = await seedGap(id, ownCheckMeta(OWN_TEST, [FAILING_B]));
    const before = storeWrites.length;
    await fc.appendComposeLesson("verify_failed", `(fail) own check > ${FAILING_B}`, repo(""), snap as never, ownCheckAttempt(OWN_TEST, FAILING_B, true) as never);
    await fc.__lastComposeLessonMirrorForTests();
    const hintWrites = storeWrites.slice(before).filter((w) => w.id === id && "relocation_hint" in ((w.gap["classification_metadata"] ?? {}) as Row));
    expect(hintWrites.length).toBeGreaterThan(0);
    for (const w of hintWrites) expect(Object.keys(w.gap["classification_metadata"] as Row)).toEqual(["relocation_hint"]);
    const meta = metaOf(await storeRow(id));
    expect(meta["edit_site"]).toBe(repo(A));
    expect((meta["failure_lessons"] as Row[]).length).toBe(1);
    expect((meta["relocation_hint"] as Hint).files).toEqual([repo(B)]);
  });
});
