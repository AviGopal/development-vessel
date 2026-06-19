import { describe, it, expect, beforeEach } from "bun:test";
import { resolveApplyProposalAsPatch } from "../../src/resolvers/apply-proposal-as-patch.js";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function freshDir(suffix: string): string {
  const d = join(tmpdir(), `apply-proposal-test-${Date.now()}-${suffix}`);
  mkdirSync(d, { recursive: true });
  return d;
}

describe("apply_proposal_as_patch resolver", () => {
  let proposalsDir: string;
  let vesselsRoot: string;
  let pendingPath: string;

  beforeEach(() => {
    const base = freshDir(Math.random().toString(36).slice(2, 8));
    proposalsDir = join(base, "proposals");
    vesselsRoot = join(base, "vessels");
    pendingPath = join(base, "mitosis-pending.json");
    mkdirSync(proposalsDir, { recursive: true });
    mkdirSync(vesselsRoot, { recursive: true });
    process.env["WORKSPACE_ROOT"] = base;
  });

  it("returns structuredError(no eligible) when no proposals exist", async () => {
    // Contract (2026-06-06): no-work is a no-op outcome surfaced as structuredError
    // so boredom Thompson posteriors don't record an empty win.
    const r = await resolveApplyProposalAsPatch({ type: "apply_proposal_as_patch", proposals_dir: proposalsDir, vessels_root: vesselsRoot, pending_path: pendingPath });
    expect(r.shape).toBe("structuredError");
    expect((r.body as { detail: string }).detail).toContain("no eligible");
  });

  it("dry-run identifies target proposal and computes base SHA without writing", async () => {
    // Stage a vessel + live source.
    const vesselDir = join(vesselsRoot, "demo-vessel", "src", "resolvers");
    mkdirSync(vesselDir, { recursive: true });
    writeFileSync(join(vesselDir, "scan.ts"), "export const VERSION = 'v1';\n");
    // Stage a proposal report referencing that file.
    const proposal = {
      scenario_id: "auto-1780600000999-demo",
      required_code_modifications: [{ file: "repos/demo-vessel/src/resolvers/scan.ts", function: "scan" }],
    };
    writeFileSync(join(proposalsDir, "auto-1780600000999-demo-report.json"), JSON.stringify(proposal));
    const r = await resolveApplyProposalAsPatch({
      type: "apply_proposal_as_patch",
      proposals_dir: proposalsDir,
      vessels_root: vesselsRoot,
      pending_path: pendingPath,
      dry_run: true,
    });
    expect(r.shape).toBe("mitosisStaged");
    const body = r.body as { dry_run?: boolean; would_stage?: { vessel: string; base_sha: string; target: string } };
    expect(body.dry_run).toBe(true);
    expect(body.would_stage?.vessel).toBe("demo-vessel");
    expect(body.would_stage?.base_sha).toMatch(/^[0-9a-f]{12}$/);
    expect(body.would_stage?.target).toBe("repos/demo-vessel/src/resolvers/scan.ts");
    expect(existsSync(pendingPath)).toBe(false);
  });

  it("skips fieldless / malformed proposals and reports them in skipped[]", async () => {
    writeFileSync(join(proposalsDir, "auto-bad-report.json"), JSON.stringify({ scenario_id: "auto-bad", notes: "no mods" }));
    writeFileSync(join(proposalsDir, "auto-truncated-report.json"), '{"scenario_id":"auto-truncated", "required_code_mod'); // intentional truncation
    const r = await resolveApplyProposalAsPatch({ type: "apply_proposal_as_patch", proposals_dir: proposalsDir, vessels_root: vesselsRoot, pending_path: pendingPath, dry_run: true });
    expect(r.shape).toBe("structuredError");
    const body = r.body as { detail: string; skipped: Array<{ reason: string }> };
    expect(body.detail).toContain("no eligible");
    expect(body.skipped.some((s) => s.reason === "no_required_code_modifications")).toBe(true);
    expect(body.skipped.some((s) => s.reason === "parse_failed")).toBe(true);
  });

  it("skips proposals whose scenario already has a mitosis dir", async () => {
    // Create vessel + proposal as before.
    const vesselDir = join(vesselsRoot, "demo-vessel", "src");
    mkdirSync(vesselDir, { recursive: true });
    writeFileSync(join(vesselDir, "x.ts"), "x");
    const scenarioId = "auto-skipme-report"; // will become "auto-skipme" after replace
    const sid = scenarioId.replace(/-report$/, "");
    const proposal = { scenario_id: sid, required_code_modifications: [{ file: "repos/demo-vessel/src/x.ts" }] };
    writeFileSync(join(proposalsDir, `${sid}-report.json`), JSON.stringify(proposal));
    // Pre-stage a matching mitosis dir.
    mkdirSync(join(vesselsRoot, `demo-vessel-mitosis-${sid.slice(0, 32)}-2026`), { recursive: true });
    const r = await resolveApplyProposalAsPatch({ type: "apply_proposal_as_patch", proposals_dir: proposalsDir, vessels_root: vesselsRoot, pending_path: pendingPath, dry_run: true });
    expect(r.shape).toBe("structuredError");
    expect((r.body as { detail: string }).detail).toContain("no eligible");
  });

  it("tolerates multi-object LLM output (proposal + addendum/narrative)", async () => {
    // LLM commonly emits the proposal JSON, then markdown narrative, then a
    // second JSON object (addendum / learning notes). The brace-aware walker
    // must extract just the first balanced object.
    const vesselDir = join(vesselsRoot, "demo-vessel", "src");
    mkdirSync(vesselDir, { recursive: true });
    writeFileSync(join(vesselDir, "y.ts"), "y");
    const main = JSON.stringify({
      scenario_id: "auto-multi",
      required_code_modifications: [{ file: "repos/demo-vessel/src/y.ts", change: "x" }],
    });
    const tail = '\n```\n\n**Key Finding:** narrative here\n\n{"learning_note": "addendum"}\n';
    writeFileSync(join(proposalsDir, "auto-multi-report.json"), main + tail);
    const r = await resolveApplyProposalAsPatch({ type: "apply_proposal_as_patch", proposals_dir: proposalsDir, vessels_root: vesselsRoot, pending_path: pendingPath, dry_run: true });
    expect(r.shape).toBe("mitosisStaged");
    const body = r.body as { dry_run?: boolean; would_stage?: { vessel: string; target: string } };
    expect(body.dry_run).toBe(true);
    expect(body.would_stage?.vessel).toBe("demo-vessel");
    expect(body.would_stage?.target).toBe("repos/demo-vessel/src/y.ts");
  });

  it("(Seam ③) chooses an EXISTING edit target (required_code_modifications) via dry-run", async () => {
    // An edit target that exists on disk is selected and routed to the patcher
    // (verified here in dry-run so we don't mock the whole patcher surface).
    const vesselDir = join(vesselsRoot, "demo-vessel", "src");
    mkdirSync(vesselDir, { recursive: true });
    writeFileSync(join(vesselDir, "z.ts"), "export const VERSION = 'v1';\n");
    const proposal = { scenario_id: "auto-edit", required_code_modifications: [{ file: "repos/demo-vessel/src/z.ts", description: "add an `export const FLAG = true;` line" }] };
    writeFileSync(join(proposalsDir, "auto-edit-report.json"), JSON.stringify(proposal));
    const r = await resolveApplyProposalAsPatch({ type: "apply_proposal_as_patch", proposals_dir: proposalsDir, vessels_root: vesselsRoot, pending_path: pendingPath, dry_run: true });
    expect(r.shape).toBe("mitosisStaged");
    const body = r.body as { dry_run?: boolean; would_stage?: { target: string; is_new_file?: boolean } };
    expect(body.dry_run).toBe(true);
    expect(body.would_stage?.target).toBe("repos/demo-vessel/src/z.ts");
    expect(body.would_stage?.is_new_file).toBe(false);
  });

  it("(Seam ③ / Change 2) ABSENT new_file is now ACCEPTED (dead-gate fixed)", async () => {
    // A genuinely-new file (declared with full content) whose path does NOT
    // exist on disk must NO LONGER be rejected as file_path_hallucination.
    const proposal = {
      scenario_id: "auto-newfile-ok",
      new_files: [
        { path: "repos/demo-vessel/src/resolvers/freshly-authored.ts", content: "export const NEW = 1;\n" },
      ],
    };
    writeFileSync(join(proposalsDir, "auto-newfile-ok-report.json"), JSON.stringify(proposal));
    const r = await resolveApplyProposalAsPatch({ type: "apply_proposal_as_patch", proposals_dir: proposalsDir, vessels_root: vesselsRoot, pending_path: pendingPath });
    expect(r.shape).toBe("mitosisStaged");
    const body = r.body as { dispatched: string; multifile: boolean; staged_files: string[] };
    expect(body.dispatched).toContain("auto-newfile-ok");
    expect(body.multifile).toBe(true);
    expect(body.staged_files).toContain("src/resolvers/freshly-authored.ts");
  });

  it("(Seam ③ / Change 2) a new_file that ALREADY exists → new_file_collision", async () => {
    const vesselDir = join(vesselsRoot, "demo-vessel", "src", "resolvers");
    mkdirSync(vesselDir, { recursive: true });
    writeFileSync(join(vesselDir, "collides.ts"), "export const ALREADY = 1;\n");
    const proposal = {
      scenario_id: "auto-collision",
      new_files: [
        { path: "repos/demo-vessel/src/resolvers/collides.ts", content: "export const NEW = 2;\n" },
      ],
    };
    writeFileSync(join(proposalsDir, "auto-collision-report.json"), JSON.stringify(proposal));
    const r = await resolveApplyProposalAsPatch({ type: "apply_proposal_as_patch", proposals_dir: proposalsDir, vessels_root: vesselsRoot, pending_path: pendingPath });
    // The colliding proposal is skipped (rejected) → no eligible proposal remains.
    expect(r.shape).toBe("structuredError");
    const body = r.body as { detail: string; skipped?: Array<{ reason: string }> };
    expect(body.detail).toContain("no eligible");
    expect((body.skipped ?? []).some((s) => s.reason.startsWith("new_file_collision"))).toBe(true);
  });

  it("tolerates markdown fences around the proposal JSON", async () => {
    const vesselDir = join(vesselsRoot, "demo-vessel", "src");
    mkdirSync(vesselDir, { recursive: true });
    writeFileSync(join(vesselDir, "x.ts"), "x");
    const fenced = "```json\n" + JSON.stringify({ scenario_id: "auto-fenced", required_code_modifications: [{ file: "repos/demo-vessel/src/x.ts" }] }) + "\n```";
    writeFileSync(join(proposalsDir, "auto-fenced-report.json"), fenced);
    const r = await resolveApplyProposalAsPatch({ type: "apply_proposal_as_patch", proposals_dir: proposalsDir, vessels_root: vesselsRoot, pending_path: pendingPath, dry_run: true });
    expect(r.shape).toBe("mitosisStaged");
    expect((r.body as { dry_run: boolean }).dry_run).toBe(true);
  });

  it("stages multi-file proposal via new_files[] without invoking LLM", async () => {
    // Multi-file proposal: 4 files (new resolver + test + 2 patches expressed as
    // full-content). All same-vessel.
    const proposal = {
      scenario_id: "auto-newresolver-1780700000000",
      new_files: [
        { path: "repos/demo-vessel/src/resolvers/git-status-with-dirty-files.ts", content: "export const NEW = 'resolver';\n" },
        { path: "repos/demo-vessel/test/resolvers/git-status-with-dirty-files.test.ts", content: "// test\n" },
        { path: "repos/demo-vessel/src/config-patched.ts", content: "// config\n" },
        { path: "repos/demo-vessel/src/impulses-patched.ts", content: "// impulses\n" },
      ],
    };
    writeFileSync(join(proposalsDir, "auto-newresolver-1780700000000-report.json"), JSON.stringify(proposal));
    const r = await resolveApplyProposalAsPatch({ type: "apply_proposal_as_patch", proposals_dir: proposalsDir, vessels_root: vesselsRoot, pending_path: pendingPath });
    expect(r.shape).toBe("mitosisStaged");
    const body = r.body as { dispatched: string; multifile: boolean; staged_files: string[]; vessel_name: string };
    expect(body.dispatched).toContain("auto-newresolver");
    expect(body.multifile).toBe(true);
    expect(body.staged_files.length).toBe(4);
    expect(body.vessel_name).toBe("demo-vessel");
    // Verify the staged files exist on disk.
    expect(existsSync(pendingPath)).toBe(true);
  });

  it("rejects multi-file proposal that spans more than one vessel", async () => {
    const proposal = {
      scenario_id: "auto-multivessel-bad",
      new_files: [
        { path: "repos/vessel-a/src/x.ts", content: "x" },
        { path: "repos/vessel-b/src/y.ts", content: "y" },
      ],
    };
    writeFileSync(join(proposalsDir, "auto-multivessel-bad-report.json"), JSON.stringify(proposal));
    const r = await resolveApplyProposalAsPatch({ type: "apply_proposal_as_patch", proposals_dir: proposalsDir, vessels_root: vesselsRoot, pending_path: pendingPath });
    expect(r.shape).toBe("structuredError");
    expect((r.body as { detail: string }).detail).toContain("single vessel");
  });
});
