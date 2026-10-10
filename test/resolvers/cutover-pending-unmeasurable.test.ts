// A LANDING WITH NOTHING TO MEASURE IT GOES TO THE HUMAN LANE AT STAMP TIME (operator ruling 2026-10-10).
//
// The cutover's pending-land stamp marks a pushed landing pending_outcome_verification and leaves the verdict to the
// sweep. The sweep closes only on a MEASURED 'absent'; with no predicate it abstains forever. Measured on node1
// (10-10): of ~100 pending rows, 81 carried no predicate (47+ route-edit landings), and the retired
// verification_spec reader that was meant to verify them had never had an input. So at the stamp, a landing whose
// gap has no measurable predicate (landVerdictIsMeasured, with a previous landing's removed-line durability sentinel
// not counting) is asked of a human on the needs-human-<gap> panel the answer path reads, the row records
// pending_unmeasurable {reason:"no_predicate", at, sha, asked}, and one log line names the gap and the panel handed to
// ui-write-passthrough. A landing WITH a measurable predicate is not flagged (control) and has the flag cleared.
//
// Drives the real stamp (stampPendingLand) through the cutover's own-check deps seam: the gap read, the gap write
// and the ask are injected; no network, no git repository (the removed-line derivation fails and is skipped).
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as cutoverMod from "../../src/resolvers/vessel-mitosis-cutover.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Row = Record<string, unknown>;
type Deps = { readGap?: (p: Row) => Promise<unknown>; writeGap?: (p: Row) => Promise<unknown>; ask?: (p: Row) => Promise<unknown> };
const mod = cutoverMod as unknown as {
  __setOwnCheckDepsForTests?: (d: Deps | null) => void;
  stampPendingLand?: (a: Record<string, unknown>) => Promise<void>;
};

const GAP = "gap-route-edit-unmeasurable";
const SHA = "0123456789abcdef0123456789abcdef01234567";
let dir: string;
let writes: Row[];
let asks: Row[];
let logs: string[];
const origLog = console.log;
const savedClone = process.env["MITOSIS_PUSH_CLONE_DIR"];

function row(meta: Row): Row {
  return { id: GAP, status: "open", category: "missing_capability", source: "substrate_detected", summary: "route-edit: wire the thing", classification_metadata: meta };
}
async function stamp(meta: Row): Promise<Row> {
  expect(typeof mod.stampPendingLand).toBe("function");
  mod.__setOwnCheckDepsForTests?.({
    readGap: async () => ({ shape: "substrateGap", body: { gaps: [row(meta)] } }),
    writeGap: async (p) => { writes.push(p); return { shape: "substrateGapWriteResult", body: { id: GAP, action: "updated" } }; },
    ask: async (p) => { asks.push(p); return { shape: "uiQuestion_write", body: { ok: true } }; },
  });
  await mod.stampPendingLand!({
    gapId: GAP, newSha: SHA, appliedAt: "2026-10-10T22:00:00.000Z", vessel_name: "development-vessel",
    hostRepoRoot: join(dir, "no-such-repo"), gitCmd: "git", landedUnverifiedReason: null,
  });
  expect(writes.length).toBe(1);
  return ((writes[0]!["gap"] as Row)["classification_metadata"] ?? {}) as Row;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cutover-unmeasurable-"));
  delete process.env["MITOSIS_PUSH_CLONE_DIR"];
  writes = []; asks = []; logs = [];
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
});
afterEach(async () => {
  console.log = origLog;
  mod.__setOwnCheckDepsForTests?.(null);
  if (savedClone === undefined) delete process.env["MITOSIS_PUSH_CLONE_DIR"]; else process.env["MITOSIS_PUSH_CLONE_DIR"] = savedClone;
  await rm(dir, { recursive: true, force: true });
});

describe("pending-land stamp: no measurable predicate is flagged to the human lane (must-fail at the parent)", () => {
  it("(a) a route-edit landing with no predicate: stamped pending, pending_unmeasurable recorded, a needs-human ask written, one line names gap and panel", async () => {
    const meta = await stamp({ edit_site: "repos/development-vessel/src/resolvers/target.ts" });
    expect(meta["pending_outcome_verification"]).toBe(SHA);
    expect(meta["pending_unmeasurable"]).toEqual({ reason: "no_predicate", at: "2026-10-10T22:00:00.000Z", sha: SHA, asked: `needs-human-${GAP}` });
    expect(asks.length).toBe(1);
    expect(asks[0]!["type"]).toBe("uiQuestion_write");
    expect(asks[0]!["id"]).toBe(`needs-human-${GAP}`);
    expect(asks[0]!["kind"]).toBe("gap_needs_human");
    const flagged = logs.filter((l) => l.includes("pending-land UNMEASURABLE"));
    expect(flagged.length).toBe(1);
    expect(flagged[0]).toContain(`gap=${GAP}`);
    expect(flagged[0]).toContain(`needs-human-${GAP}`);
    expect(flagged[0]).toContain("ui-write-passthrough");
  });

  it("(a) a previous landing's removed-line durability sentinel is not a predicate: still flagged", async () => {
    const meta = await stamp({
      hardcoded_url: "const X = process.env[\"X\"]", file_path: "repos/development-vessel/src/resolvers/target.ts",
      predicate_source: "removed_line_of_landing_commit",
    });
    expect((meta["pending_unmeasurable"] as Row)?.["reason"]).toBe("no_predicate");
    expect(asks.map((a) => a["id"])).toEqual([`needs-human-${GAP}`]);
  });

  it("(b) control: a landing WITH a measurable predicate (evidence_resolve test_suite) is not flagged, and the flag is cleared", async () => {
    const meta = await stamp({
      edit_site: "repos/development-vessel/src/resolvers/target.ts",
      evidence_resolve: { shape: "test_suite", input: { vessel: "development-vessel", test_file: "test/resolvers/target.test.ts" } },
      pending_unmeasurable: { reason: "no_predicate", at: "2026-10-09T00:00:00.000Z", sha: "feedface00", asked: `needs-human-${GAP}` },
    });
    expect(meta["pending_outcome_verification"]).toBe(SHA);
    expect(meta["pending_unmeasurable"]).toBe("");
    expect(asks).toEqual([]);
    expect(logs.filter((l) => l.includes("pending-land UNMEASURABLE"))).toEqual([]);
  });
});
