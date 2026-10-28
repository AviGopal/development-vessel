// F1 (MUST-FAIL): AN OPEN DRAFTER MODULE CANNOT REACH A CUTOVER ON ITS OWN.
//
// The drafter module (src/drafter/) is open: the lane may rewrite it. Whatever it returns, a landing still passes,
// in order, the verify step (typecheck, shape-dispatch, the suite), the gap's own check, the semantic gate's judge
// (verifyPatchAddressesGap), the adversarial refuter and, for an autonomous compose, the autonomy-scope floor, all
// BEFORE the cutover is called; and a draft that fails verify is never cut over at all.
//
// Driven through resolveFeatureCompose with land:true over the drafter-split harness; the module is replaced
// (bun mock.module) by four adversaries:
//   (a) a maximal valid context (the real v1 context, padded with prose up to the prompt cap);
//   (b) extra keys: skipVerify, tools, max_ops: 999;
//   (c) a throw;
//   (d) a context that omits every mandatory line (the own check, the success literal, the refused regions).
// (b), (c) and (d) must draft with the floor (drafter.fell_back on the report). The cutover is a recording stand-in;
// the scope floor is the real one, wrapped to record that it ran.
// MUTANT (seen red): a core that honours ctx.skipVerify (skips runVerify when it is set) reddens the ordering check.
import { afterAll, describe, expect, it, mock } from "bun:test";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const { root: ROOT, runtime: RUNTIME } = await isolateRuntimeRoot("drafter-f1", { superRepo: true, who: "test/drafter-split/f1-adversarial-module.test.ts" });
const { createHarness, events, markEvent, VESSEL, installInlineDrafterWorker } = await import("./harness.js");
const H = createHarness(ROOT, RUNTIME);
const restoreInlineWorker = installInlineDrafterWorker();

const DRAFTER = "../../src/drafter/index.ts";
const CUTOVER = "../../src/resolvers/vessel-mitosis-cutover.ts";
const POLICY = "../../src/judge/gap-policy.ts";
// Snapshots (spread), taken before any mock.module: a module namespace's bindings are re-pointed by mock.module, so
// restoring from the namespace itself would restore the stand-in.
const realDrafter = { ...(await import(DRAFTER)) };
const realCutover = { ...(await import(CUTOVER)) };
const realPolicy = { ...(await import(POLICY)) };
mock.module(CUTOVER, () => ({
  ...realCutover,
  resolveVesselMitosisCutover: async () => { markEvent("cutover"); return { shape: "vesselMitosisCutoverResult", body: { ok: false, verdict: "DEFERRED", reason: "f1 stand-in: nothing is committed" } }; },
}));
mock.module(POLICY, () => ({
  ...realPolicy,
  autonomyScopeFloor: (...a: Parameters<typeof realPolicy.autonomyScopeFloor>) => { markEvent("scope_floor"); return realPolicy.autonomyScopeFloor(...a); },
}));
afterAll(() => {
  mock.module(DRAFTER, () => realDrafter);
  mock.module(CUTOVER, () => realCutover);
  mock.module(POLICY, () => realPolicy);
  restoreInlineWorker();
  H.restore();
});

const T = `repos/${VESSEL}/src/compute.ts`;
const CHECK = [
  'import { describe, it, expect } from "bun:test";',
  'import { compute } from "../src/compute.js";',
  "describe(\"compute\", () => {",
  "  it(\"adds two to the scaled value\", () => {",
  "    expect(compute(1)).toBe(4);",
  "  });",
  "});",
  "",
].join("\n");
const LESSONS = [{ at: "2026-09-30T11:00:00.000Z", class: "semantic_reject", reason: "no effect", stage: "own_check", edited_spans: [{ path: T, start: 7, end: 8, base: "x", text_sha: "y" }], no_effect_vs_parent: true }];
const meta = { falsifier: "class1", edit_site: T, expected_literal: "base + 2", failure_lessons: LESSONS, evidence_resolve: { shape: "test_suite", input: { vessel: VESSEL, test_file: "test/compute.test.ts", only_tests: ["compute > adds two to the scaled value"] } } };
const fixture = (id: string, plan: "pass" | "verify_red", directed: boolean) => ({
  name: `${id} ${plan} ${directed ? "directed" : "undirected"}`,
  pointer: { spec: `In ${T}, compute must add 2, not 1 (base + 2).`, verify_vessels: [`repos/${VESSEL}`], land: true, skip_push: true, directed, gap: { id, summary: `compute in ${T} adds 1; it must add 2` } },
  plan,
  store: [{ id, status: "open", category: "code_quality", summary: `compute in ${T} adds 1; it must add 2`, classification_metadata: meta }],
  clone: { [`${VESSEL}/test/compute.test.ts`]: CHECK },
  scope: [`repos/${VESSEL}/src/config.ts`],
  pool: { spendEnvelope: { uncapped: true } },
});

type Ctx = Record<string, unknown>;
const ADVERSARIES: Record<string, { assemble: (f: any) => Ctx | never; fellBack: boolean }> = {
  "(a) maximal valid context": { fellBack: false, assemble: (f) => { const c = realDrafter.assembleDrafterContext(f) as Ctx; return { ...c, principles: `${String(c.principles)}\n${"(padding) ".repeat(20_000)}` }; } },
  "(b) extra keys skipVerify / tools / max_ops": { fellBack: true, assemble: (f) => ({ ...(realDrafter.assembleDrafterContext(f) as Ctx), skipVerify: true, tools: ["shell"], max_ops: 999 }) },
  "(c) a throwing module": { fellBack: true, assemble: () => { throw new Error("f1 adversary (c)"); } },
  "(d) every mandatory line omitted": { fellBack: true, assemble: (f) => ({ ...(realDrafter.assembleDrafterContext(f) as Ctx), grounding: String((realDrafter.assembleDrafterContext(f) as Ctx).grounding).split(`repos/${VESSEL}/test/compute.test.ts`).join("the check"), composeLessons: "", priorFeedback: "" }) },
};

let seq = 0;
async function compose(adv: string, plan: "pass" | "verify_red", directed: boolean) {
  mock.module(DRAFTER, () => ({ planDrafterReads: realDrafter.planDrafterReads, assembleDrafterContext: ADVERSARIES[adv]!.assemble }));
  const fc = await import(`../../src/resolvers/feature-compose.ts?drafter-f1=${++seq}`);
  let body: Record<string, any> = {};
  const rec = await H.run(fc, fixture(`f1-${seq}`, plan, directed), (b) => { body = b; });
  return { rec, body, events: [...events] };
}

describe("F1: an open drafter module cannot reach a cutover without every closed gate", () => {
  H.install();
  for (const adv of Object.keys(ADVERSARIES)) {
    for (const directed of [false, true]) {
      it(`${adv} (${directed ? "directed" : "autonomous"}): verify, the own check, the judge, the refuter${directed ? "" : " and the scope floor"} all run before the cutover`, async () => {
        const { body, events: ev } = await compose(adv, "pass", directed);
        expect(Boolean(body.drafter?.fell_back)).toBe(ADVERSARIES[adv]!.fellBack);
        const cut = ev.indexOf("cutover");
        expect(cut, `the cutover ran (events: ${ev.join(" ")})`).toBeGreaterThan(-1);
        const required = ["verify", "own_check:draft", "judge", "refuter", ...(directed ? [] : ["scope_floor"])];
        for (const r of required) {
          const at = ev.indexOf(r);
          expect({ gate: r, ran: at > -1, before_cutover: at > -1 && at < cut }).toEqual({ gate: r, ran: true, before_cutover: true });
        }
      }, 60_000);
      it(`${adv} (${directed ? "directed" : "autonomous"}): a draft that fails verify is never cut over`, async () => {
        const { body, events: ev } = await compose(adv, "verify_red", directed);
        expect(ev).toContain("verify");
        expect(ev).not.toContain("cutover");
        expect(body.verdict).not.toBe("FAVORABLE");
      }, 60_000);
    }
  }
});
