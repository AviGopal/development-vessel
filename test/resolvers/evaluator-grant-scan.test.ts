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
