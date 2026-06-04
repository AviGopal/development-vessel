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
const candidates = [
  resolve(vesselRoot, "../../packages/shape-dispatch-check/check.ts"),
  resolve(vesselRoot, "../packages/shape-dispatch-check/check.ts"),
];
const checkScript = candidates.find((p) => existsSync(p)) ?? candidates[0];

const proc = Bun.spawnSync(["bun", checkScript, vesselRoot], {
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(proc.exitCode ?? 1);
