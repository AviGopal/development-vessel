// NO BLIND DRAFT: A GAP WHOSE OWN CHECK CANNOT BE READ IS REFUSED, NOT DRAFTED (finding agf_p80t0k7b3956).
//
// ownCheckGrounding logged "[fc-own-check-grounding] … the drafter is not shown its check" and returned null when the
// check file was unreadable, and the compose went on to plan and draft with no check in the prompt. Every such line
// on both nodes over three days (2026-10-25..27) named a check absent from the vessel's origin/dev: verify, which
// runs that file alone, then printed no result and refused the draft as unjudged after the planning call was paid.
//
// Expected:
//   - readOwnCheckGrounding says which of three cases holds: none (no own check), unreadable (named, with the
//     vessel, test file and errno), shown (the grounding); ownCheckGrounding keeps returning the grounding or null;
//   - the compose refuses an unreadable own check before any planning call, with the named stage
//     own_check_unreadable and a detail naming the file (MUST-FAIL);
//   - a test-writing compose, which writes the check, is not refused for its absence (CONTROL);
//   - a readable check is shown, and a gap with no own check reads none (CONTROL).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(tmpdir(), `own-check-unreadable-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = `hassle-${RUN}-vessel`;
const PRESENT = "test/checks/subduing-present.check.ts";
const ABSENT = "test/checks/subduing-absent.check.ts";
const NAMED = "subduing > counts the omission";
const meta = (file: string) => ({
  edit_site: `repos/${VESSEL}/src/subduing.ts`,
  evidence_resolve: { shape: "test_suite", input: { vessel: `repos/${VESSEL}`, test_file: file, only_tests: [NAMED] }, zero_field: "requested_not_passing" },
});
const rootFor = (v: string): string => join(ROOT, v);
const SRC = readFileSync(join(import.meta.dir, "../../src/resolvers/feature-compose.ts"), "utf8");

beforeAll(() => {
  const abs = join(ROOT, VESSEL, PRESENT);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, 'import { it, expect } from "bun:test";\nit("counts the omission", () => { expect(1).toBe(1); });\n');
});
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

describe("an unreadable own check refuses the compose instead of drafting blind", () => {
  it("MUST-FAIL the read names an unreadable own check: vessel, test file and why", () => {
    expect(typeof fc.readOwnCheckGrounding).toBe("function");
    const r = fc.readOwnCheckGrounding(meta(ABSENT), rootFor);
    expect(r).toEqual({ state: "unreadable", vessel: VESSEL, test_file: ABSENT, why: "ENOENT" });
  });

  it("MUST-FAIL the compose refuses it before the planning call, at the named stage", () => {
    expect(fc.OWN_CHECK_UNREADABLE_STAGE).toBe("own_check_unreadable");
    const at = SRC.indexOf('if (ownCheckRead.state === "unreadable" && !testWritingScope)');
    expect(at).toBeGreaterThan(0);
    const branch = SRC.slice(at, SRC.indexOf("\n  }\n", at));
    expect(branch).toContain('verdict: "REFUSED", stage: OWN_CHECK_UNREADABLE_STAGE');
    expect(branch).toContain("ownCheckRead.test_file");
    // No planning or drafting call precedes the refusal.
    for (const call of ["llmCallWithFailover(", "draftContextThroughOpenModule({", "decomposePrompt(spec"]) {
      const first = SRC.indexOf(call, SRC.indexOf("async function resolveFeatureComposeInner("));
      expect(first).toBeGreaterThan(at);
    }
  });

  it("CONTROL a readable own check is shown, and ownCheckGrounding still returns the grounding or null", () => {
    const r = fc.readOwnCheckGrounding(meta(PRESENT), rootFor);
    expect(r.state).toBe("shown");
    expect(r.ctx.block).toContain(`repos/${VESSEL}/${PRESENT}`);
    expect(fc.ownCheckGrounding(meta(PRESENT), rootFor)?.test_file).toBe(PRESENT);
    expect(fc.ownCheckGrounding(meta(ABSENT), rootFor)).toBeNull();
  });

  it("CONTROL a gap with no own check reads none, so it is not refused", () => {
    expect(fc.readOwnCheckGrounding({ edit_site: `repos/${VESSEL}/src/subduing.ts` }, rootFor)).toEqual({ state: "none" });
  });
});
