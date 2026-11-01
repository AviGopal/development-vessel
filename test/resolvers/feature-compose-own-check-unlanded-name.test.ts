// THE DRAFTER'S OWN CHECK IS THE ARMED CHECK, NEVER THE SUPPLY'S NAME. gap-check-supply wrote check_supply.test_file
// at send, before any check existed. The drafter's own-check grounding (readOwnCheckGrounding) reads only the
// evidence_resolve test_suite check, which the supply writes after reading the file at origin/dev.
//
// Expected (CONTROLS: this reader already holds; they keep it so):
//   - a sent-but-unlanded row (check_supply.test_file names an absent file, no evidence_resolve) reads none;
//   - a row whose evidence_resolve names a present check is shown it, with or without a check_supply.test_file;
//   - a row with check_supply.test_file null and evidence_resolve naming a present file in another vessel is shown it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(tmpdir(), `own-check-unlanded-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = `unlanded-${RUN}-vessel`;
const OTHER = `unlanded-${RUN}-other`;
const PRESENT = "test/checks/landed.check.ts";
const ABSENT = "test/checks/never-landed.check.ts";
const EVIDENCE_ONLY = "src/services/thing.test.ts";
const rootFor = (v: string): string => join(ROOT, v);
const er = (vessel: string, file: string) => ({ shape: "test_suite", input: { vessel: `repos/${vessel}`, test_file: file, only_tests: ["thing > works"] }, zero_field: "requested_not_passing" });

beforeAll(() => {
  for (const [v, f] of [[VESSEL, PRESENT], [OTHER, EVIDENCE_ONLY]] as const) {
    const abs = join(ROOT, v, f);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'import { it, expect } from "bun:test";\nit("works", () => { expect(1).toBe(1); });\n');
  }
});
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

describe("the drafter's own-check grounding reads the armed check, not the send's name", () => {
  it("CONTROL a sent-but-unlanded row reports NO own check", () => {
    const meta = { edit_site: `repos/${VESSEL}/src/x.ts`, check_supply: { state: "goal_dispatched", vessel: VESSEL, test_file: ABSENT, intended_test_file: ABSENT } };
    expect(fc.readOwnCheckGrounding(meta, rootFor)).toEqual({ state: "none" });
    expect(fc.ownCheckGrounding(meta, rootFor)).toBeNull();
  });

  it("CONTROL a row whose check file IS present is shown it", () => {
    const meta = { edit_site: `repos/${VESSEL}/src/x.ts`, check_supply: { state: "armed", vessel: VESSEL, test_file: PRESENT }, evidence_resolve: er(VESSEL, PRESENT) };
    const r = fc.readOwnCheckGrounding(meta, rootFor);
    expect(r.state).toBe("shown");
    expect(r.ctx.test_file).toBe(PRESENT);
  });

  it("CONTROL check_supply.test_file null, evidence_resolve naming a present file in another vessel: shown", () => {
    const meta = { edit_site: `repos/${OTHER}/src/services/thing.ts`, check_supply: { test_file: null }, evidence_resolve: er(OTHER, EVIDENCE_ONLY) };
    const r = fc.readOwnCheckGrounding(meta, rootFor);
    expect(r.state).toBe("shown");
    expect(r.ctx).toMatchObject({ vessel: OTHER, test_file: EVIDENCE_ONLY });
  });
});
