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

const vesselRoot = resolve(import.meta.dir, "..");
const checkScript = resolve(vesselRoot, "../../packages/shape-dispatch-check/check.ts");

const proc = Bun.spawnSync(["bun", checkScript, vesselRoot], {
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(proc.exitCode ?? 1);
