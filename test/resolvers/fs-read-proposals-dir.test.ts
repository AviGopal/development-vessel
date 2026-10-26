/**
 * observe-and-author-from-gaps' read_dedupe_map task must be able to read the dedupe map its own
 * update_dedupe_map task wrote.
 *
 * THE DEFECT THIS PINS. Same class as d714392b (PATTERNS_DIR / the failure-mode scenario queues):
 * draft-gap-closing-activity's write_proposal / write_proposal_draft tasks and resolver-author's
 * auto-resolver report task write JSON under the volume dir /workspace/proposals, and
 * observe-and-author-from-gaps' own update_dedupe_map task writes the dedupe map there too — the
 * template's proposals_dir default is the same dir. read_dedupe_map then opens
 * {{proposals_dir}}/_auto_dispatched.json with fs_read, whose guard roots at WORKSPACE_ROOT, the
 * super-repo clone. So that read was refused "path outside workspace root" on every run and the
 * dedupe map was never seen, even though it was written. The shared read guard
 * (resolveInAnyWorkspaceForRead, used by fs_list / fs_grep) refuses the same dir the same way.
 *
 * The test never writes the volume: the guard runs before the existence check, so an
 * allow_missing read of an absent volume file is refused by the guard at the old code and comes
 * back `missing: true` once the dir is a read root. The content leg reads a real dedupe-map
 * fixture under a pinned tmp root and proves what read_dedupe_map hands the prompt.
 *
 * Controls: a ../ escape out of proposals, a path outside every root, and a proposals-prefixed
 * look-alike dir all stay refused.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveFsRead } from "../../src/resolvers/fs-read.js";
import { resolveInAnyWorkspaceForRead } from "../../src/resolvers/workspace-roots.js";
import { OBSERVE_AND_AUTHOR_FROM_GAPS_TEMPLATE } from "../../src/seed/observe-and-author-from-gaps.js";
import { PROPOSALS_DIR } from "../../src/config.js";

const PINNED = ["WORKSPACE_ROOT", "EXTRA_WORKSPACE_ROOTS", "FS_READ_EXTRA_ROOTS", "MITOSIS_RUNTIME_DIR"] as const;
const saved: Record<string, string | undefined> = {};
let root = "";

// Pin every env input the guard reads. A MITOSIS_RUNTIME_DIR or extra root pointing at the volume
// would turn the red leg green on the unfixed code, so all of them are cleared.
beforeEach(() => {
  for (const k of PINNED) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), "fsread-proposals-dir-"));
  process.env["WORKSPACE_ROOT"] = root;
  delete process.env["EXTRA_WORKSPACE_ROOTS"];
  delete process.env["FS_READ_EXTRA_ROOTS"];
  delete process.env["MITOSIS_RUNTIME_DIR"];
});
afterEach(() => {
  for (const k of PINNED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

const readDedupeMap = OBSERVE_AND_AUTHOR_FROM_GAPS_TEMPLATE.tasks.find((t) => t.id === "read_dedupe_map")!;
const proposalsDirDefault = OBSERVE_AND_AUTHOR_FROM_GAPS_TEMPLATE.variables!.find((v) => v.name === "proposals_dir")!
  .default as string;

/** The read_dedupe_map task's fs_read config, interpolated the way the engine fills {{var}}. */
function readDedupeMapConfig(vars: { proposals_dir: string }): { type: "fs_read"; path: string } {
  const cfg = readDedupeMap.config as { type: "fs_read"; path: string };
  return { ...cfg, path: cfg.path.replace("{{proposals_dir}}", vars.proposals_dir) };
}

describe("observe-and-author-from-gaps read_dedupe_map reads the volume proposals dir", () => {
  test("MUST-FAIL: the template's own default proposals_dir passes the fs_read guard", async () => {
    expect(proposalsDirDefault).toBe("/workspace/proposals");
    const cfg = readDedupeMapConfig({ proposals_dir: proposalsDirDefault });
    const r = await resolveFsRead({ ...cfg, allow_missing: true });
    expect(r.shape).toBe("fileContent");
    expect((r.body as { missing?: boolean }).missing).toBe(true);
  });

  test("content leg: a real dedupe-map file flows through read_dedupe_map as parseable JSON", async () => {
    writeFileSync(join(root, "_auto_dispatched.json"), JSON.stringify({ "the-example-gap-id": "2026-10-01T00:00:00.000Z" }));
    const r = await resolveFsRead(readDedupeMapConfig({ proposals_dir: root }));
    const map = JSON.parse((r.body as { content: string }).content);
    expect(map["the-example-gap-id"]).toBe("2026-10-01T00:00:00.000Z");
  });

  test("x.json under the real PROPOSALS_DIR constant is a read root", async () => {
    const r = await resolveFsRead({ type: "fs_read", path: `${PROPOSALS_DIR}/x.json`, allow_missing: true });
    expect((r.body as { missing?: boolean }).missing).toBe(true);
  });

  test("the shared read guard (fs_list, fs_grep) accepts the proposals dir", () => {
    expect(resolveInAnyWorkspaceForRead(PROPOSALS_DIR, root)).toBe(PROPOSALS_DIR);
    expect(resolveInAnyWorkspaceForRead(`${PROPOSALS_DIR}/x.json`, root)).toBe(`${PROPOSALS_DIR}/x.json`);
  });
});

describe("CONTROL: nothing else becomes reachable", () => {
  const refused = [
    "/workspace/proposals/../gaps/gaps.json", // escape out of proposals
    "/workspace/gaps/gaps.json", // outside every root
    "/workspace/proposals-evil/x.json", // prefix look-alike
  ];
  for (const p of refused) {
    test(`fs_read refuses ${p}`, async () => {
      await expect(resolveFsRead({ type: "fs_read", path: p, allow_missing: true })).rejects.toThrow("path outside workspace root");
    });
    test(`the shared read guard refuses ${p}`, () => {
      expect(() => resolveInAnyWorkspaceForRead(p, root)).toThrow("path outside workspace root");
    });
  }
});
