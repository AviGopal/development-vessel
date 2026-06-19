import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolvePriorSuccessfulAttempts } from "../../src/resolvers/prior-successful-attempts.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Write a `.applied/` sentinel + its joined proposal report in one call. */
function landed(dir: string, name: string, sentinel: object, report: object) {
  writeFileSync(join(dir, ".applied", name), JSON.stringify(sentinel));
  writeFileSync(join(dir, name), JSON.stringify(report));
}

describe("prior_successful_attempts", () => {
  let dir: string;
  beforeEach(() => {
    dir = join(tmpdir(), `psa-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dir, ".applied"), { recursive: true });
  });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it("returns an empty-but-valid report when there is no .applied history", async () => {
    const r = await resolvePriorSuccessfulAttempts({ type: "prior_successful_attempts", proposals_dir: join(dir, "nope") });
    expect(r.shape).toBe("priorSuccessfulAttempts");
    expect((r.body as any).count).toBe(0);
    expect((r.body as any).summary_text).toContain("No prior successful");
  });

  it("surfaces a staged success with the winning summary + target, joined from the report", async () => {
    landed(dir, "auto-1-report.json",
      { delegated_to: "patch_with_tools", outcome_shape: "mitosisStaged", applied_at: "2026-06-18T10:00:00Z", content_sha: "abc" },
      { kind: "patch_proposal", summary: "add export of WebSocketMessage to broadcaster",
        required_code_modifications: [{ file: "repos/activity-api/src/websocket/broadcaster.ts", description: "export the type" }] });
    const r = await resolvePriorSuccessfulAttempts({ type: "prior_successful_attempts", proposals_dir: dir });
    const b = r.body as any;
    expect(b.count).toBe(1);
    expect(b.attempts[0].won_summary).toContain("WebSocketMessage");
    expect(b.attempts[0].target_file).toContain("broadcaster.ts");
    expect(b.summary_text).toContain("REUSE");
  });

  it("FILTERS OUT skip-markers (file_path_hallucination + structuredError are NOT successes)", async () => {
    landed(dir, "halluc-report.json",
      { rejected_at: "2026-06-18T10:00:00Z", reason: "file_path_hallucination", missing: ["repos/x/src/nope.ts"], content_sha: "h1" },
      { kind: "patch_proposal", summary: "halluc" });
    landed(dir, "noop-report.json",
      { delegated_to: "patch_with_tools", outcome_shape: "structuredError", applied_at: "2026-06-18T10:01:00Z", content_sha: "h2" },
      { kind: "patch_proposal", summary: "noop" });
    const r = await resolvePriorSuccessfulAttempts({ type: "prior_successful_attempts", proposals_dir: dir });
    expect((r.body as any).count).toBe(0);
  });

  it("recognises a multifile/new_files staged success", async () => {
    landed(dir, "newfiles-report.json",
      { staged_at: "2026-06-18T11:00:00Z", mitosis_version_id: "v1", multifile: true, file_count: 3, content_sha: "m1" },
      { new_files: [{ path: "repos/development-vessel/src/resolvers/new-thing.ts" }] });
    const r = await resolvePriorSuccessfulAttempts({ type: "prior_successful_attempts", proposals_dir: dir });
    const b = r.body as any;
    expect(b.count).toBe(1);
    expect(b.attempts[0].target_file).toContain("new-thing.ts");
  });

  it("ORTHOGONAL transfer: surfaces a similar-class success from a DIFFERENT scenario/vessel", async () => {
    // A TS2459 import fix that LANDED on activity-api...
    landed(dir, "ts2459-on-activity-api-report.json",
      { delegated_to: "patch_with_tools", outcome_shape: "mitosisStaged", applied_at: "2026-06-18T10:00:00Z", content_sha: "t1" },
      { kind: "patch_proposal", summary: "export WebSocketMessage from broadcaster to fix TS2459",
        required_code_modifications: [{ file: "repos/activity-api/src/websocket/broadcaster.ts" }] });
    // ...and an unrelated auth success that must NOT transfer.
    landed(dir, "auth-401-report.json",
      { delegated_to: "patch_with_tools", outcome_shape: "mitosisStaged", applied_at: "2026-06-18T10:01:00Z", content_sha: "t2" },
      { kind: "patch_proposal", summary: "add retry to login flow",
        required_code_modifications: [{ file: "repos/identity-vessel/src/login.ts" }] });
    // drafting a DIFFERENT TS2459 gap on goal-host-vessel.
    const r = await resolvePriorSuccessfulAttempts({
      type: "prior_successful_attempts",
      proposals_dir: dir,
      scenario_id: "typecheck-goal-host-vessel-src-index-l44-ts2459-import-mismatch",
    });
    const b = r.body as any;
    expect(b.orthogonal_count).toBeGreaterThanOrEqual(1);
    expect(b.same_scenario_count).toBe(0); // different scenario
    expect(b.summary_text).toContain("SIMILAR GAPS");
    // the TS2459 winning shape transferred; the unrelated auth success did not lead
    expect(b.attempts[0].won_summary).toContain("WebSocketMessage");
  });

  it("never throws on a malformed sentinel (tolerant)", async () => {
    writeFileSync(join(dir, ".applied", "bad.json"), "{ not valid json");
    landed(dir, "ok-report.json",
      { delegated_to: "patch_with_tools", outcome_shape: "mitosisStaged", applied_at: "2026-06-18T10:00:00Z", content_sha: "o1" },
      { kind: "patch_proposal", summary: "a real landed fix", required_code_modifications: [{ file: "repos/x/src/a.ts" }] });
    const r = await resolvePriorSuccessfulAttempts({ type: "prior_successful_attempts", proposals_dir: dir });
    expect((r.body as any).count).toBe(1); // malformed skipped, valid kept
  });
});
