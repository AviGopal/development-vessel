#!/usr/bin/env bun
/**
 * Wrapper that runs the shared shape-dispatch-check against this vessel.
 * Spec R1.5 (amended 2026-05-21 §9.6): `bun run lint` MUST chain
 * tsc --noEmit AND this script; both must pass for CI to green.
 *
 * The check enforces TYPESCRIPT_VESSEL_TEMPLATE.md invariant 2: every
 * shape in `src/config.ts` `discovery.shapes` has a matching dispatch
 * `case` in `src/routes/impulses.ts`, and vice versa.
 */
import { resolve } from "path";
import { existsSync } from "fs";

const vesselRoot = resolve(import.meta.dir, "..");
// Two layouts: host super-repo has packages/ at vesselRoot/../../packages
// (super-repo/repos/<vessel>/...); substrate container has packages/ at
// vesselRoot/../packages (vessels/ is the super-repo equivalent, packages/
// is its sibling). Try grandparent first, then parent — first existing path
// wins. Without this, static-eval gates inside mitosis-overlay symlink
// stacks can't pass and autonomous cutover never produces cited_check_names.
// WALK UPWARD instead of guessing depths. The two fixed candidates below covered the host
// super-repo (<super>/repos/<vessel>) and the container runtime (/vessels/<vessel>), but not a
// checkout at /workspace/repos/<vessel> whose packages/ sits at /vessels/packages — there the
// gate could not run at all, and `bun run lint` silently lost its shape-dispatch half.
// author_new_resolver's Seam ③ test invokes this wrapper over a staged config+impulses splice
// and asserts exit 0, so an unrunnable gate reads as a failed splice.
function findCheckScript(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    const candidate = resolve(dir, "packages/shape-dispatch-check/check.ts");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const candidates = [
  resolve(vesselRoot, "../../packages/shape-dispatch-check/check.ts"),
  resolve(vesselRoot, "../packages/shape-dispatch-check/check.ts"),
];
const checkScript =
  candidates.find((p) => existsSync(p)) ?? findCheckScript(vesselRoot) ?? candidates[0];
if (!existsSync(checkScript)) {
  console.error(
    `check-shape-dispatch: cannot locate packages/shape-dispatch-check/check.ts above ${vesselRoot} — ` +
      "the shape/dispatch agreement gate did NOT run. Failing loudly rather than passing silently.",
  );
  process.exit(1);
}

const proc = Bun.spawnSync(["bun", checkScript, vesselRoot], {
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(proc.exitCode ?? 1);
