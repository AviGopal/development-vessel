import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolvePriorFailedAttempts } from "../../src/resolvers/prior-failed-attempts.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("prior_failed_attempts", () => {
  let dir: string;
  beforeEach(() => {
    dir = join(tmpdir(), `pfa-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dir, ".rejected"), { recursive: true });
  });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it("returns an empty-but-valid report when there is no .rejected history", async () => {
    const r = await resolvePriorFailedAttempts({ type: "prior_failed_attempts", proposals_dir: join(dir, "nope") });
    expect(r.shape).toBe("priorFailedAttempts");
    expect((r.body as any).count).toBe(0);
    expect((r.body as any).summary_text).toContain("No prior failed");
  });

  it("surfaces file_path_hallucination rejections with the missing file + prior approach", async () => {
    writeFileSync(join(dir, ".rejected", "auto-1-report.json"), JSON.stringify({
      rejected_at: "2026-06-10T10:09:37.919Z",
      reason: "file_path_hallucination",
      missing: ["repos/development-vessel/src/resolvers/does-not-exist.ts"],
      original_content_preview: '```json\n{\n  "kind": "patch_proposal",\n  "summary": "Add Authorization header to fix 401",\n',
    }));
    const r = await resolvePriorFailedAttempts({ type: "prior_failed_attempts", proposals_dir: dir });
    const b = r.body as any;
    expect(b.count).toBe(1);
    expect(b.attempts[0].reason).toBe("file_path_hallucination");
    expect(b.attempts[0].missing[0]).toContain("does-not-exist.ts");
    expect(b.attempts[0].prior_summary).toContain("Authorization header");
    expect(b.summary_text).toContain("does-not-exist.ts");
  });

  it("prioritises records that match the scenario_id", async () => {
    writeFileSync(join(dir, ".rejected", "unrelated-report.json"), JSON.stringify({
      reason: "file_path_hallucination", missing: ["repos/x/src/a.ts"],
      original_content_preview: '"summary": "unrelated thing"',
    }));
    writeFileSync(join(dir, ".rejected", "typecheck-goal-template-mismatch-report.json"), JSON.stringify({
      reason: "file_path_hallucination", missing: ["repos/activity-api/src/learners/goal-template-mismatch.ts"],
      original_content_preview: '"summary": "add export of WebSocketMessage to broadcaster"',
    }));
    const r = await resolvePriorFailedAttempts({
      type: "prior_failed_attempts",
      proposals_dir: dir,
      scenario_id: "typecheck-activity-api-src-learners-goal-template-mismatch-l21-ts2459",
    });
    const b = r.body as any;
    // v2: the class-similar (typecheck) record is surfaced; the unrelated one is
    // correctly EXCLUDED (orthogonal filtering — only similar traces transfer).
    expect(b.count).toBe(1);
    expect(b.attempts[0].prior_summary).toContain("WebSocketMessage");
  });

  it("ORTHOGONAL transfer: surfaces a similar-class failure from a DIFFERENT scenario/vessel", async () => {
    // A TS2459 import failure recorded on activity-api...
    writeFileSync(join(dir, ".rejected", "ts2459-on-activity-api-report.json"), JSON.stringify({
      reason: "patch_noop",
      target_file: "repos/activity-api/src/learners/goal-template-mismatch.ts",
      detail: "patch_with_tools: aborted — LLM declared done without making any edit (ts2459 import)",
      original_content_preview: '"summary": "export WebSocketMessage from broadcaster to fix TS2459"',
    }));
    // An unrelated auth failure that must NOT transfer.
    writeFileSync(join(dir, ".rejected", "auth-401-report.json"), JSON.stringify({
      reason: "file_path_hallucination", missing: ["repos/identity-vessel/src/auth.ts"],
      original_content_preview: '"summary": "add 401 retry to auth flow"',
    }));
    // ...drafting a DIFFERENT TS2459 gap on a DIFFERENT vessel (goal-host-vessel).
    const r = await resolvePriorFailedAttempts({
      type: "prior_failed_attempts",
      proposals_dir: dir,
      scenario_id: "typecheck-goal-host-vessel-src-index-l44-ts2459-import-mismatch",
    });
    const b = r.body as any;
    expect(b.orthogonal_count).toBeGreaterThanOrEqual(1);
    expect(b.same_scenario_count).toBe(0); // different scenario
    expect(b.summary_text).toContain("SIMILAR GAPS");
    // the TS2459 lesson transferred; the unrelated auth failure did not lead
    expect(b.attempts[0].prior_summary).toContain("WebSocketMessage");
  });

  it("never throws on a malformed record (tolerant)", async () => {
    writeFileSync(join(dir, ".rejected", "bad.json"), "{ not valid json");
    writeFileSync(join(dir, ".rejected", "ok.json"), JSON.stringify({ reason: "x", missing: [] }));
    const r = await resolvePriorFailedAttempts({ type: "prior_failed_attempts", proposals_dir: dir });
    expect((r.body as any).count).toBe(1); // malformed skipped, valid kept
  });
});

describe("prior_failed_attempts — patch no-op signal", () => {
  it("phrases a patch_noop rejection so the drafter knows the patcher made no edit", async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = join(tmpdir(), `pfa-noop-${Date.now()}`);
    mkdirSync(join(dir, ".rejected"), { recursive: true });
    writeFileSync(join(dir, ".rejected", "auto-noop-report.json"), JSON.stringify({
      rejected_at: "2026-06-18T22:00:00Z",
      reason: "patch_noop",
      target_file: "repos/activity-api/src/learners/goal-template-mismatch.ts",
      detail: "patch_with_tools: aborted — LLM declared done 2x without making any edit",
      original_content_preview: '"summary": "export WebSocketMessage from broadcaster"',
    }));
    const { resolvePriorFailedAttempts } = await import("../../src/resolvers/prior-failed-attempts.js");
    const r = await resolvePriorFailedAttempts({ type: "prior_failed_attempts", proposals_dir: dir });
    const b = r.body as any;
    expect(b.count).toBe(1);
    expect(b.attempts[0].reason).toBe("patch_noop");
    expect(b.summary_text).toContain("made NO edit");
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  });
});
