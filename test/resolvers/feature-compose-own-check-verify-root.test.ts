// THE DRAFTER IS SHOWN ITS CHECK FROM THE TREE VERIFY RUNS IT IN (finding agf_p80t0k7b3956, DRAFT QUALITY #1).
//
// Measured 2026-10-26/27 on both nodes: about half of own-check drafts logged "[fc-own-check-grounding] … the drafter
// is not shown its check" and were drafted blind. ownCheckGrounding read the check only from the vessel clone's work
// tree (VESSELS_CLONE_ROOT/<vessel>/<test_file>); verify runs the same file with `cd vesselRoot(v) && bun test`, where
// vesselRoot is the compose worktree (pinned to origin/dev), so the drafter and the judge read two different trees.
//
// Expected:
//   - ownCheckGrounding takes the vessel root verify uses (a resolver vessel -> root) and reads the check there first:
//     a check the clone lacks but the verify root holds is shown (MUST-FAIL: at the base the second argument is a
//     string path, so nothing is read and the drafter is shown nothing);
//   - the check's imported modules are resolved against the root the check was read from;
//   - the compose passes its vesselRoot (the root verify's run uses) at the grounding call;
//   - a check only the clone's work tree holds is still shown, from the clone (CONTROL: the earlier reading, kept as
//     the fallback, so a non-isolated compose and the drafter-split corpus read as before);
//   - with no resolver the clone stays the default (CONTROL).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(tmpdir(), `own-check-verify-root-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONE = join(ROOT, "clone");
const VERIFY = join(ROOT, "worktree");
const prevClone = process.env["VESSELS_CLONE_ROOT"];
const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = `perennial-${RUN}-vessel`;
const CHECK = "test/checks/omission-ledger.check.ts";
const NAMED = "omission ledger > keeps the paralegal hassle count";
const CHECK_SRC = [
  'import { describe, expect, it } from "bun:test";',
  'import { subduingHassleCount } from "../../src/omission-ledger";',
  "",
  'describe("omission ledger", () => {',
  '  it("keeps the paralegal hassle count", () => {',
  "    expect(subduingHassleCount({ perennialOmissionOption: 3 })).toBe(3);",
  "  });",
  "});",
  "",
].join("\n");
const put = (root: string, rel: string, text: string): void => {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
};
const meta = () => ({
  edit_site: `repos/${VESSEL}/src/omission-ledger.ts`,
  evidence_resolve: { shape: "test_suite", input: { vessel: `repos/${VESSEL}`, test_file: CHECK, only_tests: [NAMED] }, zero_field: "requested_not_passing" },
});
// The compose's vesselRoot: the worktree verify runs the check in.
const verifyRoot = (v: string): string => join(VERIFY, v);

beforeAll(() => {
  process.env["VESSELS_CLONE_ROOT"] = CLONE;
  // The clone's work tree lacks the check (and its module); the verify root holds both.
  mkdirSync(join(CLONE, VESSEL), { recursive: true });
  put(join(VERIFY, VESSEL), CHECK, CHECK_SRC);
  put(join(VERIFY, VESSEL), "src/omission-ledger.ts", "export function subduingHassleCount(o: { perennialOmissionOption: number }): number { return o.perennialOmissionOption; }\n");
});
afterAll(() => {
  if (prevClone === undefined) delete process.env["VESSELS_CLONE_ROOT"]; else process.env["VESSELS_CLONE_ROOT"] = prevClone;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

describe("the drafter reads its own check where verify runs it", () => {
  it("MUST-FAIL a check the clone lacks but the verify root holds is shown to the drafter, body included", () => {
    expect(typeof fc.ownCheckGrounding).toBe("function");
    const g = fc.ownCheckGrounding(meta(), verifyRoot) as { block: string; source: string } | null;
    expect(g).not.toBeNull();
    expect(g!.block).toContain(`repos/${VESSEL}/${CHECK}`);
    expect(g!.block).toContain("perennialOmissionOption");
    expect(g!.source).toBe(CHECK_SRC);
  });

  it("MUST-FAIL the check's imported modules resolve against the root the check was read from", () => {
    const g = fc.ownCheckGrounding(meta(), verifyRoot) as { vessel: string; test_file: string; only_tests: string[]; source: string; root: string } | null;
    expect(g).not.toBeNull();
    expect(g!.root).toBe(verifyRoot(VESSEL));
    expect(fc.ownCheckImportedModules(g!, () => g!.root)).toEqual([`repos/${VESSEL}/src/omission-ledger.ts`]);
  });

  it("MUST-FAIL the compose grounds its drafter from vesselRoot, the root verify's own-check run uses", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/resolvers/feature-compose.ts"), "utf8");
    expect(src).toMatch(/(?:readOwnCheckGrounding|ownCheckGrounding)\(gapMeta, vesselRoot\)/);
    expect(src).toMatch(/ownCheckImportedModules\(ownCheckCtx, \(\) => ownCheckCtx\.root\)/);
    // Verify's run: the check file alone, in vesselRoot(v).
    expect(src).toMatch(/const vAbs = vesselRoot\(v\);/);
  });

  it("CONTROL with no resolver the clone is the default, so a check only the verify root holds is not read from it", () => {
    expect(fc.ownCheckGrounding(meta())).toBeNull();
  });

  it("CONTROL a check only the clone's work tree holds is still shown, read from the clone", () => {
    const other = `${VESSEL}-clone-only`;
    put(join(CLONE, other), CHECK, CHECK_SRC.replace("perennialOmissionOption", "cloneOnlyOption"));
    const m = { edit_site: `repos/${other}/src/omission-ledger.ts`, evidence_resolve: { shape: "test_suite", input: { vessel: `repos/${other}`, test_file: CHECK, only_tests: [NAMED] }, zero_field: "requested_not_passing" } };
    const g = fc.ownCheckGrounding(m, verifyRoot) as { block: string; root: string } | null;
    expect(g).not.toBeNull();
    expect(g!.block).toContain("cloneOnlyOption");
    expect(g!.root).toBe(join(CLONE, other));
  });
});
