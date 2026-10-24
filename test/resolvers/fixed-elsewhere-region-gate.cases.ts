// A FIXED_ELSEWHERE CLOSE ON A CHECK-SUPPLY CHECK REQUIRES THE CHECK TO HAVE PASSED THE REGION GATE (2026-10-24).
// concept-db's concept-delete row (implement-concept-delete-write-org-scoped-and-jwt-required-once-federation-write-
// shapes-default-to-none) closed "fixed elsewhere by 7e897a99579f: own check green on parent" on 23f78717's check,
// whose red was a request-validation 400 that never depended on the gap's region: armed before the arm step's region
// gate, its mutation_gate record carries no region_gate. markTerminalRefusal now refuses that close (the row stays
// open, own_check_green_on_parent naming the stage). A check whose region gate measured and passed closes; an
// "unmeasured" gate closes on today's rules and the close record says so; a row with a literal region, or whose check
// is not check supply's, closes as before. Driven against the real (temp) gap store and a real temp git clone, as
// terminal-refusal-fixed-elsewhere.cases.ts.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `fe-region-${Date.now()}-${Math.random().toString(36).slice(2)}`);
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const CLONES = join(ROOT, "clones");
const savedClones = process.env["VESSELS_CLONE_ROOT"];
const savedRuntime = process.env["MITOSIS_RUNTIME_DIR"];
process.env["VESSELS_CLONE_ROOT"] = CLONES;
process.env["MITOSIS_RUNTIME_DIR"] = CLONES; // the literal-region control's region is read where grounding reads it
const sg = await import("../../src/resolvers/substrate-gap.js");
const g2fLanding = await import("../../src/judge/gap-landing-verdict.js");
const RUN = Math.random().toString(36).slice(2, 8);
const VESSEL = "fer-vessel";
const REPO = join(CLONES, VESSEL);
const originalFetch = globalThis.fetch;
const savedStore = process.env["GAP_STORE_ENDPOINT"];
type Row = Record<string, unknown>;
const GREEN = "the gap's own check is already GREEN on the parent tree, so it cannot certify this draft";
// The concept-delete row's own mutation_gate record, as the live row carries it (armed 2026-10-24T12:40:43Z).
const CDB_MUTATION_GATE = { site: "src/routes/impulses.ts", k: 6, selected: 0, region: "declarations_the_check_names", decided: "nothing: the edit site has no mutable construct" };

function git(...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", REPO, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
}
function commitFile(rel: string, body: string, msg: string): string {
  mkdirSync(join(REPO, rel, ".."), { recursive: true });
  writeFileSync(join(REPO, rel), body);
  git("add", rel);
  git("commit", "-q", "-m", msg);
  return git("rev-parse", "HEAD");
}

beforeAll(() => {
  delete process.env["GAP_STORE_ENDPOINT"];
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  mkdirSync(REPO, { recursive: true });
  git("init", "-q");
  globalThis.fetch = (async () => Response.json({ content: { vessels: [] } })) as unknown as typeof fetch;
  sg.__setBirthJudgeForTests(async () => "present");
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  sg.__setBirthJudgeForTests(null);
  if (savedStore !== undefined) process.env["GAP_STORE_ENDPOINT"] = savedStore;
  if (savedClones !== undefined) process.env["VESSELS_CLONE_ROOT"] = savedClones; else delete process.env["VESSELS_CLONE_ROOT"];
  if (savedRuntime !== undefined) process.env["MITOSIS_RUNTIME_DIR"] = savedRuntime; else delete process.env["MITOSIS_RUNTIME_DIR"];
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});

const er = (testFile: string) => ({ shape: "test_suite", input: { vessel: VESSEL, test_file: testFile, only_tests: ["a > b"] }, zero_field: "requested_not_passing" });
async function write(id: string, meta: Row): Promise<Row> {
  const w = await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: { id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary: `fixed-elsewhere region-gate fixture ${id}`, classification_metadata: { falsifier: "class2", ...meta } } } as never);
  if (w.shape === "structuredError") throw new Error(JSON.stringify(w.body));
  await sg.__settleBirthEvaluationsForTests();
  return row(id);
}
async function row(id: string): Promise<Row> {
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  return ((r.body as { gaps?: Row[] }).gaps ?? [])[0]!;
}
const metaOf = (r: Row): Row => (r["classification_metadata"] ?? {}) as Row;
type Mark = (gap: Row, cb: Row) => Promise<void>;
const mark = (): Mark => {
  const f = (g2fLanding as Row)["markTerminalRefusal"] as Mark | undefined;
  expect(typeof f).toBe("function");
  return f!;
};
/** A check-supply row on `name`, born, then fixed by a commit touching its edit site; markTerminalRefusal judges it. */
async function fixedElsewhere(name: string, extra: Row): Promise<{ r: Row; fix: string }> {
  commitFile(`src/${name}.ts`, `export const ${name} = 1; // defect\n`, `seed ${name}`);
  commitFile(`test/checks/${name}.check.ts`, `// ${name} > b\n`, `seed ${name} check`);
  const id = `fer-${name}-${RUN}`;
  const born = await write(id, { edit_site: `repos/${VESSEL}/src/${name}.ts`, evidence_resolve: er(`test/checks/${name}.check.ts`), predicate_source: "gap_check_supply", ...extra });
  const fix = commitFile(`src/${name}.ts`, `export const ${name} = 2; // fixed elsewhere\n`, `fix ${name}`);
  await mark()(born, { failure_kind: "terminal_refusal", terminal_refusal: GREEN });
  return { r: await row(id), fix };
}
const armed = (mutation_gate: Row): Row => ({ check_supply: { state: "armed", vessel: VESSEL, mode: "check_file", mutation_gate } });

describe("markTerminalRefusal: a fixed_elsewhere close on a check-supply check needs the region gate", () => {
  it("[MUST-FAIL] the concept-delete row's close (its check armed without the region gate) is refused: the row stays open", async () => {
    const { r, fix } = await fixedElsewhere("cdb", armed(CDB_MUTATION_GATE));
    const m = metaOf(r);
    expect({ status: r["status"], closed_reason: m["closed_reason"] ?? null }).toEqual({ status: "open", closed_reason: null });
    const marker = m["own_check_green_on_parent"] as Row;
    expect(marker["stage"]).toBe("own_green_region_gate_not_run");
    expect(marker["fixed_by"]).toBe(fix);
  });

  it("[MUST-FAIL] a check the region gate refused does not close its row either", async () => {
    const { r } = await fixedElsewhere("refused", armed({ ...CDB_MUTATION_GATE, region_gate: { region: "derived_from_text_anchor", anchor: "not yet implemented", measured: 1, changed: 0, unmeasured: 0 } }));
    expect(r["status"]).toBe("open");
    expect((metaOf(r)["own_check_green_on_parent"] as Row)["stage"]).toBe("own_green_region_gate_refused");
  });

  it("[CONTROL] a check whose region gate measured and passed closes, and the close record says so", async () => {
    const { r, fix } = await fixedElsewhere("passed", armed({ ...CDB_MUTATION_GATE, region_gate: { region: "derived_from_text_anchor", anchor: "not yet implemented", measured: 1, changed: 1, unmeasured: 0 } }));
    expect(r["status"]).toBe("closed");
    const m = metaOf(r);
    expect(m["closed_reason"]).toBe("fixed_elsewhere");
    expect(m["falsifier_exercise"]).toMatchObject({ verdict: "absent", passed: true, fixed_by: fix, region_gate: "passed" });
  });

  it("[CONTROL] an unmeasured region gate (no derivable region) closes on today's rules; the close record says unmeasured", async () => {
    const { r } = await fixedElsewhere("unmeasured", armed({ ...CDB_MUTATION_GATE, region_gate: { decided: "unmeasured: no region" } }));
    expect(r["status"]).toBe("closed");
    expect((metaOf(r)["falsifier_exercise"] as Row)["region_gate"]).toBe("unmeasured: no region");
  });

  it("[CONTROL] a literal-region row, or a row whose check is not check supply's, closes as before (no region_gate on the record)", async () => {
    const lit = await fixedElsewhere("literal", { region: "export const literal = 1;", ...armed(CDB_MUTATION_GATE) });
    expect(lit.r["status"]).toBe("closed");
    expect((metaOf(lit.r)["falsifier_exercise"] as Row)["region_gate"]).toBeUndefined();
    const op = await fixedElsewhere("operator", { predicate_source: "operator" });
    expect(op.r["status"]).toBe("closed");
    expect((metaOf(op.r)["falsifier_exercise"] as Row)["region_gate"]).toBeUndefined();
  });
});
