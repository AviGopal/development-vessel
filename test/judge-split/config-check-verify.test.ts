// A SEED TEMPLATE EDIT THAT CANNOT REACH THE RUNTIME FAILS VERIFY; THE DRAFTER IS TOLD WHY BEFORE IT EDITS.
//
// A seed activity template (src/seed/) reaches a running node only when its metadata.seed_version rises (seed delivery
// re-uploads nothing else on a populated catalogue). A draft that changes a template's task config without the bump
// lands, typechecks and passes a check that reads the template's literals, and changes nothing any node runs.
//
// Driven through the REAL resolveFeatureCompose over the drafter-split harness (hermetic: temp tree, scripted LLM,
// in-memory gap store), on a synthetic one-task seed template:
//   (d) VERIFY: the draft that adds a flag to the task's config WITHOUT a seed_version bump is refused at verify with the
//       reason "cannot reach the runtime: seed delivery re-uploads only on a seed_version bump"; the same draft WITH
//       the bump verifies and is FAVORABLE (control).
//   (e) DRAFTER CONTEXT: for a gap whose edit site is under src/seed/, the decompose prompt the drafter is shown carries
//       the seed_version fact; for a non-seed edit site it does not (control).
//   (d') a NEW seed template (a new seed file, or a template added to one) without a positive seed_version is refused
//       the same way; with seed_version >= 1 it verifies (control).
// MUTANTS (seen red): (d) runVerify without the seed-delivery gate; (d') a rule that judges only templates present
// before; (e) the open lesson renderer returning "".
import { afterAll, describe, expect, it } from "bun:test";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const { root: ROOT, runtime: RUNTIME } = await isolateRuntimeRoot("config-check-verify", { superRepo: true, who: "test/judge-split/config-check-verify.test.ts" });
const H_MOD = await import("../drafter-split/harness.js");
const { createHarness, CORPUS, VESSEL } = H_MOD;
const SEED_T = (H_MOD as { SEED_T?: string }).SEED_T ?? `repos/${VESSEL}/src/seed/demo-sweep-tick.ts`;
const SEED_TICK_SRC = (H_MOD as { SEED_TICK_SRC?: string }).SEED_TICK_SRC ?? "";
const H = createHarness(ROOT, RUNTIME);
afterAll(() => { H.restore(); });

const REASON = "cannot reach the runtime: seed delivery re-uploads only on a seed_version bump";
const LESSON = "metadata.seed_version";
type Row = Record<string, any>;

function seedFixture(name: string, plan: "seed_edit" | "seed_edit_bumped"): Parameters<typeof H.run>[1] {
  const id = `seed-${plan}`;
  const summary = `the demo_sweep task in ${SEED_T} never runs in audit-only mode`;
  return {
    name,
    pointer: {
      spec: `In ${SEED_T}, the demo_sweep task's config must also enable auditOnly.`,
      verify_vessels: [`repos/${VESSEL}`], land: false, skip_push: true, directed: true,
      gap: { id, summary },
    },
    plan: plan as never,
    files: { [`${VESSEL}/src/seed/demo-sweep-tick.ts`]: SEED_TICK_SRC },
    store: [{ id, status: "open", category: "code_quality", summary, classification_metadata: { edit_site: SEED_T } }],
  };
}

let seq = 0;
async function run(fx: Parameters<typeof H.run>[1]): Promise<{ rec: Awaited<ReturnType<typeof H.run>>; body: Row }> {
  H.install();
  const fc = await import(`../../src/resolvers/feature-compose.ts?config-check-verify=${++seq}`);
  let body: Row = {};
  const rec = await H.run(fc, fx, (b) => { body = b; });
  return { rec, body };
}
const verifyText = (body: Row): string => JSON.stringify(body.verify ?? body.verify_results ?? body);

describe("(d) verify: a seed template's task edit must bump metadata.seed_version", () => {
  it("the fixture seed is present in the harness", () => {
    expect(SEED_TICK_SRC).toContain("resolver: \"demo_sweep\"");
  });
  it("REFUSED: the config flag added without a seed_version bump fails verify with the delivery reason", async () => {
    const { rec, body } = await run(seedFixture("seed edit without bump", "seed_edit"));
    expect(rec.verdict).not.toBe("FAVORABLE");
    expect(rec.applied.some((a) => a.includes("src/seed/demo-sweep-tick.ts"))).toBe(true);
    expect(verifyText(body) + rec.console.join("\n")).toContain(REASON);
  }, 60_000);
  it("CONTROL: the same edit with the bump verifies and is FAVORABLE", async () => {
    const { rec, body } = await run(seedFixture("seed edit with bump", "seed_edit_bumped"));
    expect(verifyText(body) + rec.console.join("\n")).not.toContain(REASON);
    expect(rec.verdict).toBe("FAVORABLE");
  }, 60_000);
});

const SEED_NEW_T = (H_MOD as { SEED_NEW_T?: string }).SEED_NEW_T ?? `repos/${VESSEL}/src/seed/demo-audit-tick.ts`;
function newSeedFixture(name: string, plan: "seed_new" | "seed_new_versioned"): Parameters<typeof H.run>[1] {
  const id = `seed-${plan}`;
  const summary = `there is no audit tick: ${SEED_NEW_T} must define one`;
  return {
    name,
    pointer: {
      spec: `Create ${SEED_NEW_T} exporting a demo audit tick ActivityTemplate.`,
      verify_vessels: [`repos/${VESSEL}`], land: false, skip_push: true, directed: true,
      gap: { id, summary },
    },
    plan: plan as never,
    files: { [`${VESSEL}/src/seed/demo-sweep-tick.ts`]: SEED_TICK_SRC },
    store: [{ id, status: "open", category: "code_quality", summary, classification_metadata: { edit_site: SEED_NEW_T } }],
  };
}

describe("(d) verify: a NEW seed template must carry a positive metadata.seed_version (populated catalogues skip it otherwise)", () => {
  it("REFUSED: a new seed file exporting a template without seed_version fails verify with the delivery reason", async () => {
    const { rec, body } = await run(newSeedFixture("new seed without seed_version", "seed_new"));
    expect(rec.applied.some((a) => a.includes("src/seed/demo-audit-tick.ts"))).toBe(true);
    expect(rec.verdict).not.toBe("FAVORABLE");
    expect(verifyText(body) + rec.console.join("\n")).toContain(REASON);
  }, 60_000);
  it("CONTROL: the same new file with seed_version 1 verifies and is FAVORABLE", async () => {
    const { rec, body } = await run(newSeedFixture("new seed with seed_version", "seed_new_versioned"));
    expect(rec.applied.some((a) => a.includes("src/seed/demo-audit-tick.ts"))).toBe(true);
    expect(verifyText(body) + rec.console.join("\n")).not.toContain(REASON);
    expect(rec.verdict).toBe("FAVORABLE");
  }, 60_000);
  it("RULE: a template ADDED to an existing seed file without seed_version is refused; with seed_version >= 1 it is not", async () => {
    const m = await import("../../src/seed-delivery-verify.js");
    const added = SEED_TICK_SRC + SEED_TICK_SRC.split("\n").slice(2).join("\n").replace("DEMO_SWEEP_TICK_TEMPLATE", "DEMO_EXTRA_TICK_TEMPLATE");
    const r = m.seedDeliveryRefusals([{ path: "src/seed/demo-sweep-tick.ts", pre: SEED_TICK_SRC, post: added }]);
    expect(r.map((x) => x.template)).toEqual(["DEMO_EXTRA_TICK_TEMPLATE"]);
    expect(m.seedDeliveryReason(r)).toContain(REASON);
    const versioned = added.replace(/(DEMO_EXTRA_TICK_TEMPLATE[\s\S]*?  tags: \["demo"\],)/, "$1\n  metadata: { seed_version: 2 },");
    expect(m.seedDeliveryRefusals([{ path: "src/seed/demo-sweep-tick.ts", pre: SEED_TICK_SRC, post: versioned }])).toEqual([]);
  });
});

describe("(e) drafter context: the seed_version fact is shown for a src/seed/ edit site", () => {
  it("a seed edit site's decompose prompt carries the seed_version delivery fact", async () => {
    const { rec } = await run(seedFixture("seed lesson", "seed_edit_bumped"));
    expect(rec.decompose_prompt).toContain(LESSON);
    expect(rec.decompose_prompt).toContain("never reaches the runtime");
  }, 60_000);
  it("CONTROL: a non-seed edit site's prompt does not", async () => {
    const { rec } = await run(CORPUS[0]!);
    expect(rec.decompose_prompt.length).toBeGreaterThan(0);
    expect(rec.decompose_prompt).not.toContain("SEED TEMPLATES (src/seed/)");
  }, 60_000);
});
