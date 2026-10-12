// F6 (MUST-FAIL): WITH THE OPEN MODULE AS SHIPPED, EVERY CORPUS COMPOSE IS DRAFTED BY IT AND JUDGED AS BEFORE.
//
// Behaviour preservation has two halves. The whole development-vessel suite passing unchanged (copy, not move: no
// export left feature-compose.ts, no source anchor moved) is the first, and is run by the gate. This file is the
// second: over the verdict-diff corpus, with the REAL open module,
//   - the open module drafted every compose (drafter.fell_back is null: no clamp refused its context), and
//   - every closed outcome equals the golden recorded before the split: verdict, stage, ok, error, the plan's ops and
//     what was applied.
// Prompt bytes are NOT compared here: an open change may change what the drafter is shown (the open data golden
// under src/drafter/golden/ is its review instrument). A change that makes every context refused (the open module
// silently replaced by the floor) reddens this file.
// MUTANT (seen red): the open module drops the own-check block (a mandatory line) -> its context is refused.
import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

const { root: ROOT, runtime: RUNTIME } = await isolateRuntimeRoot("drafter-f6", { superRepo: true, who: "test/drafter-split/f6-behaviour-preservation.test.ts" });
const { createHarness, CORPUS } = await import("./harness.js");
const H = createHarness(ROOT, RUNTIME);
afterAll(() => { H.restore(); });
const GOLDEN = JSON.parse(readFileSync(join(import.meta.dir, "verdict-diff.golden.json"), "utf8")) as Array<Record<string, unknown>>;
const CLOSED_FIELDS = ["verdict", "stage", "ok", "error", "ops", "applied"] as const;

describe("F6: the shipped open module drafts every corpus compose and every closed outcome is unchanged", () => {
  let seq = 0;
  for (const fx of CORPUS) {
    it(fx.name, async () => {
      H.install();
      const fc = await import(`../../src/resolvers/feature-compose.ts?drafter-f6=${++seq}`);
      let drafter: Record<string, unknown> | null = null;
      const rec = await H.run(fc, fx, (b) => { drafter = (b.drafter ?? null) as Record<string, unknown> | null; });
      const g = GOLDEN.find((x) => x.name === fx.name)!;
      const d = drafter as { fell_back?: unknown } | null;
      expect({ drafter_record: d !== null, fell_back: d ? d.fell_back : "(no drafter record)" }).toEqual({ drafter_record: true, fell_back: null });
      const pick = (r: Record<string, unknown>) => Object.fromEntries(CLOSED_FIELDS.map((k) => [k, r[k]]));
      expect(pick(rec as unknown as Record<string, unknown>)).toEqual(pick(g));
    }, 60_000);
  }
});
