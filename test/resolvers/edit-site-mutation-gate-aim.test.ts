// THE EDIT-SITE MUTATION GATE AIMS AT THE GAP'S REGION (variant-1), AND IS AN ACTIVITY (USER: "Build it now").
//
// The gate's k operator mutants are spread evenly over every declaration the check reaches. On a large site they can all
// land far from the gap's code, so a check that does measure the defect reads as unmoved and is refused
// red_independent_of_edit_site: goal-host src/index.ts's door reaches ~16.7k lines and its six picks landed thousands of
// lines from the row's literal region. Variant-1 aims floor(k/2) of the k at the row's literal region (its statement,
// then its enclosing declaration's mutants nearest it); variant-0 is the gate as it was. The mask pool impulse selects.
//
// The site is synthetic: a door function reaching many fillers, the region deep in the door. The REAL resolveTestSuite
// runs every mutant at a compose-workspace root; this file answers only discovery and the shell, and its shell decides a
// run from the mutant itself (decoded from the command): the red moves iff the mutant overlaps the defect's statement.
//   - [MUST-FAIL] variant-1 on the large site PASSES: an aimed mutant moves the red. At the parent the gate takes no
//     region and refuses it.
//   - [CONTROL] variant-0 (no mask) on the same site is refused as before, and its mutants are exactly the k evenly
//     spaced picks (selectMutants over the declarations the check names), in order.
//   - [CONTROL, false admit] a red no mutant moves is still refused under variant-1, with the aimed picks recorded.
//   - [CONTROL] a small site: no region, variant-1's picks equal variant-0's; a region in a small function aims inside
//     that function only.
//   - the mask: unreadable, unknown variant, out-of-window rows all give variant-0.
//   - traces: the variant's own trace and the credit (reached tag, composition_chain [own]), credit only with a region.
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `esmg-aim-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const WS = join(ROOT, "compose");
mkdirSync(WS, { recursive: true });
process.env["COMPOSE_WS_DIR"] = WS;
process.env["DISCOVERY_VESSEL_ENDPOINT"] = "http://discovery.test";

const csa = (await import("../../src/resolvers/check-supply-admission.js")) as Record<string, any>;
const { selectMutants } = await import("../../src/resolvers/scope-earn-in.js");

const VESSEL = "fixture-esmg";
const SITE_REL = "src/site.ts";
const CHECK_REL = "test/checks/site.check.ts";
const TITLE = "door of four is forty two";
const FILLERS = 150;
const REGION = "  if (x === 4 && limit > 0) {";
const filler = (i: number) => `export function f${i}(x: number): number {\n  if (x > ${i}) return x + ${i};\n  return x === ${i} ? 1 : 0;\n}\n`;
/** A door reaching every filler, the gap's region deep inside it. */
const LARGE = [...Array.from({ length: FILLERS }, (_, i) => filler(i)),
  `export function door(x: number): number {\n  let limit = 0;\n${Array.from({ length: FILLERS }, (_, i) => `  limit += f${i}(x);`).join("\n")}\n  if (x < 0) limit = -limit;\n${REGION}\n    return 41;\n  }\n  const capped = limit > 100 ? 100 : limit;\n  return capped;\n}\n`].join("\n");
const SMALL_SITE = `export function small(x: number): number {\n  if (x > 2) return x * 2;\n  return 0;\n}\nexport function tiny(x: number, limit: number): number {\n${REGION}\n    return 1;\n  }\n  return 0;\n}\nexport function other(x: number): boolean {\n  return x === 3 || x < 0;\n}\n`;
const CHECK = (callee: string) => `import { describe, expect, test } from "bun:test";\nimport * as mod from "../../src/site";\ndescribe("site", () => {\n  test(${JSON.stringify(TITLE)}, () => { expect(mod.${callee}(4)).toBe(42); });\n});\n`;
const RED = (checkRel: string) => ["bun test v1.4.2", "", `${checkRel}:`, "error: expect(received).toBe(expected)", "", "Expected: 42", "Received: 41", "",
  `      at <anonymous> (/w/${checkRel}:4:60)`, `(fail) site > ${TITLE} [1.00ms]`, "", " 0 pass", " 1 fail", "Ran 1 test across 1 file."].join("\n");
// The same assertion with a different Received (the measured value moved), and a different assertion failing at another
// frame (the probe's shape: the call under test was suppressed, so "no compose was sent" fails instead).
const SAME = (checkRel: string) => RED(checkRel).replace("Received: 41", "Received: 40");
const PATH = (checkRel: string) => RED(checkRel).replace("error: expect(received).toBe(expected)", "error: expect(received).toBeGreaterThan(expected)")
  .replace("Expected: 42", "Expected: > 0").replace("Received: 41", "Received: 0").replace(":4:60)", ":4:20)");
const GREEN = [`(pass) site > ${TITLE} [1.00ms]`, "", " 1 pass", " 0 fail", "Ran 1 test across 1 file."].join("\n");

type Mutation = { file: string; start: number; end: number; original: string; replacement: string };
let seq = 0;
/** A compose worktree holding `site` and the check; `moves(m)` decides whether a mutant run's red moves. */
type Run = boolean | "green" | "same" | "path" | "red";
const answer = (r: Run, checkRel: string) => (r === true || r === "green" ? GREEN : r === "same" ? SAME(checkRel) : r === "path" ? PATH(checkRel) : RED(checkRel));
async function runGate(site: string, callee: string, opts: { region?: string; moves: (m: Mutation) => Run; masks?: () => Array<{ id?: string; body?: unknown }>; traces?: Array<Record<string, unknown>> }) {
  const root = join(WS, `wt-${++seq}`);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test/checks"), { recursive: true });
  writeFileSync(join(root, SITE_REL), site);
  writeFileSync(join(root, CHECK_REL), CHECK(callee));
  const mutants: Mutation[] = [];
  const router = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const p = body?.pointer ?? body?.impulse?.pointer ?? {};
    // test-suite.ts reads its discovery endpoint once, at its first import (another file may set it first): any host.
    if (url.endsWith("/resolve") && p?.type === "vesselCapability" && p?.shape === "shellResult") return Response.json({ content: { vessels: [{ endpoint: "http://shell.test", resolve_endpoint: "/resolve", health_score: 1 }] } });
    if (url.startsWith("http://shell.test")) {
      const cmd = String(p?.command ?? "");
      const enc = cmd.match(/apply-mutant\.ts'\s+'([A-Za-z0-9+/=]+)'/)?.[1];
      if (!enc) return Response.json({ stdout: `${RED(CHECK_REL)}\n` });
      const m = JSON.parse(Buffer.from(enc, "base64").toString("utf8")) as Mutation;
      mutants.push(m);
      return Response.json({ stdout: `MUTATION_APPLIED=1\n${answer(opts.moves(m), CHECK_REL)}\n` });
    }
    throw new TypeError(`unexpected network call in test: ${url}`);
  }) as unknown as typeof fetch;
  csa.__setEditSiteMutationDepsForTests?.({ readMasks: opts.masks ?? (() => []), postTrace: async (t: Record<string, unknown>) => { opts.traces?.push(t); return 200; }, nowIso: new Date().toISOString() });
  try {
    const { resolveTestSuite } = await import("../../src/resolvers/test-suite.js");
    const base = await resolveTestSuite({ vessel: `repos/${VESSEL}`, test_file: CHECK_REL, only_tests: [TITLE], root } as never);
    expect(base.shape, JSON.stringify(base.body).slice(0, 300)).toBe("test_suite");
    const outcome = await csa.editSiteMutationGateAt(root, { vessel: VESSEL, siteRel: SITE_REL, testFile: CHECK_REL, checkSrc: CHECK(callee), titles: [TITLE], baseline: base.body as Record<string, unknown>, k: 6, ...(opts.region !== undefined ? { region: opts.region } : {}) });
    return { outcome, mutants };
  } finally {
    globalThis.fetch = router;
  }
}
/** The defect's statement in `site`: the if statement the region opens (to its closing brace). */
function defectSpan(site: string): [number, number] {
  const at = site.indexOf(REGION.trim());
  return [at, site.indexOf("\n  }\n", at) + 4];
}
const overlaps = (m: Mutation, [s, e]: [number, number]) => m.start < e && m.end > s;
const V1 = () => [{ id: "mask-esmg", body: { activity_id: "development-vessel:edit-site-mutation-gate", active_variant: 1, from: new Date(Date.now() - 60_000).toISOString(), until: new Date(Date.now() + 60_000).toISOString(), reason: "fixture", lift: "fixture", by: "operator" } }];
const lineOf = (src: string, pos: number) => src.slice(0, pos).split("\n").length;

afterEach(() => csa.__setEditSiteMutationDepsForTests?.(null));
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

describe("variant-1 aims the gate's mutants at the gap's region", () => {
  it("[MUST-FAIL] a check that measures a deep defect of a large site passes: an aimed mutant moves its red", async () => {
    const span = defectSpan(LARGE);
    const traces: Array<Record<string, unknown>> = [];
    const { outcome, mutants } = await runGate(LARGE, "door", { region: REGION, moves: (m) => overlaps(m, span), masks: V1, traces });
    expect(outcome.kind).toBe("pass");
    const rec = (outcome as { record: Record<string, unknown> }).record;
    expect(rec["variant"]).toBe(1);
    expect(rec["changed"]).toBe(1);
    expect((rec["changed_by"] as Record<string, unknown>)["aimed"]).toBe(true);
    // The aimed picks are first, on the region's line, inside the door; one run decided it.
    const regionLine = lineOf(LARGE, LARGE.indexOf(REGION.trim()));
    expect((rec["aim"] as Record<string, unknown>)["region_line"]).toBe(regionLine);
    expect(((rec["aim"] as Record<string, unknown>)["declaration"] as Record<string, unknown>)["name"]).toBe("door");
    expect((rec["aimed_picks"] as string[]).length).toBe(3);
    expect(mutants.length).toBe(1);
    expect(overlaps(mutants[0]!, span)).toBe(true);
    // Its own trace and the credit: reached, chained to the own trace, variant on the own row.
    expect(traces.length).toBe(2);
    const [own, credit] = traces as [Record<string, unknown>, Record<string, unknown>];
    expect(own["activity_variant_id"]).toBe("development-vessel:edit-site-mutation-gate-v1");
    expect(own["output_shapes"]).toEqual(["editSiteMutationVerdict"]);
    expect(credit["activity_id"]).toBe("development-vessel:edit-site-mutation-gate-credit");
    expect(credit["composition_chain"]).toEqual([own["execution_id"]]);
    expect(credit["tags"]).toContain("reached:true");
    expect(credit["success"]).toBe(true);
  }, 120_000);

  it("[CONTROL] variant-0 (no mask in force) refuses the same check, its mutants exactly the k evenly spaced picks", async () => {
    const span = defectSpan(LARGE);
    const traces: Array<Record<string, unknown>> = [];
    const { outcome, mutants } = await runGate(LARGE, "door", { region: REGION, moves: (m) => overlaps(m, span), traces });
    expect(outcome.kind).toBe("refuse");
    expect((outcome as { reason: string }).reason).toStartWith("red_independent_of_edit_site: the named test(s) fail the same way under all 6 measured mutant(s)");
    const rec = (outcome as { record: Record<string, unknown> }).record;
    expect(rec["variant"]).toBe(0);
    expect(rec["aimed_picks"]).toBeUndefined();
    const expected = selectMutants(csa.siteRegionSource(LARGE, CHECK("door")), 6);
    expect(mutants.map((m) => [m.start, m.end, m.replacement])).toEqual(expected.map((m) => [m.start, m.end, m.replacement]));
    expect(rec["sampled_picks"]).toEqual(expected.map((m) => `${m.operator}@${m.line}`));
    // Graded by the same rule: none of variant-0's measured mutants lies in the door, so the credit is reached:false.
    expect(rec["declaration_measured"]).toBe(0);
    expect(traces[1]!["tags"]).toContain("reached:false");
    expect(traces[0]!["activity_variant_id"]).toBe("development-vessel:edit-site-mutation-gate");
  }, 120_000);

  it("[CONTROL, false admit] a red that no mutant moves is still refused under variant-1, the aimed picks recorded", async () => {
    const { outcome, mutants } = await runGate(LARGE, "door", { region: REGION, moves: () => false, masks: V1 });
    expect(outcome.kind).toBe("refuse");
    const rec = (outcome as { record: Record<string, unknown> }).record;
    expect(rec["variant"]).toBe(1);
    expect((rec["aimed_picks"] as string[]).length).toBe(3);
    expect(mutants.length).toBe(6);
    expect((outcome as { reason: string }).reason).toContain("fail the same way under all 6 measured mutant(s)");
  }, 120_000);
});

describe("variant-1 counts a run as moved only when what the check measures moves", () => {
  const span = defectSpan(LARGE);
  it("[MUST-FAIL] a mutant that only makes a different assertion fail (the call under test suppressed) does not admit the check", async () => {
    const { outcome } = await runGate(LARGE, "door", { region: REGION, moves: (m) => (overlaps(m, span) ? "path" : "red"), masks: V1 });
    expect(outcome.kind).toBe("refuse");
    const rec = (outcome as { record: Record<string, unknown> }).record;
    expect(rec["changed_kinds"] as string[]).toContain("path_only");
    expect(rec["changed"]).toBe(0);
    expect((outcome as { reason: string }).reason).toContain("only made a different assertion fail");
  }, 120_000);
  it("[CONTROL] variant-0 keeps today's rule on the same runs: the path-only run counts as moved, and the check passes", async () => {
    const { outcome, mutants } = await runGate(LARGE, "door", { region: REGION, moves: () => "path" });
    expect(outcome.kind).toBe("pass");
    const rec = (outcome as { record: Record<string, unknown> }).record;
    expect(rec["variant"]).toBe(0);
    expect(rec["changed_kinds"]).toEqual(["path_only"]);
    expect(mutants.length).toBe(1);
  }, 120_000);
  it("[CONTROL] the same assertion with a different Received still counts under variant-1", async () => {
    const { outcome } = await runGate(LARGE, "door", { region: REGION, moves: (m) => (overlaps(m, span) ? "same" : "red"), masks: V1 });
    expect(outcome.kind).toBe("pass");
    expect((outcome as { record: Record<string, unknown> }).record["changed_kinds"]).toEqual(["same_assertion"]);
  }, 120_000);
  it("[CONTROL] a run that did not apply or did not run stays unmeasured; an identical red is unchanged", () => {
    const base = { ran: true, red_reason: { ran: true, unhandled: false, failures: [{ name: `site > ${TITLE}`, cls: "assertion", error: "expect(received).toBe(expected)" }], compared: [] } };
    expect(csa.runChangeKind(base, { mutation: { applied: false } }, [TITLE])).toBe("unmeasured");
    expect(csa.runChangeKind(base, { mutation: { applied: true }, ran: false }, [TITLE])).toBe("unmeasured");
    expect(csa.runChangeKind(base, { ...base, mutation: { applied: true } }, [TITLE])).toBe("unchanged");
    expect(csa.runChangeKind(base, { mutation: { applied: true }, ran: true, requested_not_passing: 0 }, [TITLE])).toBe("green");
  });
});

describe("small sites and missing regions", () => {
  it("[CONTROL] no region: variant-1's mutants are variant-0's, byte for byte", async () => {
    const a = await runGate(SMALL_SITE, "small", { moves: () => false, masks: V1 });
    const b = await runGate(SMALL_SITE, "small", { moves: () => false });
    expect(a.mutants).toEqual(b.mutants);
    const rec = (a.outcome as { record: Record<string, unknown> }).record;
    expect(rec["aimed_picks"]).toEqual([]);
    expect((rec["aim"] as Record<string, unknown>)["why"]).toBe("no literal region");
  }, 120_000);

  it("[CONTROL] a region in a small function aims inside that function only, within test_suite's edit size", () => {
    const plan = csa.aimedMutants(SMALL_SITE, SITE_REL, REGION, 3);
    expect(plan.declaration?.name).toBe("tiny");
    expect(plan.aimed.length).toBeGreaterThan(0);
    for (const m of plan.aimed) {
      expect(m.start).toBeGreaterThanOrEqual(plan.declaration!.start);
      expect(m.end).toBeLessThanOrEqual(plan.declaration!.end);
      expect(m.original.length + m.replacement.length).toBeLessThanOrEqual(8192);
    }
  });

  it("a region occurring twice, or not at all, aims at nothing and says why", () => {
    expect(csa.aimedMutants(`${SMALL_SITE}${SMALL_SITE}`, SITE_REL, REGION, 3)).toMatchObject({ aimed: [], why: "the region occurs 2 time(s) in src/site.ts" });
    expect(csa.aimedMutants(SMALL_SITE, SITE_REL, "  if (nowhere) {", 3)).toMatchObject({ aimed: [], why: "the region occurs 0 time(s) in src/site.ts" });
  });

  it("spread, not stacked: the region's statement, then one pick per line, never an over-size edit", () => {
    const big = `export function huge(x: number, limit: number): number {\n${"  limit += x > 1 ? 1 : 0;\n".repeat(400)}${REGION}\n    return 1;\n  }\n  return limit;\n}\n`;
    const plan = csa.aimedMutants(big, SITE_REL, REGION, 3);
    const regionLine = lineOf(big, big.indexOf(REGION.trim()));
    expect(plan.aimed.length).toBe(3);
    expect(plan.aimed[0]).toMatchObject({ operator: "replace_statement", line: regionLine });
    // The nearest other line (just above the region), then one of the declaration's own evenly spaced picks.
    expect(plan.aimed[1]!.line).toBe(regionLine - 1);
    expect(new Set(plan.aimed.map((m) => m.line)).size).toBe(3);
    expect(plan.aimed[2]!.line).toBeLessThan(regionLine - 1);
    for (const m of plan.aimed) {
      expect(m.start).toBeGreaterThanOrEqual(plan.declaration!.start);
      expect(m.end).toBeLessThanOrEqual(plan.declaration!.end);
    }
    expect(plan.aimed.some((m) => m.operator === "empty_body")).toBe(false);
  });
});

describe("the mask selects the variant", () => {
  const at = new Date().toISOString();
  const DAY = 86_400_000;
  const PAST = new Date(Date.now() - DAY).toISOString(), SOON = new Date(Date.now() + DAY).toISOString(), LATER = new Date(Date.now() + 2 * DAY).toISOString();
  it("no row, a row for another activity, or a row out of its window: variant-0", () => {
    expect(csa.editSiteMutationVariant(at, () => []).variant).toBe(0);
    expect(csa.editSiteMutationVariant(at, () => [{ id: "m", body: { activity_id: "development-vessel:reach-grade", active_variant: 1, from: PAST, until: SOON } }]).variant).toBe(0);
    expect(csa.editSiteMutationVariant(at, () => [{ id: "m", body: { activity_id: "development-vessel:edit-site-mutation-gate", active_variant: 1, from: SOON, until: LATER } }]).variant).toBe(0);
  });
  it("an unreadable pool is variant-0, logged mask_unread; an unknown variant is variant-0", () => {
    const r = csa.editSiteMutationVariant(at, () => { throw new Error("pool down"); });
    expect(r.variant).toBe(0);
    expect(r.why).toStartWith("mask_unread");
    expect(csa.editSiteMutationVariant(at, () => [{ id: "m", body: { activity_id: "development-vessel:edit-site-mutation-gate", active_variant: 7, from: PAST, until: SOON } }]).variant).toBe(0);
  });
  it("a row in force for this activity selects its variant, the newest first", () => {
    const rows = [
      { id: "new", body: { activity_id: "development-vessel:edit-site-mutation-gate", active_variant: 1, from: PAST, until: SOON, reason: "window A", by: "operator" } },
      { id: "old", body: { activity_id: "development-vessel:edit-site-mutation-gate", active_variant: 0, from: PAST, until: SOON, reason: "baseline", by: "operator" } },
    ];
    expect(csa.editSiteMutationVariant(at, () => rows)).toMatchObject({ variant: 1 });
  });
});
