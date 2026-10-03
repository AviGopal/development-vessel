// THE SIBLING CLOSERS OBEY THE SAME RE-DETECTION RULE AS THE SWEEP.
//
// Three other paths close a gap on a commit without the pending-land sweep: a child's verified close closes
// its same-predicate ancestors (closed_via_child) and descendants (closed_via_parent), and a green-on-parent
// terminal refusal closes a gap fixed_elsewhere on a commit that touched its check's subject since birth.
// Each can close a gap a detector has REOPENED on a commit that landed before the reopen: the same stale
// re-close as the sweep's, minus the FAVORABLE outcome. A reopened row closes on a commit only if that
// commit landed after its re-detection (or its check is a standing row); a never-reopened row is unchanged.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `stale-sibling-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const sg = await import("../../src/resolvers/substrate-gap.js");
const g2f = await import("../../src/resolvers/gap-to-feature.js");
const STORE = sg.gapStoreRootForTest();
const GAPS_PATH = join(STORE, "gaps", "gaps.json");
const CLONES = join(ROOT, "clones");
const VESSEL = "sib-vessel";
const REPO = join(CLONES, VESSEL);
const RUN = Math.random().toString(36).slice(2, 8);
type Row = Record<string, unknown>;
const T0 = "2026-09-30T07:00:00.000Z";
const BIRTH = "2026-09-01T00:00:00.000Z";
const SITE = `repos/${VESSEL}/src/a.ts`;
const ER = { shape: "test_suite", input: { vessel: VESSEL, test_file: "src/a.test.ts", only_tests: ["a > b"] }, zero_field: "requested_not_passing" };
const GREEN = "the gap's own check is already GREEN on the parent tree, so it cannot certify this draft";
const originalFetch = globalThis.fetch;
const savedStore = process.env["GAP_STORE_ENDPOINT"];
const savedClones = process.env["VESSELS_CLONE_ROOT"];
let oldSha = "";

function git(env: Record<string, string>, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", REPO, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
}
function commitAt(rel: string, body: string, when: string): string {
  mkdirSync(join(REPO, rel, ".."), { recursive: true });
  writeFileSync(join(REPO, rel), body);
  git({}, "add", rel);
  git({ GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when }, "commit", "-q", "-m", `change ${rel} at ${when}`);
  return git({}, "rev-parse", "HEAD");
}
const readStore = (): Row[] => JSON.parse(readFileSync(GAPS_PATH, "utf8")) as Row[];
const rowOf = (id: string): Row => readStore().find((g) => g["id"] === id)!;
const metaOf = (r: Row): Row => (r["classification_metadata"] ?? {}) as Row;

/** Seed a row CLOSED at T0 straight into the store, then reopen it through the writer (a re-detection). */
async function seedReopened(id: string, meta: Row): Promise<void> {
  const rows = readStore();
  rows.push({ id, category: "systematic_failure", source: "substrate_detected", summary: `sibling fixture ${id}`, status: "closed", detected_at: BIRTH, first_detected_at: BIRTH, created_at: BIRTH, updated_at: T0, closed_at: T0, reopen_count: 0,
    classification_metadata: { edit_site: SITE, evidence_resolve: ER, closed_reason: "landed_verified", close_basis: "absent", ...meta } });
  writeFileSync(GAPS_PATH, JSON.stringify(rows));
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "substrate_detected", summary: `sibling fixture ${id}`, status: "open", classification_metadata: { edit_site: SITE, evidence_resolve: ER, ...meta } } } as never);
  if (w.shape === "structuredError") throw new Error(JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
  if (rowOf(id)["status"] !== "open") throw new Error(`${id} did not reopen`);
}

beforeAll(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  if (!STORE.startsWith(tmpdir()) && !STORE.startsWith("/tmp/")) throw new Error(`gap store root ${STORE} is not a temp dir`);
  process.env["VESSELS_CLONE_ROOT"] = CLONES;
  mkdirSync(join(STORE, "gaps"), { recursive: true });
  try { readStore(); } catch { writeFileSync(GAPS_PATH, "[]"); }
  mkdirSync(REPO, { recursive: true });
  git({}, "init", "-q");
  commitAt("src/a.ts", "export const a = 1; // defect\n", "2026-08-30T00:00:00Z");
  commitAt("src/a.test.ts", "// a > b\n", "2026-08-30T00:00:01Z");
  // The fix that did not hold: after the gaps' birth, before their re-detection.
  oldSha = commitAt("src/a.ts", "export const a = 2;\n", T0);
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

const exercise = (sha: string): Row => ({ detector: "gap-sweep", verdict: "absent", passed: true, ran_at: new Date().toISOString(), commit: sha });
const childClose = (sha: string, up: Row): Row => ({ evidence_resolve: ER, edit_site: SITE, closed_reason: "landed_verified", close_basis: "absent", falsifier_exercise: exercise(sha), ...up });

describe("closeAncestorsOnSamePredicate on a REOPENED ancestor", () => {
  it("does not close it on a child's commit that landed before the ancestor's re-detection", async () => {
    const p = `sib-anc-${RUN}`;
    await seedReopened(p, {});
    const closed = await g2f.closeAncestorsOnSamePredicate(`${p}-narrowed`, childClose(oldSha, { parent_gap_id: p }));
    expect(closed).toEqual([]);
    expect(rowOf(p)["status"]).toBe("open");
  });
  it("closes it on a child's commit that landed after the re-detection", async () => {
    const p = `sib-anc-new-${RUN}`;
    await seedReopened(p, {});
    const fresh = commitAt("src/a.ts", `export const a = 3; // ${p}\n`, new Date(Date.now() + 2000).toISOString());
    const closed = await g2f.closeAncestorsOnSamePredicate(`${p}-narrowed`, childClose(fresh, { parent_gap_id: p }));
    expect(closed).toEqual([p]);
    expect(rowOf(p)["status"]).toBe("closed");
  });
});

describe("closeDescendantsOnSamePredicate on a REOPENED descendant", () => {
  it("does not close it on the parent's commit that landed before the descendant's re-detection", async () => {
    const parent = `sib-desc-${RUN}`;
    const child = `${parent}-narrowed`;
    await seedReopened(child, { parent_gap_id: parent });
    const closed = await g2f.closeDescendantsOnSamePredicate(parent, childClose(oldSha, {}));
    expect(closed).toEqual([]);
    expect(rowOf(child)["status"]).toBe("open");
  });
});

describe("markTerminalRefusal (fixed_elsewhere) on a REOPENED gap", () => {
  it("does not close it fixed_elsewhere on a commit that landed before the re-detection", async () => {
    const id = `sib-fe-${RUN}`;
    await seedReopened(id, { falsifier: "class2" });
    await g2f.markTerminalRefusal(rowOf(id), { terminal_refusal: GREEN });
    const r = rowOf(id);
    expect(r["status"]).toBe("open");
    expect(metaOf(r)["closed_reason"]).toBeUndefined();
  });
});
