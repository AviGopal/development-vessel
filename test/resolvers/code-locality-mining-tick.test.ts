import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCodeLocalityMiningTick } from "../../src/resolvers/code-locality-mining-tick.js";

// This test used to call the resolver with a BARE pointer. Both paths default to live locations,
// so every suite run scanned the real /workspace/proposals AND WROTE
// /workspace/locality/code-locality-index.json — a unit test mutating running substrate state,
// and slow enough (a large real directory) to blow bun's 5s timeout. Its only assertions were
// `typeof r.shape === "string"` and `has body`, which any return value satisfies, so it could
// not fail for a reason worth knowing.
//
// proposalsDir, indexPath and dry_run are all injectable on the pointer — nothing about the
// resolver required touching live state. Pointed at a tmp fixture, the aggregation is assertable.

describe("code_locality_mining_tick resolver", () => {
  let base: string;
  let proposalsDir: string;
  let indexPath: string;

  const writeReport = (name: string, body: unknown): void =>
    writeFileSync(join(proposalsDir, name), JSON.stringify(body));

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "locality-tick-"));
    proposalsDir = join(base, "proposals");
    indexPath = join(base, "locality", "code-locality-index.json");
    mkdirSync(proposalsDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
  });

  const run = (extra: Record<string, unknown> = {}) =>
    resolveCodeLocalityMiningTick({
      type: "code_locality_mining_tick",
      proposalsDir,
      indexPath,
      ...extra,
    } as never);

  it("returns codeLocalityIndex and writes the index", async () => {
    writeReport("gap-alpha-compose-report.json", {
      ok: true,
      applied: [{ ok: true, path: "repos/demo/src/a.ts", span: { start: 1, end: 5 } }],
    });
    const r = await run();
    expect(r.shape).toBe("codeLocalityIndex");
    const body = r.body as Record<string, any>;
    expect(body["scanned"]).toBe(true);
    expect(body["index_path"]).toBe(indexPath);
    expect(existsSync(indexPath)).toBe(true);
  });

  it("counts only reports with ok:true as favorable, but scans them all", async () => {
    writeReport("gap-alpha-compose-report.json", { ok: true, applied: [] });
    writeReport("gap-beta-compose-report.json", { ok: false, applied: [] });
    const body = (await run()).body as Record<string, any>;
    expect(body["total_reports_scanned"]).toBe(2);
    expect(body["favorable_reports"]).toBe(1);
  });

  it("derives family keys: route-edit-<hash> is a goal, anything else a gap", async () => {
    writeReport("route-edit-deadbeef-compose-report.json", { ok: true, applied: [] });
    writeReport("gap-alpha-compose-report.json", { ok: true, applied: [] });
    const body = (await run()).body as Record<string, any>;
    const families = body["families_summary"].map((f: any) => f.family).sort();
    expect(families).toEqual(["gap:gap-alpha", "goal:deadbeef"]);
  });

  it("one unparseable report never fails the tick", async () => {
    // Stated intent in the resolver: "(a) one bad file never fails the tick".
    writeFileSync(join(proposalsDir, "gap-broken-compose-report.json"), '{"ok": true, "appl');
    writeReport("gap-good-compose-report.json", { ok: true, applied: [] });
    const r = await run();
    expect(r.shape).toBe("codeLocalityIndex");
    const body = r.body as Record<string, any>;
    // the broken file is skipped BEFORE the scan counter increments
    expect(body["total_reports_scanned"]).toBe(1);
    expect(body["favorable_reports"]).toBe(1);
  });

  it("dry_run does not write the index", async () => {
    writeReport("gap-alpha-compose-report.json", { ok: true, applied: [] });
    const body = (await run({ dry_run: true })).body as Record<string, any>;
    expect(body["dry_run"]).toBe(true);
    expect(existsSync(indexPath)).toBe(false);
  });

  it("a missing proposals directory is zero reports, not a failure", async () => {
    const r = await resolveCodeLocalityMiningTick({
      type: "code_locality_mining_tick",
      proposalsDir: join(base, "does-not-exist"),
      indexPath,
      dry_run: true,
    } as never);
    expect(r.shape).toBe("codeLocalityIndex");
    const body = r.body as Record<string, any>;
    expect(body["total_reports_scanned"]).toBe(0);
    expect(body["family_count"]).toBe(0);
  });
});
