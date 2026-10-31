// typecheckClassOf reads the gap's DEFECT text only. A chronic-failure narrowing appends a prior-attempts section to the
// child's summary, and that section can quote an earlier draft's tsc error ("error TS2304: Cannot find name …"). Read
// as part of the defect, it made a failing-test gap look like a typecheck gap, and admission excluded it as
// typecheck_clean_phantom on every pass while the vessel typechecked clean. The parse now stops at that section.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(tmpdir(), `admit-tcprior-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const priorEnv = { MITOSIS_RUNTIME_DIR: process.env.MITOSIS_RUNTIME_DIR, VESSELS_CLONE_ROOT: process.env.VESSELS_CLONE_ROOT };
mkdirSync(join(ROOT, "clones"), { recursive: true });
for (const v of ["activity-api", "goal-host-vessel"]) {
  mkdirSync(join(ROOT, v, "src"), { recursive: true });
  writeFileSync(join(ROOT, v, "package.json"), JSON.stringify({ name: v }));
}
writeFileSync(join(ROOT, "goal-host-vessel", "src", "index.ts"), "export const x = 1;\n");
// The vessel roots are read at call time, so they are set for this file's tests only.
beforeAll(() => {
  process.env.MITOSIS_RUNTIME_DIR = ROOT;
  process.env.VESSELS_CLONE_ROOT = join(ROOT, "clones");
});
afterAll(() => {
  for (const [k, v] of Object.entries(priorEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

const { typecheckClassOf } = await import("../../src/judge/gap-admission.js");

// The section as the narrowing writes it (literal here on purpose: the test pins the text live rows carry).
const PRIOR = "\n\nWHY PREVIOUS ATTEMPTS ON THIS GAP FAILED (most recent last):\n";
const DEFECT = "[narrowed from failing-test-activity-api-src-services-circuit-breaker-test-ts-gen-assert] Failing test(s) in "
  + "repos/activity-api/src/services/circuit-breaker.test.ts, detected by pull-sync (red on two consecutive ticks).";
const LESSONS = "- typecheck_dangling_reference: src/services/circuit-breaker.ts: error TS2304: Cannot find name 'shouldResetWindow'.\n"
  + "- verify_failed: (fail) circuit breaker > opens after the threshold\n\nDo not repeat these failures. Address the specific cause named above.";

const row = (id: string, summary: string, meta: Record<string, unknown> = {}) =>
  ({ id, category: "failing_test", source: "substrate_detected", status: "open", summary, classification_metadata: meta }) as Record<string, unknown>;

describe("typecheckClassOf reads the defect, not the prior-attempts section", () => {
  it("[MUST-FAIL] a failing-test row whose TS code appears ONLY after the prior-attempts heading is not typecheck-class", () => {
    const c1 = row("failing-test-activity-api-src-services-circuit-breaker-test-ts-gen-assert-narrowed", DEFECT + PRIOR + LESSONS,
      { edit_site: "repos/activity-api/src/services/circuit-breaker.ts" });
    expect(typecheckClassOf(c1)).toBeNull();
  });

  it("[CONTROL] a TS code BEFORE the heading still parses, with the same vessel and code", () => {
    const before = row("narrowed-typecheck-row-narrowed", "TS2345 at repos/goal-host-vessel/src/index.ts:10" + PRIOR + LESSONS);
    expect(typecheckClassOf(before)).toEqual({ vessel: "goal-host-vessel", tsCode: "TS2345" });
  });

  it("[CONTROL] a row with no heading parses as before", () => {
    const plain = row("plain-typecheck-row", "error TS2304 in repos/activity-api/src/services/circuit-breaker.ts:12");
    expect(typecheckClassOf(plain)).toEqual({ vessel: "activity-api", tsCode: "TS2304" });
  });

  it("[CONTROL] the id-embedded underscore form still parses, heading or not", () => {
    const id = "detect-unclassified_failure_recurring_typecheck_goal_host_vessel_src_index_l619_ts2322_variant";
    expect(typecheckClassOf(row(id, "recurring typecheck failure"))).toEqual({ vessel: "goal-host-vessel", tsCode: "TS2322" });
    expect(typecheckClassOf(row(id, "recurring typecheck failure" + PRIOR + LESSONS))).toEqual({ vessel: "goal-host-vessel", tsCode: "TS2322" });
  });

  it("[CONTROL] a structured tsc_error still wins first, whatever the summary holds", () => {
    const structured = row("structured-row", DEFECT + PRIOR + LESSONS,
      { tsc_error: { code: "TS2322", file: "repos/goal-host-vessel/src/index.ts", line: 619 } });
    expect(typecheckClassOf(structured)).toEqual({ vessel: "goal-host-vessel", tsCode: "TS2322" });
  });
});
