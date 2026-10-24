// THE GAP_COUNT JOINT'S READING IS A TOP-LEVEL NUMBER ON THE GAP STORE'S OWN READ (substrate-gap.ts A GAP-COUNT READ).
// The joint-liveness detector arms a gap_count joint only when its binding's check { shape, input, field } just read a
// finite number > 0, and the class-2 judge reads only top-level fields. substrateGap filtered on id/category/source/
// status alone, so a binding's metadata-path conditions had no instrument. With `where` the read counts them, before
// the limit, as match_count; without it the body is exactly what it was.
// MUST-FAIL on the parent (77580123): substrateGap returns no match_count and has no response contract.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = mkdtempSync(join(tmpdir(), "gap-where-count-"));
process.env["WORKSPACE_ROOT"] = ROOT;
isolateLearnedStateInProcess(ROOT);
// The store is held here: a node that forwards its gap store would send every read to the holder.
const savedGapStoreEndpoint = process.env["GAP_STORE_ENDPOINT"];
delete process.env["GAP_STORE_ENDPOINT"];
const { gapStoreRootForTest, resolveSubstrateGap, checkArmingProblem } = await import("../../src/resolvers/substrate-gap.js");

const NOW = Date.now();
const iso = (agoSec: number) => new Date(NOW - agoSec * 1000).toISOString();
const row = (id: string, regressed: Record<string, unknown>, status = "open") => ({
  id, category: "systematic_failure", source: "substrate_detected", status, summary: `fixture ${id}`,
  created_at: iso(10), detected_at: iso(10), updated_at: iso(10), classification_metadata: { regressed_by: regressed },
});
const SEED = [
  row("revert-unlearned-old", { revert_sha: "abc", attempt_id: "a1", at: iso(7200) }),
  row("revert-unlearned-old-2", { revert_sha: "def", attempt_id: "a2", at: iso(9000) }),
  row("revert-learned", { revert_sha: "abc", attempt_id: "a3", at: iso(7200), learned_at: iso(100) }),
  row("revert-recent", { revert_sha: "abc", attempt_id: "a4", at: iso(60) }),
  row("revert-closed", { revert_sha: "abc", attempt_id: "a5", at: iso(7200) }, "closed"),
];
// The operator-revert-learned jointBinding's conditions, verbatim.
const WHERE = [
  { path: "classification_metadata.regressed_by.revert_sha", op: "exists" },
  { path: "classification_metadata.regressed_by.attempt_id", op: "exists" },
  { path: "classification_metadata.regressed_by.learned_at", op: "missing" },
  { path: "classification_metadata.regressed_by.at", op: "older_than_sec", value: 3600 },
];
const read = async (p: Record<string, unknown>) => (await resolveSubstrateGap({ type: "substrateGap", ...p } as never)).body as Record<string, unknown>;

beforeAll(() => {
  const root = gapStoreRootForTest();
  if (!resolve(root).startsWith(resolve(tmpdir()))) throw new Error(`refusing to seed a store root outside ${tmpdir()}: ${root}`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  writeFileSync(join(root, "gaps", "gaps.json"), JSON.stringify(SEED));
});
afterAll(() => {
  if (savedGapStoreEndpoint !== undefined) process.env["GAP_STORE_ENDPOINT"] = savedGapStoreEndpoint;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

describe("substrateGap where: the gap_count joint's reading", () => {
  it("[MUST-FAIL] the binding's conditions read as a top-level finite match_count", async () => {
    const b = await read({ status: "open", where: WHERE, limit: 8000 });
    expect(typeof b.match_count).toBe("number");
    expect(Number.isFinite(b.match_count as number)).toBe(true);
    expect(b.match_count).toBe(2);
    expect((b.gaps as Array<{ id: string }>).map((g) => g.id).sort()).toEqual(["revert-unlearned-old", "revert-unlearned-old-2"]);
  });

  it("[MUST-FAIL] match_count is counted before the limit, and is 0 when nothing matches", async () => {
    const capped = await read({ status: "open", where: WHERE, limit: 1 });
    expect(capped.match_count).toBe(2);
    expect(capped.total).toBe(1);
    const none = await read({ status: "open", where: [{ path: "classification_metadata.regressed_by.nope", op: "exists" }] });
    expect(none.match_count).toBe(0);
  });

  it("[MUST-FAIL] the arming the detector would write passes the response contract; one without where is refused", () => {
    const er = { shape: "substrateGap", input: { status: "open", where: WHERE, limit: 8000 }, zero_field: "match_count" };
    expect(checkArmingProblem(er)).toBeNull();
    expect(checkArmingProblem({ ...er, input: { status: "open" } })?.position).toBe("evidence_resolve.zero_field");
  });

  it("a malformed where is unmeasured (no match_count) and says why", async () => {
    const b = await read({ status: "open", where: [{ path: "x", op: "equals" }] });
    expect("match_count" in b).toBe(false);
    expect(String(b.where_error)).toContain("equals");
  });

  it("CONTROL: without where, the body carries exactly its existing fields and values", async () => {
    const b = await read({ status: "open", limit: 50 });
    expect(Object.keys(b).sort()).toEqual(["falsifier_coverage", "gaps", "total"]);
    expect(b.total).toBe(4);
    expect((b.gaps as unknown[]).length).toBe(4);
    const all = await read({ limit: 50 });
    expect(Object.keys(all).sort()).toEqual(["falsifier_coverage", "gaps", "total"]);
    expect(all.total).toBe(5);
  });
});
