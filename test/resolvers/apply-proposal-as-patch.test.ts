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

  it("returns dispatched=null when no proposals exist", async () => {
    const r = await resolveApplyProposalAsPatch({ type: "apply_proposal_as_patch", proposals_dir: proposalsDir, vessels_root: vesselsRoot, pending_path: pendingPath });
    expect(r.shape).toBe("mitosisStaged");
    expect((r.body as { dispatched: unknown }).dispatched).toBeNull();
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
    expect(r.shape).toBe("mitosisStaged");
    const body = r.body as { dispatched: unknown; reason: string; skipped: Array<{ reason: string }> };
    expect(body.dispatched).toBeNull();
    expect(body.reason).toContain("no eligible");
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
    expect(r.shape).toBe("mitosisStaged");
    expect((r.body as { dispatched: unknown }).dispatched).toBeNull();
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

  it("applies search/replace ops from the LLM and writes the patched mitosis file", async () => {
    // Stage vessel + live source where the LLM's search will match exactly once.
    const vesselDir = join(vesselsRoot, "demo-vessel", "src");
    mkdirSync(vesselDir, { recursive: true });
    const liveSrc = "export const VERSION = 'v1';\nexport const NAME = 'demo';\n";
    writeFileSync(join(vesselDir, "z.ts"), liveSrc);
    const proposal = { scenario_id: "auto-srops", required_code_modifications: [{ file: "repos/demo-vessel/src/z.ts", description: "append doc note" }] };
    writeFileSync(join(proposalsDir, "auto-srops-report.json"), JSON.stringify(proposal));

    // Mock the LLM endpoint by setting LLM_COMPLETION_ENDPOINT and standing up
    // a one-shot Bun server that returns a search/replace op array.
    const ops = [{ search: "export const NAME = 'demo';\n", replace: "export const NAME = 'demo';\n// Substrate doc note (2026-06-04): appended\n" }];
    const server = Bun.serve({
      port: 0,
      fetch: async () => new Response(JSON.stringify({ content: JSON.stringify(ops) }), { headers: { "Content-Type": "application/json" } }),
    });
    process.env["LLM_COMPLETION_ENDPOINT"] = `http://127.0.0.1:${server.port}/resolve`;
    try {
      const r = await resolveApplyProposalAsPatch({ type: "apply_proposal_as_patch", proposals_dir: proposalsDir, vessels_root: vesselsRoot, pending_path: pendingPath });
      expect(r.shape).toBe("mitosisStaged");
      const body = r.body as { dispatched?: string; mitosis_root?: string };
      expect(body.dispatched).toBe("auto-srops-report.json");
      // Verify staged file contains the appended line and differs from input.
      const stagedFile = join(body.mitosis_root!, "src/z.ts");
      const staged = await Bun.file(stagedFile).text();
      expect(staged).toContain("Substrate doc note (2026-06-04): appended");
      expect(staged).not.toBe(liveSrc);
    } finally {
      server.stop();
      delete process.env["LLM_COMPLETION_ENDPOINT"];
    }
  });

  it("rejects when LLM ops produce a no-op output", async () => {
    const vesselDir = join(vesselsRoot, "demo-vessel", "src");
    mkdirSync(vesselDir, { recursive: true });
    writeFileSync(join(vesselDir, "n.ts"), "const X = 1;\n");
    writeFileSync(join(proposalsDir, "auto-noop-report.json"), JSON.stringify({ scenario_id: "auto-noop", required_code_modifications: [{ file: "repos/demo-vessel/src/n.ts" }] }));
    const ops = [{ search: "const X = 1;\n", replace: "const X = 1;\n" }]; // search === replace
    const server = Bun.serve({ port: 0, fetch: async () => new Response(JSON.stringify({ content: JSON.stringify(ops) })) });
    process.env["LLM_COMPLETION_ENDPOINT"] = `http://127.0.0.1:${server.port}/resolve`;
    try {
      const r = await resolveApplyProposalAsPatch({ type: "apply_proposal_as_patch", proposals_dir: proposalsDir, vessels_root: vesselsRoot, pending_path: pendingPath });
      expect(r.shape).toBe("structuredError");
      expect((r.body as { detail: string }).detail).toContain("identical to input");
    } finally { server.stop(); delete process.env["LLM_COMPLETION_ENDPOINT"]; }
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
