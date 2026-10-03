import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";

// ARM-TIME REGION GATE (2026-10-03, gap arm-time-gap-writes-accept-prose-regions-so-class2-gaps-ground-on-the-file-top).
//
// Compose grounding (gap-to-feature region->line) looks for classification_metadata.region as a LITERAL
// substring of the edit_site file. Armed (class2) gaps carried PROSE regions — "deliverable-shapes
// (~1269-1340)…", "TranslatingTraceSink options + record() body" — which occur nowhere in the file, so
// grounding fell back to the top of the file and the drafter edited the wrong lines, over and over.
// The write that ARMS such a gap is now refused unless the region occurs exactly once in edit_site, read
// where grounding reads it. An unreadable edit_site is refused too: ENOENT read as "absent" is how the
// class-1 arming guard came to never fire.

const testWorkspace = join(tmpdir(), `dev-vessel-arm-region-test-${Date.now()}-${process.pid}`);
rmSync(testWorkspace, { recursive: true, force: true });
mkdirSync(join(testWorkspace, "gaps"), { recursive: true });
process.env["WORKSPACE_ROOT"] = testWorkspace;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
// The post-write event publish goes to ACTIVITY_API_ENDPOINT (default 127.0.0.1:8080): aim it at a closed port.
process.env["ACTIVITY_API_ENDPOINT"] = "http://127.0.0.1:9";

// The runtime tree grounding reads (MITOSIS_RUNTIME_DIR/<vessel>/...), holding one fixture source file.
const runtimeDir = join(testWorkspace, "vessels");
const SITE = "repos/demo-vessel/src/demo.ts";
const OTHER_SITE = "repos/demo-vessel/src/other.ts";
mkdirSync(join(runtimeDir, "demo-vessel", "src"), { recursive: true });
writeFileSync(
  join(runtimeDir, "demo-vessel", "src", "demo.ts"),
  ["export function onceOnly(): number {", "  return 1;", "}", "export const a = 'dup-marker';", "export const b = 'dup-marker';", ""].join("\n"),
);
writeFileSync(join(runtimeDir, "demo-vessel", "src", "other.ts"), "export const nothingHere = 0;\n");

const { resolveSubstrateGapWrite, gapStoreRootForTest } =
  await import(`../../src/resolvers/substrate-gap.js?${"arm-region-isolated"}`);

if (!gapStoreRootForTest().startsWith(tmpdir())) {
  throw new Error(`substrate-gap-arm-region.test.ts is NOT isolated: the store root ${gapStoreRootForTest()} is not under ${tmpdir()}`);
}

let savedRuntime: string | undefined;
beforeAll(() => { savedRuntime = process.env["MITOSIS_RUNTIME_DIR"]; process.env["MITOSIS_RUNTIME_DIR"] = runtimeDir; });
afterAll(() => {
  if (savedRuntime === undefined) delete process.env["MITOSIS_RUNTIME_DIR"]; else process.env["MITOSIS_RUNTIME_DIR"] = savedRuntime;
  rmSync(testWorkspace, { recursive: true, force: true });
});

const vocab = () => ({
  shapes: new Set(["trace_failure_pattern_report", "substrateGap", ...Array.from({ length: 60 }, (_, i) => `filler_shape_${i}`)]),
  configs_read: 9,
});
const noNetworkBirthJudge = async (): Promise<string> => "present";
const opts = () => ({ vocabulary: vocab(), birthJudge: noNetworkBirthJudge });
const CHECK = { evidence_resolve: { shape: "trace_failure_pattern_report", nonzero_field: "occurrence_count" } };

const write = (id: string, meta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  resolveSubstrateGapWrite({
    type: "substrateGap_write",
    gap: {
      id, category: "systematic_failure", source: "operator_narration", status: "open",
      summary: `measured defect for ${id}: grounding lands on the wrong lines`, detected_at: "2026-10-03T00:00:00Z",
      classification_metadata: meta, ...extra,
    },
  }, opts()) as Promise<{ shape: string; body: Record<string, unknown> }>;
const armed = (id: string, meta: Record<string, unknown>) => write(id, { ...CHECK, edit_site: SITE, ...meta });

const store = (): Array<Record<string, unknown>> => {
  try { return JSON.parse(readFileSync(join(testWorkspace, "gaps", "gaps.json"), "utf8")); } catch { return []; }
};
const row = (id: string) => store().find((g) => g["id"] === id);
const seed = (rows: Array<Record<string, unknown>>) => writeFileSync(join(testWorkspace, "gaps", "gaps.json"), JSON.stringify([...store(), ...rows]));

describe("arming a class2 gap: the region must be a once-literal of edit_site", () => {
  it("[MUST-FAIL] a region absent from edit_site is refused with occurrences 0, and nothing is stored", async () => {
    const r = await armed("arm-region-absent", { region: "deliverable-shapes (~1269-1340) and the record() body" });
    expect(r.shape).toBe("structuredError");
    expect(r.body["error"]).toBe("region_not_literal_once");
    expect(r.body["occurrences"]).toBe(0);
    expect(r.body["edit_site"]).toBe(SITE);
    expect(row("arm-region-absent")).toBeUndefined();
  });

  it("[MUST-FAIL] a region present twice is refused with occurrences 2", async () => {
    const r = await armed("arm-region-twice", { region: "dup-marker" });
    expect(r.shape).toBe("structuredError");
    expect(r.body["error"]).toBe("region_not_literal_once");
    expect(r.body["occurrences"]).toBe(2);
    expect(row("arm-region-twice")).toBeUndefined();
  });

  it("a region present exactly once is accepted and the gap is armed", async () => {
    const r = await armed("arm-region-once", { region: "function onceOnly" });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(r.body["falsifier"]).toBe("class2");
    expect((row("arm-region-once")!["classification_metadata"] as Record<string, unknown>)["region"]).toBe("function onceOnly");
  });

  it("[MUST-FAIL] an unreadable edit_site is refused (fail closed), never read as 'absent'", async () => {
    const missing = await armed("arm-site-missing", { edit_site: "repos/demo-vessel/src/missing.ts", region: "anything" });
    expect(missing.shape).toBe("structuredError");
    expect(missing.body["error"]).toBe("edit_site_unreadable");
    expect(row("arm-site-missing")).toBeUndefined();
    // a ":line" suffix or prose is not a file: ungroundable, so refused the same way
    const suffixed = await armed("arm-site-suffixed", { edit_site: `${SITE}:12`, region: "function onceOnly" });
    expect(suffixed.shape).toBe("structuredError");
    expect(suffixed.body["error"]).toBe("edit_site_unreadable");
  });

  it("[MUST-FAIL] a region spanning lines is refused: grounding matches one line at a time", async () => {
    const r = await armed("arm-region-multiline", { region: "return 1;\n}" });
    expect(r.shape).toBe("structuredError");
    expect(r.body["error"]).toBe("region_spans_lines");
  });

  it("CONTROL: an armed gap with no region is unchanged", async () => {
    const r = await armed("arm-no-region", {});
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(r.body["falsifier"]).toBe("class2");
  });

  it("CONTROL: an UNARMED gap with a prose region is accepted", async () => {
    const r = await write("unarmed-prose-region", { edit_site: SITE, region: "TranslatingTraceSink options + record() body" });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(r.body["falsifier"]).toBe("none");
  });

  it("CONTROL: a close of an armed row carrying a prose region is not refused", async () => {
    seed([{ id: "armed-legacy-close", category: "systematic_failure", source: "operator_narration", status: "open", summary: "legacy armed row",
      detected_at: "2026-10-01T00:00:00Z", classification_metadata: { ...CHECK, edit_site: SITE, region: "a prose region", falsifier: "class2" } }]);
    const r = await write("armed-legacy-close", { ...CHECK, edit_site: SITE, region: "a prose region" }, { status: "closed", closed_reason: "operator" , operator: "operator:test" });
    expect(r.body["error"]).not.toBe("region_not_literal_once");
  });
});

describe("an already-armed row is not refused retroactively", () => {
  const legacy = (id: string, status = "open") => ({
    id, category: "systematic_failure", source: "operator_narration", status, summary: `legacy armed row ${id}`,
    detected_at: "2026-10-01T00:00:00Z",
    classification_metadata: { ...CHECK, edit_site: SITE, region: "a prose region from before the gate", falsifier: "class2" },
  });

  it("CONTROL: an update that leaves region and edit_site unchanged is accepted", async () => {
    seed([legacy("armed-legacy-same")]);
    const r = await armed("armed-legacy-same", { region: "a prose region from before the gate" });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(r.body["action"]).toBe("updated");
  });

  it("CONTROL: an update that omits region (carried forward unchanged) is accepted", async () => {
    seed([legacy("armed-legacy-omit")]);
    const r = await write("armed-legacy-omit", { failed_attempts: 1 });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(r.body["action"]).toBe("updated");
  });

  it("[MUST-FAIL] an update that CHANGES the region to a non-literal is refused", async () => {
    seed([legacy("armed-legacy-reregion")]);
    const r = await armed("armed-legacy-reregion", { region: "another prose region" });
    expect(r.shape).toBe("structuredError");
    expect(r.body["error"]).toBe("region_not_literal_once");
  });

  it("[MUST-FAIL] an update that CHANGES edit_site is validated against the new file", async () => {
    seed([{ ...legacy("armed-legacy-resite"), classification_metadata: { ...CHECK, edit_site: SITE, region: "function onceOnly", falsifier: "class2" } }]);
    const r = await armed("armed-legacy-resite", { edit_site: OTHER_SITE, region: "function onceOnly" });
    expect(r.shape).toBe("structuredError");
    expect(r.body["occurrences"]).toBe(0);
    expect(r.body["edit_site"]).toBe(OTHER_SITE);
  });

  it("[MUST-FAIL] reopening a closed armed row re-arms it, so its region is checked", async () => {
    seed([legacy("armed-legacy-reopen", "closed")]);
    const r = await armed("armed-legacy-reopen", { region: "a prose region from before the gate" });
    expect(r.shape).toBe("structuredError");
    expect(r.body["error"]).toBe("region_not_literal_once");
  });
});
