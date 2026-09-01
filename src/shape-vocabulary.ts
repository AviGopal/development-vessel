/**
 * THE ADVERTISED SHAPE VOCABULARY — assembled from local files only.
 *
 * EXTRACTED from feature-compose.ts (2026-09-01). It lived there because the
 * compose lane's shape-vocabulary gate was its first consumer, but the gap WRITE
 * path needs the same vocabulary to tell a usable Class-2 closure predicate from
 * an inert one — and feature-compose.ts already imports substrate-gap.ts, so
 * importing back the other way would close a cycle. Extraction, not duplication:
 * two copies of a "is this name real?" oracle is exactly how a fix applied to one
 * site stops being a fix (this repo has paid that bill more than once).
 * feature-compose.ts re-exports `loadFleetShapeVocabulary` so its public surface,
 * and every existing importer of it, is unchanged.
 *
 * A NAME CROSSING A BOUNDARY IS ONLY CHECKABLE BY RESOLVING IT. Reading cannot
 * distinguish a correct shape name from a plausible one; both are string literals
 * in a valid object. The substrate authored `evidence_resolve: { shape:
 * "failurePatternReport" }` and landed it twice (05458f4, 6b6068e) through
 * typecheck, the semantic gate, two adversarial refuters and a FAVORABLE mitosis
 * verdict. The advertised name is `trace_failure_pattern_report`.
 *
 * AUTHORITY — `src/config.ts` `discovery.shapes`, read as a LOCAL FILE (via the
 * compile-time `DISCOVERY_SHAPES` import for this vessel, plus a best-effort scan
 * of the sibling vessels' `src/config.ts`). Deliberately NOT a call to the live
 * discovery registry: a network blip must not be able to make a consumer fail
 * OPEN silently or fail CLOSED spuriously, and neither the compose lane nor the
 * gap write path can afford a verdict that depends on another unit being up.
 */
import { readFileSync, readdirSync } from "node:fs";
import { DISCOVERY_SHAPES } from "./config.js";

// In-container authoring targets the WRITABLE runtime (/vessels), like the
// surgical patchers (patch_with_tools/apply_proposal_as_patch use vessels_root
// "/vessels"). The host repo bind-mount is READ-ONLY from the container; a
// host-side poller bridges /vessels changes to git. Paths are repos/<vessel>/...
// in a compose plan and mapped to ${RUNTIME_ROOT}/<vessel>/... at apply time.
export const RUNTIME_ROOT = process.env.MITOSIS_RUNTIME_DIR ?? "/vessels";
/**
 * The super-repo push clone.
 *
 * Vessels that are git submodules each get a clone under MITOSIS_PUSH_CLONE_DIR.
 * Vessels committed as plain directories in the super-repo have no clone of their
 * own — they live here, under `repos/<name>`, governed by this clone's .git.
 * A git command run inside the symlinked runtime path walks up and finds it, so
 * the cutover commits and pushes from the right place without special-casing.
 */
export const SUPER_REPO_ROOT = process.env.MITOSIS_SUPER_REPO_DIR ?? "/workspace/git/super-repo";
export const REPO_ROOT = process.env.MITOSIS_REPO_ROOT ?? RUNTIME_ROOT;

export interface ShapeVocabulary {
  shapes: Set<string>;
  configs_read: number;
}

/**
 * `DISCOVERY_SHAPES` (this vessel's own `src/config.ts`) is a compile-time import
 * and therefore cannot fail to load. But the compose lane edits OTHER vessels too,
 * and a predicate authored in activity-api naming an activity-api shape is
 * perfectly correct while being absent from dev-vessel's list. So the vocabulary is
 * WIDENED — never narrowed — by a best-effort scan of every sibling
 * `<vessel>/src/config.ts`. Containment, not parsing: any quoted identifier-shaped
 * literal anywhere in a vessel's config.ts counts. The vessel configs are not
 * uniform (some inline a `shapes: [...]` array, some assign `DISCOVERY_SHAPES`, some
 * have no discovery block at all), so structural parsing would be the fragile choice
 * and its failure mode would be a FALSE REFUSAL. Over-wide is the safe direction
 * here: it costs a missed catch, never a blocked lane or an invented defect.
 *
 * `configs_read` is reported so the caller can refuse to judge when the scan did not
 * demonstrably work — see `detectUnadvertisedShapeLiteral`'s fail-open rule and
 * `classifyFalsifier`'s (substrate-gap.ts), which share the same threshold.
 */
export function loadFleetShapeVocabulary(
  roots?: string[],
  vesselRoots?: string[],
): ShapeVocabulary {
  const shapes = new Set<string>(DISCOVERY_SHAPES);
  let configsRead = 0;
  const harvest = (path: string): void => {
    const text = readFileSync(path, "utf8"); // throws → caller skips
    configsRead++;
    for (const m of text.matchAll(/["'`]([A-Za-z_][A-Za-z0-9_.-]{2,80})["'`]/g)) shapes.add(m[1]!);
  };
  // ISOLATED-COMPOSE ROOTS (2026-09-01, review finding 3). A compose that gets its own
  // worktree edits `${COMPOSE_WS_DIR}/<id>/<vessel>` (compose-workspace.ts), which is
  // under NONE of the fleet roots below. Without these the vocabulary is the ORIGIN
  // view, so a change that ADVERTISES a shape in config.ts and USES it in an
  // evidence_resolve in the SAME diff would be refused for naming a shape that — by
  // the time the sweep runs — is advertised. Caller passes `ws.rootFor(vessel)` for
  // every touched vessel; these are vessel roots (contain src/), not roots-of-vessels.
  for (const vr of vesselRoots ?? []) {
    if (!vr) continue;
    try { harvest(`${vr}/src/config.ts`); } catch { /* not isolated / unreadable — additive */ }
  }
  const candidateRoots = roots ?? [
    RUNTIME_ROOT,
    REPO_ROOT,
    `${SUPER_REPO_ROOT}/repos`,
    process.env["MITOSIS_PUSH_CLONE_DIR"] ?? "/workspace/git/vessels",
  ];
  const seenRoots = new Set<string>();
  for (const root of candidateRoots) {
    if (!root || seenRoots.has(root)) continue;
    seenRoots.add(root);
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch { continue; } // root absent (host-side test run, different layout) — additive scan, skip
    for (const entry of entries) {
      try { harvest(`${root}/${entry}/src/config.ts`); }
      catch { /* not a vessel dir, or unreadable — skip; the scan is additive */ }
    }
  }
  return { shapes, configs_read: configsRead };
}

/**
 * The shared "is this vocabulary trustworthy enough to judge with?" threshold.
 *
 * Below it, every consumer must FAIL OPEN. A scan that read no configs is not
 * evidence that a shape is unadvertised — it is evidence that the scan did not
 * run. Inventing a defect out of an unreadable filesystem is strictly worse than
 * missing one: the missed catch costs a stale gap, the invented defect costs a
 * false refusal on a correct change.
 */
export function vocabularyIsJudgeable(v: ShapeVocabulary | undefined | null): boolean {
  return !!v && v.shapes instanceof Set && v.configs_read >= 5 && v.shapes.size >= 50;
}
