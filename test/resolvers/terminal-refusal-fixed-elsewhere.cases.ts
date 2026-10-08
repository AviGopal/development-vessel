// A GAP FIXED BY ANOTHER COMMIT IS CLOSED BY MEASUREMENT, NAMING THAT COMMIT (gap: a-gap-fixed-by-an-operator-
// commit-is-never-closed-so-the-lane-keeps-picking-it). A compose whose terminal refusal says "the gap's own check
// is already GREEN on the parent tree" used to leave the gap OPEN with only a 6 h admission exclusion, so the lane
// re-picked a fixed gap every time it expired. Now: when a commit touching the check's subject files (edit_site,
// the own-check test file) landed after the gap's birth tree, the gap closes fixed_elsewhere with close_basis
// absent and a falsifier_exercise naming that commit (fixed_by) and the tree it was read on. When NO such commit
// exists (the check went green with no change to its subject — flaky, environmental), it is NOT closed: only the
// exclusion marker is written. Driven against the real (temp) gap store and a real temp git clone.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `fixed-elsewhere-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const CLONES = join(ROOT, "clones");
const savedClones = process.env["VESSELS_CLONE_ROOT"];
process.env["VESSELS_CLONE_ROOT"] = CLONES;
const sg = await import("../../src/resolvers/substrate-gap.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js");
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "fe-vessel";
const REPO = join(CLONES, VESSEL);
const originalFetch = globalThis.fetch;
const savedStore = process.env["GAP_STORE_ENDPOINT"];
type Row = Record<string, unknown>;
const GREEN = "the gap's own check is already GREEN on the parent tree, so it cannot certify this draft";

function git(...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", REPO, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
}
function commitFile(rel: string, body: string, msg: string): string {
  mkdirSync(join(REPO, rel, ".."), { recursive: true });
  writeFileSync(join(REPO, rel), body);
  git("add", rel);
  git("commit", "-q", "-m", msg);
  return git("rev-parse", "HEAD");
}

beforeAll(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  mkdirSync(REPO, { recursive: true });
  git("init", "-q");
  globalThis.fetch = (async () => Response.json({ content: { vessels: [] } })) as unknown as typeof fetch;
  sg.__setBirthJudgeForTests(async () => "present");
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  sg.__setBirthJudgeForTests(null);
  if (savedStore !== undefined) process.env["GAP_STORE_ENDPOINT"] = savedStore;
  if (savedClones !== undefined) process.env["VESSELS_CLONE_ROOT"] = savedClones; else delete process.env["VESSELS_CLONE_ROOT"];
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});

const er = (testFile: string) => ({ shape: "test_suite", input: { vessel: VESSEL, test_file: testFile, only_tests: ["a > b"] }, zero_field: "requested_not_passing" });
async function write(id: string, meta: Row): Promise<Row> {
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary: `fixed-elsewhere fixture ${id}`, classification_metadata: { falsifier: "class2", ...meta } } } as never);
  if (w.shape === "structuredError") throw new Error(JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
  return row(id);
}
async function row(id: string): Promise<Row> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0]!;
}
const metaOf = (r: Row): Row => (r["classification_metadata"] ?? {}) as Row;
type Mark = (gap: Row, cb: Row) => Promise<void>;

describe("markTerminalRefusal on a gap whose own check is green on the parent", () => {
  it("closes it fixed_elsewhere, naming the commit that touched the check's subject after the gap's birth", async () => {
    const mark = (g2f as Row)["markTerminalRefusal"] as Mark | undefined;
    expect(typeof mark).toBe("function");
    commitFile("src/a.ts", "export const a = 1; // defect\n", "seed a");
    commitFile("src/a.test.ts", "// a > b\n", "seed test");
    const id = `fe-fixed-${RUN}`;
    const born = await write(id, { edit_site: `repos/${VESSEL}/src/a.ts`, evidence_resolve: er("src/a.test.ts") });
    const birth = String(metaOf(born)["predicate_birth_sha"] ?? "");
    expect(birth).toBe(git("rev-parse", "HEAD"));
    const fix = commitFile("src/a.ts", "export const a = 2; // fixed by hand\n", "operator fix");
    commitFile("README.md", "unrelated\n", "unrelated after the fix");
    const head = git("rev-parse", "HEAD");
    await mark!(born, { failure_kind: "terminal_refusal", terminal_refusal: GREEN });
    const r = await row(id);
    expect(r["status"]).toBe("closed");
    const m = metaOf(r);
    expect(m["closed_reason"]).toBe("fixed_elsewhere");
    expect(m["close_basis"]).toBe("absent");
    const ex = m["falsifier_exercise"] as Row;
    expect(ex["verdict"]).toBe("absent");
    expect(ex["passed"]).toBe(true);
    expect(ex["fixed_by"]).toBe(fix);
    expect(ex["commit"]).toBe(head);
    expect(typeof ex["ran_at"]).toBe("string");
    expect(typeof ex["detector"]).toBe("string");
  });

  it("does NOT close a gap whose check went green with no commit touching its subject files; only the exclusion marker is written", async () => {
    const mark = (g2f as Row)["markTerminalRefusal"] as Mark | undefined;
    expect(typeof mark).toBe("function");
    commitFile("src/c.ts", "export const c = 1;\n", "seed c");
    commitFile("src/c.test.ts", "// c\n", "seed c test");
    const id = `fe-flaky-${RUN}`;
    const born = await write(id, { edit_site: `repos/${VESSEL}/src/c.ts`, evidence_resolve: er("src/c.test.ts") });
    commitFile("docs/x.md", "unrelated\n", "unrelated after birth");
    await mark!(born, { failure_kind: "terminal_refusal", terminal_refusal: GREEN });
    const r = await row(id);
    expect(r["status"]).toBe("open");
    const m = metaOf(r);
    expect(m["closed_reason"]).toBeUndefined();
    expect(typeof (m["own_check_green_on_parent"] as Row | undefined)?.["at"]).toBe("string");
  });
});

// THE CHECK IS NOT ITS OWN FIX. A commit since birth that touches the gap's OWN check (its test_file, or a non-src
// file the check imports: the instrument, as the independent verdict's guard computes it) can make the check green
// by changing the judge, not the judged. Such a green is NOT a fixed_elsewhere measurement: the gap stays open with
// the exclusion marker carrying a NAMED stage. MIXED (one commit touching the edit_site AND the check) and SPLIT
// (an edit_site commit, then a later instrument commit) are held too (v1: no re-run of the original check).
describe("markTerminalRefusal: a commit that touched the gap's own check is not a fixed_elsewhere fix", () => {
  const held = async (id: string, stage: string): Promise<void> => {
    const r = await row(id);
    const m = metaOf(r);
    expect({ status: r["status"], closed_reason: m["closed_reason"] ?? null, stage: (m["own_check_green_on_parent"] as Row | undefined)?.["stage"] ?? null })
      .toEqual({ status: "open", closed_reason: null, stage });
    expect(typeof (m["own_check_green_on_parent"] as Row | undefined)?.["at"]).toBe("string");
  };
  const mark = (): Mark => {
    const f = (g2f as Row)["markTerminalRefusal"] as Mark | undefined;
    expect(typeof f).toBe("function");
    return f!;
  };

  it("MUST-FAIL (ii-a): a commit touching ONLY the gap's test_file is held (own_green_instrument_only_commit)", async () => {
    commitFile("src/ia.ts", "export const ia = 1; // defect\n", "seed ia");
    commitFile("test/ia.test.ts", "// ia > b: expects 2\n", "seed ia test");
    const id = `fe-ia-${RUN}`;
    const born = await write(id, { edit_site: `repos/${VESSEL}/src/ia.ts`, evidence_resolve: er("test/ia.test.ts") });
    commitFile("test/ia.test.ts", "// ia > b: expects 1 (the check bent to the defect)\n", "weaken the check");
    await mark()(born, { failure_kind: "terminal_refusal", terminal_refusal: GREEN });
    await held(id, "own_green_instrument_only_commit");
  });

  it("MUST-FAIL (ii-b): a commit touching ONLY a test-only helper the check imports is held (own_green_instrument_only_commit)", async () => {
    commitFile("src/ib.ts", "export const ib = 1;\n", "seed ib");
    commitFile("test/helpers/ib-helper.ts", "export const expected = 2;\n", "seed ib helper");
    commitFile("test/ib.test.ts", "import { expected } from \"./helpers/ib-helper.js\";\n// ib > b\n", "seed ib test");
    const id = `fe-ib-${RUN}`;
    // check_inputs names the helper (as a supply may): before the fix it was a SUBJECT file, so its edit closed the gap.
    const born = await write(id, { edit_site: `repos/${VESSEL}/src/ib.ts`, check_inputs: [`repos/${VESSEL}/test/helpers/ib-helper.ts`], evidence_resolve: er("test/ib.test.ts") });
    commitFile("test/helpers/ib-helper.ts", "export const expected = 1;\n", "bend the helper");
    await mark()(born, { failure_kind: "terminal_refusal", terminal_refusal: GREEN });
    await held(id, "own_green_instrument_only_commit");
  });

  it("MUST-FAIL (ii-mixed): ONE commit touching the edit_site AND the test_file is held (own_green_mixed_instrument_commit)", async () => {
    commitFile("src/im.ts", "export const im = 1;\n", "seed im");
    commitFile("test/im.test.ts", "// im > b: expects 2\n", "seed im test");
    const id = `fe-im-${RUN}`;
    const born = await write(id, { edit_site: `repos/${VESSEL}/src/im.ts`, evidence_resolve: er("test/im.test.ts") });
    mkdirSync(join(REPO, "src"), { recursive: true });
    writeFileSync(join(REPO, "src/im.ts"), "export const im = 3;\n");
    writeFileSync(join(REPO, "test/im.test.ts"), "// im > b: expects 3\n");
    git("add", "src/im.ts", "test/im.test.ts");
    git("commit", "-q", "-m", "change both the site and its check");
    await mark()(born, { failure_kind: "terminal_refusal", terminal_refusal: GREEN });
    await held(id, "own_green_mixed_instrument_commit");
  });

  it("MUST-FAIL (ii-split): an edit_site commit FOLLOWED by an instrument-only commit is held (own_green_instrument_changed_since_birth)", async () => {
    commitFile("src/is.ts", "export const is = 1;\n", "seed is");
    commitFile("test/is.test.ts", "// is > b\n", "seed is test");
    const id = `fe-is-${RUN}`;
    const born = await write(id, { edit_site: `repos/${VESSEL}/src/is.ts`, evidence_resolve: er("test/is.test.ts") });
    commitFile("src/is.ts", "export const is = 2;\n", "touch the site");
    commitFile("test/is.test.ts", "// is > b (rewritten)\n", "then rewrite the check");
    await mark()(born, { failure_kind: "terminal_refusal", terminal_refusal: GREEN });
    await held(id, "own_green_instrument_changed_since_birth");
  });

  it("CONTROL: an edit_site-only commit still closes fixed_elsewhere when the check imports an UNCHANGED test helper", async () => {
    commitFile("src/ic.ts", "export const ic = 1;\n", "seed ic");
    commitFile("test/helpers/ic-helper.ts", "export const h = 1;\n", "seed ic helper");
    commitFile("test/ic.test.ts", "import { h } from \"./helpers/ic-helper\";\n// ic > b\n", "seed ic test");
    const id = `fe-ic-${RUN}`;
    const born = await write(id, { edit_site: `repos/${VESSEL}/src/ic.ts`, evidence_resolve: er("test/ic.test.ts") });
    const fix = commitFile("src/ic.ts", "export const ic = 2;\n", "fix ic");
    await mark()(born, { failure_kind: "terminal_refusal", terminal_refusal: GREEN });
    const r = await row(id);
    expect({ status: r["status"], closed_reason: metaOf(r)["closed_reason"], fixed_by: (metaOf(r)["falsifier_exercise"] as Row | undefined)?.["fixed_by"] })
      .toEqual({ status: "closed", closed_reason: "fixed_elsewhere", fixed_by: fix });
  });

  it("CONTROL: a gap whose check has no subject beyond its own test_file is never attributed to an unrelated commit", async () => {
    commitFile("test/io.test.ts", "// io > b\n", "seed io test");
    const id = `fe-io-${RUN}`;
    const born = await write(id, { evidence_resolve: er("test/io.test.ts") });
    commitFile("docs/io.md", "unrelated\n", "unrelated after birth");
    await mark()(born, { failure_kind: "terminal_refusal", terminal_refusal: GREEN });
    const r = await row(id);
    expect({ status: r["status"], closed_reason: metaOf(r)["closed_reason"] ?? null }).toEqual({ status: "open", closed_reason: null });
  });
});

// SELF-AUTHORED CHECK INPUTS, as the supply arms them: evidence_resolve.input.vessel is "repos/<v>" (gap-check-supply),
// so the path built from it must be repos/<v>/<test_file>, never repos/repos/<v>/... (which matched nothing, and the
// sweep's self-authored hold never fired for a supply-armed gap). A bare "<v>" is the control.
describe("selfAuthoredCheckInputs: the check's vessel with or without a repos/ prefix", () => {
  type SelfAuth = (gap: Row, sha: string) => string[];
  const fn = (): SelfAuth => {
    const f = (g2f as Row)["__selfAuthoredCheckInputsForTests"] as SelfAuth | undefined;
    expect(typeof f, "gap-to-feature must export __selfAuthoredCheckInputsForTests").toBe("function");
    return f!;
  };
  it("MUST-FAIL (i): a supply-armed check (vessel repos/<v>) whose landing edited its test_file is self-authored at repos/<v>/<test_file>", () => {
    const sha = commitFile("test/sa.test.ts", "// sa > b (edited by the landing)\n", "landing edits its own check");
    const gap = { id: `fe-sa-${RUN}`, classification_metadata: { evidence_resolve: { shape: "test_suite", input: { vessel: `repos/${VESSEL}`, test_file: "test/sa.test.ts", only_tests: ["sa > b"] } } } };
    expect(fn()(gap, sha)).toEqual([`repos/${VESSEL}/test/sa.test.ts`]);
  });
  it("CONTROL: a bare vessel name gives the same repos/<v>/<test_file>; a landing not touching the check gives []", () => {
    const sha = commitFile("test/sb.test.ts", "// sb > b (edited)\n", "landing edits its own check (bare vessel)");
    const gap = { id: `fe-sb-${RUN}`, classification_metadata: { evidence_resolve: { shape: "test_suite", input: { vessel: VESSEL, test_file: "test/sb.test.ts" } } } };
    expect(fn()(gap, sha)).toEqual([`repos/${VESSEL}/test/sb.test.ts`]);
    const other = commitFile("src/sb.ts", "export const sb = 1;\n", "landing elsewhere");
    expect(fn()(gap, other)).toEqual([]);
  });
});
