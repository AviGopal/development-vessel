// Vessel path forms shared by the check-supply gates and feature_compose's plan-path rule. A leaf module (no imports):
// feature-compose.ts imports it statically, which it cannot do with check-supply-admission.ts (that module imports
// gap-to-feature.ts, which imports feature-compose.ts).

/**
 * THE VESSEL ROOTS a written or planned path can carry, each ANCHORED at the path start, so a repos/, vessels/ or compose
 * directory nested anywhere inside a path is a directory of that vessel, never a root. They are the roots the producers use:
 *   - /workspace/git/compose/<compose-id>/<vessel>/: an isolated compose's worktree (compose-workspace.ts
 *     acquireComposeWorkspace: WS_ROOT/<id>/<vessel>, exactly two single segments; a one-segment form is not a root);
 *   - /workspace/git/vessels/<vessel>/: the push clones (MITOSIS_PUSH_CLONE_DIR);
 *   - /vessels/<vessel>/: the runtime root (RUNTIME_ROOT; opAbs writes there when a compose is not isolated);
 *   - repos/<vessel>/ after any ./: a planner op path, and every edit site gap-check-supply writes.
 */
export const VESSEL_ROOTS: readonly RegExp[] = [
  /^\/workspace\/git\/compose\/[^/]+\/[^/]+\/(.+)$/,
  /^\/workspace\/git\/vessels\/[^/]+\/(.+)$/,
  /^\/vessels\/[^/]+\/(.+)$/,
  /^(?:\.\/)*repos\/[^/]+\/(.+)$/,
];
export function underVesselRoot(p: string): string | undefined {
  for (const re of VESSEL_ROOTS) { const m = re.exec(p); if (m) return m[1]; }
  return undefined;
}
/**
 * A path under no root is taken as vessel-relative only when it starts (after any ./) with test/ or src/: the two
 * vessel-relative trees the gates name (the check's test/checks/<file>, and the src/ an edit site lives in). No producer
 * emits a bare path; the bare and ./ forms are the existing controls. Anything else resolves to nothing (refused).
 */
const VESSEL_RELATIVE_TOP_RE = /^(?:test|src)\//;

/** A diff path in its vessel-relative form (under one of VESSEL_ROOTS, or a bare test/ or src/ path), or null: a '..' path, or a path under no root. */
export function vesselRelativePath(path: string): string | null {
  const p = String(path ?? "").replace(/:\d+.*$/, "").trim().replace(/\\/g, "/");
  if (!p || p.split("/").includes("..")) return null;
  const bare = p.replace(/^(?:\.\/)+/, "");
  return underVesselRoot(p) ?? (VESSEL_RELATIVE_TOP_RE.test(bare) ? bare : null);
}

/** The characters a model-derived path may carry: no whitespace, quote, `$`, backtick, `;`, `|`, `&`, `<`, `>`, `\`, `:`, NUL or newline. */
const PLAN_PATH_CHARS_RE = /^[A-Za-z0-9._/@+-]+$/;
const PLAN_PATH_REPOS_RE = /^(?:\.\/)*repos\/[^/]+\/[^/]/;
/**
 * THE PATH RULE FOR A MODEL-DERIVED PATH (a drafted op path, a repair target). Such a path is joined onto a vessel root and
 * reaches the tools shell (bash -c), so it must be a plain vessel-relative path under repos/<vessel>/ (the planner's form;
 * VESSEL_ROOTS' anchored repos/ root, resolved by vesselRelativePath), in PLAN_PATH_CHARS_RE, with no '..' segment and no
 * leading '/', and no '.' or empty segment after any leading ./. Returns the rule broken, or null. The reason never quotes the path: it goes to the drafter and the journal.
 */
export function planPathProblem(path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0) return "an op path must be a non-empty string";
  if (!PLAN_PATH_CHARS_RE.test(path)) return "an op path may contain only letters, digits and . _ / @ + - (no whitespace, quotes, shell metacharacters, ':' or control characters)";
  if (path.startsWith("/")) return "an op path must be vessel-relative (repos/<vessel>/...), not absolute";
  if (path.split("/").includes("..")) return "an op path must not contain a '..' segment";
  // After any leading ./, no '.' or empty segment: repos/./x would resolve to the repo root, outside every vessel.
  if (path.replace(/^(?:\.\/)+/, "").split("/").some((seg) => seg === "." || seg === "")) return "an op path must not contain a '.' or empty segment";
  if (!PLAN_PATH_REPOS_RE.test(path) || vesselRelativePath(path) === null) return "an op path must name a file under repos/<vessel>/";
  return null;
}
