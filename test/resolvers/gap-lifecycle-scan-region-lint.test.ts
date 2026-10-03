import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveGapLifecycleScan } from "../../src/resolvers/gap-lifecycle-scan.js";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// REGION LINT (2026-10-03): the read-only census behind the arm-time region gate. The gate stops NEW arms with a
// region that is not a once-literal of edit_site; rows armed before it still carry prose regions that ground the
// draft on the file top. gap_lifecycle_scan {region_lint:true} lists the OPEN armed rows whose region fails the
// same check, with the occurrence count, and writes nothing.

const root = join(tmpdir(), `dev-vessel-region-lint-${Date.now()}-${process.pid}`);
const gapsPath = join(root, "gaps.json");
const proposalsDir = join(root, "proposals");
const runtimeDir = join(root, "vessels");
const SITE = "repos/demo-vessel/src/demo.ts";

const armedMeta = (region: unknown, site: string = SITE, falsifier: unknown = "class2") => ({
  evidence_resolve: { shape: "trace_failure_pattern_report" }, edit_site: site, region, falsifier,
});
const fixture = [
  { id: "lint-absent", status: "open", classification_metadata: armedMeta("deliverable-shapes (~1269-1340)") },
  { id: "lint-twice", status: "open", classification_metadata: armedMeta("dup-marker") },
  { id: "lint-once", status: "open", classification_metadata: armedMeta("function onceOnly") },
  { id: "lint-unarmed-prose", status: "open", classification_metadata: armedMeta("prose about the record() body", SITE, "none") },
  { id: "lint-closed-prose", status: "closed", classification_metadata: armedMeta("prose about the record() body") },
  { id: "lint-unreadable", status: "open", classification_metadata: armedMeta("function onceOnly", `${SITE}:40`) },
  { id: "lint-no-region", status: "open", classification_metadata: armedMeta(undefined) },
  { id: "lint-object-class", status: "open", classification_metadata: armedMeta("TranslatingTraceSink options", SITE, { class: "class2" }) },
];

let savedRuntime: string | undefined;
beforeAll(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(proposalsDir, ".applied"), { recursive: true });
  mkdirSync(join(runtimeDir, "demo-vessel", "src"), { recursive: true });
  writeFileSync(join(runtimeDir, "demo-vessel", "src", "demo.ts"),
    ["export function onceOnly(): number {", "  return 1;", "}", "export const a = 'dup-marker';", "export const b = 'dup-marker';", ""].join("\n"));
  writeFileSync(gapsPath, JSON.stringify(fixture));
  savedRuntime = process.env["MITOSIS_RUNTIME_DIR"];
  process.env["MITOSIS_RUNTIME_DIR"] = runtimeDir;
});
afterAll(() => {
  if (savedRuntime === undefined) delete process.env["MITOSIS_RUNTIME_DIR"]; else process.env["MITOSIS_RUNTIME_DIR"] = savedRuntime;
  rmSync(root, { recursive: true, force: true });
});

describe("gap_lifecycle_scan region_lint", () => {
  it("[MUST-FAIL] flags exactly the OPEN armed gaps whose region is not a once-literal of edit_site, with counts", async () => {
    const before = readFileSync(gapsPath, "utf8");
    const r = await resolveGapLifecycleScan({ type: "gap_lifecycle_scan", gapsPath, proposalsDir, region_lint: true }) as { shape: string; body: Record<string, unknown> };
    expect(r.shape).toBe("gapLifecycleReport");
    const flagged = r.body["region_lint"] as Array<{ id: string; occurrences: number | null; error: string; edit_site: string; region: string }>;
    expect(flagged.map((f) => f.id).sort()).toEqual(["lint-absent", "lint-object-class", "lint-twice", "lint-unreadable"]);
    const by = new Map(flagged.map((f) => [f.id, f]));
    expect(by.get("lint-absent")!.occurrences).toBe(0);
    expect(by.get("lint-twice")!.occurrences).toBe(2);
    expect(by.get("lint-object-class")!.occurrences).toBe(0);
    expect(by.get("lint-unreadable")!.error).toBe("edit_site_unreadable");
    expect(by.get("lint-absent")!.edit_site).toBe(SITE);
    expect(r.body["armed_with_region"]).toBe(5);
    // read-only: the store is byte-identical
    expect(readFileSync(gapsPath, "utf8")).toBe(before);
  });
});
