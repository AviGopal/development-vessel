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
