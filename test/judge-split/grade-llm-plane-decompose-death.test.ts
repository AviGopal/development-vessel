// GRADING A COMPOSE THAT DIED ON THE LLM FAILOVER DEADLINE CHARGES NOTHING (gradeComposeOutcome, main compose route).
//
// The draft LLM call's death ("llm failover deadline: no endpoint answered within 300000ms … last: The operation timed
// out") used to come back as { ok:false, stage:"decompose", error } and was graded as an ordinary failure: failed_attempts
// +1, last_failed_at set, a class-posterior miss. feature-compose now reports it through decomposeThrowReport, the body its
// draft-throw exit returns. Driven through resolveGapToFeature (a directed pointer over a stored row) with that body as the
// scripted feature_compose answer, on the judge-split harness:
//   - the deadline death: failed_attempts and last_failed_at unchanged, no class-posterior write, the non-attempt line
//     (the must-fail; red at the parent, which has no such report);
//   - CONTROL: a draft-throw that is not the LLM plane's (a 400 refusal) is still graded as a failure: +1 and one miss;
//   - CONTROL: a compose that drafted and failed verify still bumps (+1) and charges one miss.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginPin, endPin, restoreHarness, seed, stored, metaOf, script, tick, faTrail, posteriorWrites, COMPOSE, RUN, SCRATCH, type Row } from "./harness.js";

const g2f = await import("../../src/resolvers/gap-to-feature.js");
const fc = await import("../../src/resolvers/feature-compose.js");
const { gapClassOf } = await import("../../src/judge/gap-attempt-credit.js");

const VESSEL = `llmplane-${RUN}`;
const LITERAL = `http://llm-plane-literal-${RUN}`;
const DEADLINE = "llm failover deadline: no endpoint answered within 300000ms (a third of the compose ceiling) — last: The operation timed out.";
const REFUSED = "llmCall to http://localhost:18999/resolve failed with status 400: bad request (fixture)";
let n = 0;
/** A class-1 gap whose literal is present in its runtime site, so the pick-time check reads 'present' and the tick
 *  composes. "-recommit-" and "backlog" keep predictLand under the prior, so a charged failure is +1 (no surprise). */
function gap(tag: string): { id: string } {
  const id = `llm-plane-backlog-recommit-${tag}-${RUN}`;
  const rel = `src/llm-plane-${++n}.ts`;
  mkdirSync(join(SCRATCH, "runtime", VESSEL, "src"), { recursive: true });
  writeFileSync(join(SCRATCH, "runtime", VESSEL, rel), `export const url = "${LITERAL}";\n`);
  seed({ id, category: `llm_plane_cat_${tag}_${RUN}`, classification_metadata: { falsifier: "class1", edit_site: `repos/${VESSEL}/${rel}`, hardcoded_url: LITERAL } });
  return { id };
}
const directed = (id: string) => tick(() => g2f.resolveGapToFeature({ type: "gap_to_feature", gap_id: id, directed: true } as never));
const report = (message: string) => {
  const make = (fc as Record<string, unknown>)["decomposeThrowReport"] as ((m: string) => Row) | undefined;
  expect(typeof make).toBe("function");
  return { shape: "featureComposeReport", body: make!(message) };
};

beforeEach(() => { beginPin(); });
afterEach(() => { expect(endPin([/pick-decisions\.jsonl$/])).toEqual({ fetch: [], fs: [], exec: [] }); });
afterAll(() => restoreHarness());

describe("gradeComposeOutcome: a compose whose draft LLM call died", () => {
  it("[MUST-FAIL] on the failover deadline: failed_attempts and last_failed_at unchanged, no class miss", async () => {
    const g = gap("deadline");
    script.compose = [report(DEADLINE)];
    const { lines } = await directed(g.id);
    expect(faTrail(g.id)).toEqual([0]);
    expect(metaOf(g.id).last_failed_at).toBeUndefined();
    expect(posteriorWrites(gapClassOf(stored(g.id)!)).length).toBe(0);
    expect(lines.some((l) => l.includes(`non-attempt (failure_kind=environment, verdict=-, stage=decompose) for gap ${g.id}`))).toBe(true);
  });

  it("[CONTROL] a draft-throw that is not the LLM plane's (a 400 refusal) is graded as a failure", async () => {
    const g = gap("refused");
    script.compose = [report(REFUSED)];
    await directed(g.id);
    expect(faTrail(g.id)).toEqual([0, 1]);
    expect(typeof metaOf(g.id).last_failed_at).toBe("string");
    expect(posteriorWrites(gapClassOf(stored(g.id)!)).length).toBe(1);
  });

  it("[CONTROL] a compose that drafted and failed verify still bumps and charges a miss", async () => {
    const g = gap("verify");
    script.compose = [COMPOSE.unfavorable];
    await directed(g.id);
    expect(faTrail(g.id)).toEqual([0, 1]);
    expect(posteriorWrites(gapClassOf(stored(g.id)!)).length).toBe(1);
  });
});
