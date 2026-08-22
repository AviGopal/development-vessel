/**
 * workspace-roots: a relative path must resolve against a ROOT, not cwd.
 *
 * THE REGRESSION THESE PIN. `assertInAnyWorkspace` did `resolve(path)`
 * unconditionally. For a relative path node resolves against process.cwd(), and
 * no fs resolver runs with cwd == WORKSPACE_ROOT — measured live,
 * development-vessel runs with cwd=/vessels/development-vessel while
 * WORKSPACE_ROOT=/workspace/git/super-repo. So every relative path resolved to
 * a location the caller never named, `relative()` returned a `..`-prefixed
 * string against every root, and the guard threw.
 *
 * Consequence: EVERY relative path was rejected, always. `repos/<vessel>/src/…`
 * is the form the operator docs tell callers to use and the form
 * feature_compose emits, so the substrate's autonomous edit path could not write
 * vessel source at all. Observed as `fs_edit: HTTP 500 path outside workspace
 * root: repos/identity-vessel/src/index.ts` against a file that exists.
 *
 * The traversal cases are the reason this file exists at all: the fix must make
 * legitimate relative paths work WITHOUT widening what is reachable.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "path";
import {
  assertInAnyWorkspace,
  resolveInAnyWorkspace,
  resolveInAnyWorkspaceForRead,
} from "../../src/resolvers/workspace-roots.js";

const ROOT = "/workspace/git/super-repo";
const savedExtra = process.env["EXTRA_WORKSPACE_ROOTS"];
const savedMitosis = process.env["MITOSIS_RUNTIME_DIR"];

// Pin BOTH env inputs. MITOSIS_RUNTIME_DIR is not hypothetical hygiene: another
// suite in this repo sets it, so the read-root test passed alone and failed in a
// full `bun test` run until it was pinned here.
beforeEach(() => {
  delete process.env["EXTRA_WORKSPACE_ROOTS"];
  delete process.env["MITOSIS_RUNTIME_DIR"];
});
afterEach(() => {
  if (savedExtra === undefined) delete process.env["EXTRA_WORKSPACE_ROOTS"];
  else process.env["EXTRA_WORKSPACE_ROOTS"] = savedExtra;
  if (savedMitosis === undefined) delete process.env["MITOSIS_RUNTIME_DIR"];
  else process.env["MITOSIS_RUNTIME_DIR"] = savedMitosis;
});

describe("resolveInAnyWorkspace", () => {
  test("THE REGRESSION: a relative path resolves against the root, not cwd", () => {
    // Threw before the fix, for every possible cwd that is not ROOT.
    expect(resolveInAnyWorkspace("repos/activity-api/src/routes/activities.ts", ROOT)).toBe(
      `${ROOT}/repos/activity-api/src/routes/activities.ts`,
    );
  });

  test("the exact path observed failing in production is accepted", () => {
    expect(resolveInAnyWorkspace("repos/identity-vessel/src/index.ts", ROOT)).toBe(
      `${ROOT}/repos/identity-vessel/src/index.ts`,
    );
  });

  test("an absolute path inside the root still passes, unchanged", () => {
    const abs = `${ROOT}/repos/development-vessel/src/cli.ts`;
    expect(resolveInAnyWorkspace(abs, ROOT)).toBe(abs);
  });

  test("./-prefixed relative paths resolve too", () => {
    expect(resolveInAnyWorkspace("./docs/SUBSTRATE.md", ROOT)).toBe(`${ROOT}/docs/SUBSTRATE.md`);
  });

  // ---- containment is NOT widened -------------------------------------------

  test("NEGATIVE CONTROL: relative traversal out of the root is still rejected", () => {
    expect(() => resolveInAnyWorkspace("../../etc/passwd", ROOT)).toThrow(
      /path outside workspace root/,
    );
  });

  test("NEGATIVE CONTROL: traversal that re-enters via .. is still rejected", () => {
    expect(() => resolveInAnyWorkspace("repos/../../../etc/shadow", ROOT)).toThrow(
      /path outside workspace root/,
    );
  });

  test("NEGATIVE CONTROL: an absolute path outside every root is still rejected", () => {
    expect(() => resolveInAnyWorkspace("/etc/passwd", ROOT)).toThrow(/path outside workspace root/);
  });

  test("NEGATIVE CONTROL: a sibling directory sharing a name prefix is rejected", () => {
    // `/workspace/git/super-repo-evil` must not pass a naive startsWith check.
    expect(() => resolveInAnyWorkspace(`${ROOT}-evil/x.ts`, ROOT)).toThrow(
      /path outside workspace root/,
    );
  });

  // ---- extra roots -----------------------------------------------------------

  test("EXTRA_WORKSPACE_ROOTS opens an additional root, and relatives resolve under it", () => {
    process.env["EXTRA_WORKSPACE_ROOTS"] = "/vessels/packages";
    expect(resolveInAnyWorkspace("/vessels/packages/shared/index.ts", ROOT)).toBe(
      "/vessels/packages/shared/index.ts",
    );
    // A relative path binds to the FIRST root it is contained by; ROOT wins here.
    expect(resolveInAnyWorkspace("a.ts", ROOT)).toBe(`${ROOT}/a.ts`);
  });

  test("a path only reachable under an extra root still resolves there", () => {
    process.env["EXTRA_WORKSPACE_ROOTS"] = "/vessels/packages";
    expect(() => resolveInAnyWorkspace("/vessels/packages/x.ts", ROOT)).not.toThrow();
  });
});

describe("resolveInAnyWorkspaceForRead", () => {
  test("additionally allows the mitosis runtime dir", () => {
    expect(resolveInAnyWorkspaceForRead("/vessels/development-vessel/src/cli.ts", ROOT)).toBe(
      "/vessels/development-vessel/src/cli.ts",
    );
  });

  test("NEGATIVE CONTROL: still rejects outside every read root", () => {
    expect(() => resolveInAnyWorkspaceForRead("/etc/passwd", ROOT)).toThrow(
      /path outside workspace root/,
    );
  });
});

describe("assertInAnyWorkspace (back-compat wrapper)", () => {
  test("returns void and does not throw for a valid relative path", () => {
    expect(assertInAnyWorkspace("repos/activity-api/src/index.ts", ROOT)).toBeUndefined();
  });

  test("still throws for traversal", () => {
    expect(() => assertInAnyWorkspace("../../etc/passwd", ROOT)).toThrow(
      /path outside workspace root/,
    );
  });
});

describe("cwd independence", () => {
  test("the result does not depend on process.cwd()", () => {
    // The whole defect was a hidden dependency on cwd. Resolving the same
    // relative path must give the same answer regardless of where we run.
    const first = resolveInAnyWorkspace("repos/x/src/y.ts", ROOT);
    expect(first).toBe(`${ROOT}/repos/x/src/y.ts`);
    expect(first).not.toContain(resolve(process.cwd()));
  });
});
