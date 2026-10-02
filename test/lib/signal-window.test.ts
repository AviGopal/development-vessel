import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hoursSince, measuredValue, readShapedPolicy, validatePolicy, type PolicySpec } from "../../src/lib/signal-window.js";
import { readVerdictClassPolicy, DEFAULT_VERDICT_CLASS_POLICY } from "../../src/resolvers/verdict-class-gap.js";

/**
 * The shared fail-closed helpers behind the verdict-class filer and the condition-gone closer:
 * unknown is never zero, and a broken policy file decides nothing (it does not silently fall back
 * to defaults the operator may have meant to override).
 */

type P = { n: number; globs: string[] };
const DEF: P = { n: 3, globs: ["*-cited"] };
const SPEC: PolicySpec<P> = { n: { kind: "int", min: 1, max: 10 }, globs: { kind: "globs", max_items: 4 } };

let ws: string;
let superRepo: string;
let env: Record<string, string | undefined>;
beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), "signal-window-"));
  superRepo = join(ws, "git", "super-repo");
  await mkdir(join(superRepo, ".git"), { recursive: true });
  await mkdir(join(superRepo, "policies"), { recursive: true });
  env = { SUPER_REPO_DIR: superRepo, WORKSPACE_ROOT: ws };
});
afterAll(async () => { await rm(ws, { recursive: true, force: true }); });

describe("measured counts: unknown is never zero", () => {
  it("only a measured, finite, non-negative count is a value", () => {
    expect(measuredValue({ matched_total: 0, measured: true })).toBe(0);
    expect(measuredValue({ matched_total: 0, measured: false })).toBeNull();
    expect(measuredValue({ matched_total: null, measured: true })).toBeNull();
    expect(measuredValue({ matched_total: Number.NaN, measured: true })).toBeNull();
    expect(measuredValue({ matched_total: "0" as unknown as number, measured: true })).toBeNull();
    expect(measuredValue({ matched_total: 5 } as never)).toBeNull();
    expect(measuredValue(undefined)).toBeNull();
  });
});

describe("windows", () => {
  const now = Date.parse("2026-10-02T00:00:00Z");
  it("hours since an instant round up and cap at the store horizon", () => {
    expect(hoursSince("2026-10-01T23:30:00Z", now)).toBe(1);
    expect(hoursSince("2026-09-29T00:00:00Z", now)).toBe(72);
    expect(hoursSince("2020-01-01T00:00:00Z", now)).toBe(720);
  });
  it("an unparseable or future instant is unknown, never 0", () => {
    expect(hoursSince("not a date", now)).toBeNull();
    expect(hoursSince(undefined, now)).toBeNull();
    expect(hoursSince("2026-10-03T00:00:00Z", now)).toBeNull();
  });
});

describe("shaped policy: read at use time from the live clone's policies/, fail closed", () => {
  it("validatePolicy fills absent fields from defaults and refuses unknown keys and out-of-range fields", () => {
    expect(validatePolicy({ n: 5 }, DEF, SPEC)).toEqual({ ok: true, policy: { n: 5, globs: ["*-cited"] } });
    expect(validatePolicy({ n: 5, reason: "why" }, DEF, SPEC).ok).toBe(true);
    expect(validatePolicy({ m: 5 }, DEF, SPEC).ok).toBe(false);
    expect(validatePolicy({ n: 0 }, DEF, SPEC).ok).toBe(false);
    expect(validatePolicy({ n: 2.5 }, DEF, SPEC).ok).toBe(false);
    expect(validatePolicy({ globs: ["Bad Glob"] }, DEF, SPEC).ok).toBe(false);
    expect(validatePolicy([], DEF, SPEC).ok).toBe(false);
  });

  it("no file → the defaults, said so", async () => {
    const r = await readShapedPolicy("absentPolicy", DEF, SPEC, env);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.source).toBe("default"); expect(r.policy).toEqual(DEF); }
  });

  it("no live super-repo clone → the defaults, said so", async () => {
    const r = await readShapedPolicy("absentPolicy", DEF, SPEC, { SUPER_REPO_DIR: join(ws, "nope"), MITOSIS_PUSH_CLONE_DIR: join(ws, "c") });
    // The containment fallback (/workspace/git/super-repo) may exist on a substrate host; either
    // way the answer is defaults when no policy file is there.
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.source).toBe("default");
  });

  it("a valid file is the policy", async () => {
    await writeFile(join(superRepo, "policies", "goodPolicy.json"), JSON.stringify({ n: 7, reason: "measured" }));
    const r = await readShapedPolicy("goodPolicy", DEF, SPEC, env);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.source).toBe("policy"); expect(r.policy.n).toBe(7); }
  });

  it("an unparseable or invalid file decides nothing (ok:false), never the defaults", async () => {
    await writeFile(join(superRepo, "policies", "brokenPolicy.json"), "{ n: 7");
    expect((await readShapedPolicy("brokenPolicy", DEF, SPEC, env)).ok).toBe(false);
    await writeFile(join(superRepo, "policies", "typoPolicy.json"), JSON.stringify({ nn: 7 }));
    expect((await readShapedPolicy("typoPolicy", DEF, SPEC, env)).ok).toBe(false);
  });

  it("verdictClassPolicy reads the plan's defaults when no file is seeded", async () => {
    const r = await readVerdictClassPolicy(env);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.policy).toEqual({ ...DEFAULT_VERDICT_CLASS_POLICY, exclude_tokens: [...DEFAULT_VERDICT_CLASS_POLICY.exclude_tokens] });
  });
});

describe("must-fail probes from review (qa15)", () => {
  const now = Date.parse("2026-10-02T00:00:00Z");
  it("hoursSince requires an ISO instant with time and zone: '0', '1' and a bare date are unknown", () => {
    expect(hoursSince("0", now)).toBeNull();
    expect(hoursSince("1", now)).toBeNull();
    expect(hoursSince("2026-10-01", now)).toBeNull();
    expect(hoursSince("2026-10-01T00:00:00+02:00", now)).toBe(26);
  });
  it("inherited names (constructor, toString, __proto__) are unknown policy keys, not spec fields", () => {
    expect(validatePolicy({ constructor: 1 }, DEF, SPEC).ok).toBe(false);
    expect(validatePolicy({ toString: "x" }, DEF, SPEC).ok).toBe(false);
    expect(validatePolicy(JSON.parse('{"__proto__": {"n": 99}}'), DEF, SPEC).ok).toBe(false);
  });
  it("an invalid policy name decides nothing (never the defaults)", async () => {
    expect((await readShapedPolicy("../x", DEF, SPEC, env)).ok).toBe(false);
  });
});
