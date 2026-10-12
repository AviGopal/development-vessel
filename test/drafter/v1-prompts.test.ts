// WHAT THE DRAFTER IS SHOWN, PER CORPUS COMPOSE (open review instrument; lane-writable, as src/drafter/ is).
//
// Runs the drafter-split corpus through resolveFeatureCompose with the real open module and compares every prompt
// (kind, sha256, bytes) with src/drafter/golden/prompts.json. A change to src/drafter/ that changes what the drafter
// is shown changes this golden in the same compose (the data file is a target the spec can name), so the diff of
// the golden IS the review of the change. This is not enforcement: the closed gates and clamps are.
// At drafter-v1 the golden equals the closed floor's prompts (test/drafter-split/verdict-diff.golden.json).
import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const { root: ROOT, runtime: RUNTIME } = await isolateRuntimeRoot("drafter-open-golden", { superRepo: true, who: "test/drafter/v1-prompts.test.ts" });
const { createHarness, CORPUS } = await import("../drafter-split/harness.js");
const H = createHarness(ROOT, RUNTIME);
afterAll(() => { H.restore(); });
const GOLDEN = JSON.parse(readFileSync(join(import.meta.dir, "../../src/drafter/golden/prompts.json"), "utf8")) as Array<{ name: string; prompts: unknown }>;

describe("the open module's prompts match its data golden", () => {
  let seq = 0;
  for (const fx of CORPUS) it(fx.name, async () => {
    H.install();
    const fc = await import(`../../src/resolvers/feature-compose.ts?drafter-open-golden=${++seq}`);
    const rec = await H.run(fc, fx);
    expect({ name: fx.name, prompts: rec.prompts }).toEqual(GOLDEN.find((g) => g.name === fx.name) ?? { name: fx.name, prompts: "(not in the golden)" });
  }, 60_000);
});
