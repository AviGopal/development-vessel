import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("resolveDocsAlignScan", () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "docs-align-scan-"));
    originalEnv = process.env["DOC_FIX_ROOT"];
    process.env["DOC_FIX_ROOT"] = tmpDir;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env["DOC_FIX_ROOT"];
    } else {
      process.env["DOC_FIX_ROOT"] = originalEnv;
    }
  });

  it("detects drift when README has seed-live but not make -C scripts/substrate up", async () => {
    writeFileSync(join(tmpDir, "README.md"), "Run seed-live to bootstrap the system.\n");

    // Mock resolveSubstrateGapWrite
    const gapMock = mock(() =>
      Promise.resolve({ shape: "substrateGap", body: { gap_id: "test-gap" } }),
    );

    mock.module("../../src/resolvers/substrate-gap.js", () => ({
      resolveSubstrateGapWrite: gapMock,
    }));

    const { resolveDocsAlignScan } = await import("../../src/resolvers/docs-align-scan.js");
    const result = await resolveDocsAlignScan({ type: "docs_align_scan" });

    expect(result.shape).toBe("docsAlignReport");
    const body = result.body as Record<string, unknown>;
    expect(body["drift_detected"]).toBe(true);
    expect(body["gaps_written"]).toBe(1);
  });

  it("reports no drift when README does not contain seed-live", async () => {
    writeFileSync(
      join(tmpDir, "README.md"),
      "Run make -C scripts/substrate up to bootstrap.\n",
    );

    const { resolveDocsAlignScan } = await import("../../src/resolvers/docs-align-scan.js");
    const result = await resolveDocsAlignScan({ type: "docs_align_scan" });

    expect(result.shape).toBe("docsAlignReport");
    const body = result.body as Record<string, unknown>;
    expect(body["drift_detected"]).toBe(false);
  });

  it("dry_run skips gap write when drift detected", async () => {
    writeFileSync(join(tmpDir, "README.md"), "Run seed-live to bootstrap.\n");

    const { resolveDocsAlignScan } = await import("../../src/resolvers/docs-align-scan.js");
    const result = await resolveDocsAlignScan({ type: "docs_align_scan", dry_run: true });

    expect(result.shape).toBe("docsAlignReport");
    const body = result.body as Record<string, unknown>;
    expect(body["drift_detected"]).toBe(true);
    expect(body["gaps_written"]).toBe(0);
    expect(body["dry_run"]).toBe(true);
  });
});
