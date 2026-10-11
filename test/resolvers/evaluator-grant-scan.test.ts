// THE EVALUATOR GRANT IS A PATH, NOT A NAME (scope earn-in, REALIGNMENT §7 step 9).
//
// pool-impulse.ts lets autonomyScope be written by a caller whose auth names the accepted evaluator
// (EVALUATOR_TRUST_ROOT_WRITERS: scope_earn_in_apply). The pool cannot see WHO in the process built that auth, so the
// rule that only the applier does is pinned here, over the source: no src file other than
// src/resolvers/scope-earn-in.ts may construct an auth object carrying `evaluator`, assign `.evaluator`, or name the
// grant. pool-impulse.ts may hold the grant map, check a presented grant and stamp the attestation, and nothing else. This file is one of the
// evaluator's own files (EVALUATOR_FILES), so the criterion can never widen autonomy onto it.
//
// The scanner is checked against planted sources first (a positive control), and the applier itself must be found by
// the same scanner: a scan that matches nothing anywhere would pass on a blind pattern.
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const VESSEL_ROOT = join(import.meta.dir, "../..");
const SRC = join(VESSEL_ROOT, "src");
const APPLIER = "src/resolvers/scope-earn-in.ts";
const POOL = "src/resolvers/pool-impulse.ts";
// The constructs pool-impulse.ts is allowed: the grant map, the attestation stamp and the gate's check.
const POOL_ALLOWED = [
  "export const EVALUATOR_TRUST_ROOT_WRITERS: Readonly<Record<string, string>> = { autonomyScope: 'scope_earn_in_apply' };",
  "{ by: 'evaluator', evaluator: auth!.evaluator!, key_id: null, at: now }",
  // The gate's own check of a presented grant (it reads auth.evaluator; it builds nothing).
  "EVALUATOR_TRUST_ROOT_WRITERS[trustRoot] === auth.evaluator",
];

/** Source with comments removed (line and block), string contents kept: a grant can be built from a string. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/** The evaluator-grant constructs in a source text: object keys, shorthand, assignment, bracket access, the name. */
export function grantConstructs(src: string): string[] {
  const code = stripComments(src);
  const pats: Array<[string, RegExp]> = [
    ["evaluator key", /\bevaluator\s*:/g],
    ["evaluator shorthand", /[{,]\s*evaluator\s*[,}]/g],
    ["quoted evaluator key", /["'`]evaluator["'`]\s*[:\]]/g],
    [".evaluator assignment", /\.evaluator\s*=(?!=)/g],
    ["grant name", /scope_earn_in_apply/g],
    ["grant map", /EVALUATOR_TRUST_ROOT_WRITERS/g],
  ];
  const hits: string[] = [];
  for (const [name, re] of pats) for (const m of code.matchAll(re)) hits.push(`${name} @${m.index}`);
  return hits;
}

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p));
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("the evaluator grant scanner (control: green at base)", () => {
  it("positive control: the scanner catches every planted form of a grant from a non-applier caller", () => {
    for (const planted of [
      `resolvePoolImpulseWrite(p, { operator: false, evaluator: "scope_earn_in_apply" });`,
      `const evaluator = X; write(p, { operator: false, evaluator });`,
      `const a: PoolWriteAuth = { operator: false }; a.evaluator = name;`,
      `const a = { operator: false, ["evaluator"]: n };`,
      `const a = { operator: false, 'evaluator': n };`,
      `const n = EVALUATOR_TRUST_ROOT_WRITERS.autonomyScope;`,
    ]) expect(grantConstructs(planted).length).toBeGreaterThan(0);
    // Comments do not count.
    expect(grantConstructs(`// evaluator: scope_earn_in_apply\n/* { evaluator: x } */ const y = 1;`)).toEqual([]);
  });
});

describe("the evaluator grant is constructed only by the applier (must-fail at base)", () => {
  it("the applier is the one src file that builds the grant, and pool-impulse holds only the map and the stamp", () => {
    const offenders: string[] = [];
    let applierHits = 0;
    for (const f of srcFiles(SRC)) {
      const rel = relative(VESSEL_ROOT, f);
      let text = readFileSync(f, "utf8");
      if (rel === APPLIER) { applierHits = grantConstructs(text).filter((h) => h.startsWith("evaluator key")).length; continue; }
      if (rel === POOL) for (const a of POOL_ALLOWED) text = text.split(a).join(" ");
      const hits = grantConstructs(text);
      if (hits.length > 0) offenders.push(`${rel}: ${hits.join(", ")}`);
    }
    expect(offenders).toEqual([]);
    // The applier constructs it exactly once (its one autonomyScope write).
    expect(applierHits).toBe(1);
    // pool-impulse really holds both allowed constructs (else the allowance hides nothing and could hide a rename).
    const pool = readFileSync(join(VESSEL_ROOT, POOL), "utf8");
    for (const a of POOL_ALLOWED) expect(pool).toContain(a);
  });
});

// THE EVALUATOR'S IMPORT CLOSURE (qa, 10-05: no self-certification by import). EVALUATOR_FILES keeps the evaluator out
// of the lane's reach, but a guarded file that imports a lane-editable module can be loosened through that module.
// Semantics, stated:
//   - roots: the item-3 evaluator src files below (scope-earn-in, pool-impulse, test-suite, self-fact-reconcile,
//     rhythm-conductor-tick), and check-supply-admission (an evaluator file on feature-compose's verdict path, whose
//     own imports feature-compose's REPORT_ONLY stop would otherwise hide);
//   - edges: static `import … from`, `export … from` and dynamic `import("…")` with a relative specifier inside src/;
//     type-only imports (`import type`, `export type`, or a brace list whose every name is `type`) are erased at
//     runtime and do not count;
//   - traversal goes THROUGH excluded modules (an excluded file importing a lane-editable one still puts it on the
//     judge's path) and stops only at gap-to-feature.ts and feature-compose.ts, item 1's verdict path, whose closure
//     qa ruled report-only;
//   - guarded = EVALUATOR_FILES ∪ the excluded dev-vessel src entries of autonomyScope. The committed record
//     (scripts/substrate/autonomy-scope.json) lives in the super-repo, not in this vessel's tree, so EXCLUDED_SRC
//     mirrors its development-vessel src entries.
// The set of lane-editable modules reached must EQUAL KNOWN_UNGUARDED exactly: a new edge reddens it, and removing
// debt forces the list to shrink with it. Each entry names its importer and role.
const EXCLUDED_SRC = [
  "src/resolvers/feature-compose.ts", "src/resolvers/vessel-mitosis-cutover.ts", "src/resolvers/pull-cutover.ts",
  "src/resolvers/push-policy.ts", "src/resolvers/git-push.ts", "src/resolvers/gap-to-feature.ts",
  "src/resolvers/substrate-gap.ts", "src/resolvers/apply-proposal-as-patch.ts", "src/resolvers/pool-impulse.ts",
  "src/resolvers/maintenance-lease.ts", "src/resolvers/rhythm-conductor-tick.ts", "src/routes/impulses.ts",
  "src/index.ts", "src/config.ts", "src/resolvers/attempt-register.ts", "src/resolvers/gap-lifecycle-scan.ts",
  "src/resolvers/self-fact-reconcile.ts", "src/resolvers/vessel-mitosis-evaluate.ts",
  // Excluded by the operator 10-05 (live record and autonomy-scope.json): the evaluator's and the lane's own guards.
  "src/lib/caller-credential.ts", "src/lib/self-auth.ts", "src/resolvers/write-containment.ts",
  "src/resolvers/super-repo-checkout.ts", "src/resolvers/behavioral-verification.ts",
  "src/resolvers/removed-line-predicate.ts", "src/resolvers/vacuous-edit.ts", "src/resolvers/staged-mitosis-gate.ts",
  "src/resolvers/retry-evidence.ts",
  // The gap-to-feature judge split (BOUNDARY.md 5.4): the closed gap-judge-core modules, excluded in the same qa act
  // that lands them (autonomy-scope.json excluded_paths, EVALUATOR_FILES, SCOPE_CLASSIFICATION).
  "src/judge/gap-eligibility.ts",
  "src/judge/gap-policy.ts",
  "src/judge/gap-check-judge.ts",
  "src/judge/gap-attempt-credit.ts",
];
const CLOSURE_ROOTS = ["src/resolvers/scope-earn-in.ts", "src/resolvers/pool-impulse.ts", "src/resolvers/test-suite.ts", "src/resolvers/self-fact-reconcile.ts", "src/resolvers/rhythm-conductor-tick.ts", "src/resolvers/check-supply-admission.ts"];
const REPORT_ONLY = ["src/resolvers/gap-to-feature.ts", "src/resolvers/feature-compose.ts"];
// The lane-editable modules still on the evaluator's path, each REVIEWED (qa, 10-05): why it may stay unguarded.
// None of them decides a verdict, a scope write or a credential; a lane landing in one can at worst degrade
// plumbing or a notice, which the evaluator's own re-run and the guarded files would not certify.
const KNOWN_UNGUARDED: Record<string, string> = {
  "src/resolvers/ui-write-passthrough.ts": "scope-earn-in (dynamic) — notice path, humans-informed: delivers the change notice, fire-and-forget, never read by the write or the verdict",
  "src/resolvers/boredom-enqueue.ts": "rhythm-conductor-tick:24 — plumbing: the conductor's goal enqueue into the boredom queue, not the due formula or the evaluator's pacing",
  "src/lib/region-literal.ts": "substrate-gap:43 — arming: the arm-time region-literal gate on gap writes; it decides whether a region arms, not a landing or a scope change",
  "src/lib/demand-goals.ts": "substrate-gap:42 — plumbing: merges demand_goals entries (goal↔gap linkage) on gap writes",
  "src/shape-vocabulary.ts": "substrate-gap:89 — arming: the advertised shape vocabulary used to judge a Class-2 predicate usable at birth",
  "src/services/gap-drain-observer.ts": "substrate-gap (dynamic) — telemetry: counts compose-nudge skips",
  "src/compose-slots.ts": "substrate-gap (dynamic) — plumbing: the cross-process compose capacity bound read when nudging compose",
};

/** Runtime import specifiers of a source text (relative only): static, re-export and dynamic; type-only erased. */
export function runtimeImports(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  const stat = /(?:^|[;\n])\s*(import|export)\s+([^;"'`]*?)\s*from\s*["'](\.[^"']+)["']/g;
  for (const m of code.matchAll(stat)) {
    const clause = m[2]!.trim();
    if (/^type\b/.test(clause)) continue;
    const braces = clause.match(/^\{([^}]*)\}$/);
    if (braces && braces[1]!.split(",").map((x) => x.trim()).filter(Boolean).every((x) => /^type\s/.test(x))) continue;
    out.push(m[3]!);
  }
  for (const m of code.matchAll(/(?:^|[;\n])\s*import\s*["'](\.[^"']+)["']/g)) out.push(m[1]!);
  for (const m of code.matchAll(/\bimport\(\s*["'](\.[^"']+)["']\s*\)/g)) out.push(m[1]!);
  return out;
}
function resolveSpec(fromRel: string, spec: string): string | null {
  const base = join(VESSEL_ROOT, fromRel, "..", spec);
  for (const c of [base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")]) {
    try { if (statSync(c).isFile()) return relative(VESSEL_ROOT, c); } catch { /* next */ }
  }
  return null;
}
function unguardedClosure(): Map<string, string> {
  const guarded = new Set<string>([...EXCLUDED_SRC, ...(EVALUATOR_FILES_SRC())]);
  const reached = new Map<string, string>();
  const seen = new Set<string>(CLOSURE_ROOTS);
  const queue = [...CLOSURE_ROOTS];
  while (queue.length) {
    const f = queue.shift()!;
    if (REPORT_ONLY.includes(f) && !CLOSURE_ROOTS.includes(f)) continue;
    for (const spec of runtimeImports(readFileSync(join(VESSEL_ROOT, f), "utf8"))) {
      const r = resolveSpec(f, spec);
      if (!r || !r.startsWith("src/") || seen.has(r)) continue;
      seen.add(r);
      queue.push(r);
      if (!guarded.has(r)) reached.set(r, f);
    }
  }
  return reached;
}
function EVALUATOR_FILES_SRC(): string[] {
  const text = readFileSync(join(VESSEL_ROOT, APPLIER), "utf8");
  const block = text.match(/export const EVALUATOR_FILES[^=]*=\s*\[([\s\S]*?)\];/);
  return block ? [...block[1]!.matchAll(/"repos\/development-vessel\/([^"]+)"/g)].map((m) => m[1]!) : [];
}

describe("the evaluator's import closure (control: green at base)", () => {
  it("positive control: the import scanner sees every runtime form and ignores type-only imports", () => {
    expect(runtimeImports(`import { a } from "./x.js";\nexport { b } from "./y.js";\nconst m = await import("./z.js");\nimport "./side.js";`).sort())
      .toEqual(["./side.js", "./x.js", "./y.js", "./z.js"]);
    expect(runtimeImports(`import type { A } from "./t1.js";\nexport type { B } from "./t2.js";\nimport { type C, type D } from "./t3.js";`)).toEqual([]);
    expect(runtimeImports(`import { type C, d } from "./t4.js";`)).toEqual(["./t4.js"]);
  });
});

describe("the evaluator imports nothing the lane can edit beyond the recorded debt (must-fail at base)", () => {
  it("every lane-editable module reached from the evaluator is exactly the known list", () => {
    // The applier's own list of evaluator files, read from source: the closure is judged against the shipped list.
    expect(EVALUATOR_FILES_SRC()).toContain("src/resolvers/rhythm-conductor-tick.ts");
    // The operator-excluded modules on the evaluator's own closure are evaluator files too (10-05).
    for (const f of ["src/lib/caller-credential.ts", "src/lib/self-auth.ts", "src/resolvers/retry-evidence.ts"]) expect(EVALUATOR_FILES_SRC()).toContain(f);
    // The shared evaluator tree the class-1 classifier and verifyGapCondition read through, and the supply test-writing
    // admission on feature-compose's verdict path, are evaluator files too (10-08).
    for (const f of ["src/lib/evaluator-tree.ts", "src/resolvers/check-supply-admission.ts"]) expect(EVALUATOR_FILES_SRC()).toContain(f);
    // The leaf helpers the supply admission check and feature-compose's plan-path rule and shell commands read (10-08).
    for (const f of ["src/resolvers/vessel-paths.ts", "src/resolvers/shell-quote.ts"]) expect(EVALUATOR_FILES_SRC()).toContain(f);
    // Every remaining entry carries a reviewed reason, not a bare provenance note.
    for (const [m, why] of Object.entries(KNOWN_UNGUARDED)) expect(why.split(" — ")[1] ?? "", m).toMatch(/^(notice path|plumbing|arming|telemetry)\b/);
    const reached = unguardedClosure();
    expect([...reached.keys()].sort()).toEqual(Object.keys(KNOWN_UNGUARDED).sort());
  });
});
