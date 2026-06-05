import { describe, it, expect, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMitosisPendingObserver } from "../../src/resolvers/mitosis-pending-observer.js";

const root = join(tmpdir(), `dev-vessel-mitosis-pending-${Date.now()}`);

beforeAll(() => {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "mitosis-pending.json"),
    JSON.stringify({
      vessel_name: "development-vessel",
      mitosis_version_id: "mitosis-2026-06-05T04-43-06-733Z",
      base_sha: "eb02368b7dce",
      staged_at: "2026-06-05T04:43:10.959Z",
      authored_by: "apply_proposal_as_patch",
      proposal: "auto-001-report.json",
      target_file: "src/resolvers/x.ts",
      staged_files: ["src/resolvers/x.ts"],
    }),
  );
});

describe("mitosis_pending_observer", () => {
  it("emits mitosisPendingState reflecting the staging pointer", async () => {
    const result = await resolveMitosisPendingObserver({
      type: "mitosis_pending_observer",
      workspaceRoot: root,
    });
    expect(result.shape).toBe("mitosisPendingState");
    const body = result.body as {
      has_pending: boolean;
      pending: { vessel_name: string; staged_files: string[] } | null;
      file_present: boolean;
      file_age_ms: number | null;
    };
    expect(body.has_pending).toBe(true);
    expect(body.file_present).toBe(true);
    expect(body.pending?.vessel_name).toBe("development-vessel");
    expect(body.pending?.staged_files).toEqual(["src/resolvers/x.ts"]);
    expect(typeof body.file_age_ms).toBe("number");
  });

  it("degrades to no-pending when file absent", async () => {
    const result = await resolveMitosisPendingObserver({
      type: "mitosis_pending_observer",
      workspaceRoot: join(tmpdir(), `mp-missing-${Date.now()}`),
    });
    const body = result.body as { has_pending: boolean; file_present: boolean; pending: unknown };
    expect(body.has_pending).toBe(false);
    expect(body.file_present).toBe(false);
    expect(body.pending).toBeNull();
  });

  it("tolerates malformed JSON without throwing", async () => {
    const badRoot = join(tmpdir(), `mp-bad-${Date.now()}`);
    mkdirSync(badRoot, { recursive: true });
    writeFileSync(join(badRoot, "mitosis-pending.json"), "{ this is not json");
    const result = await resolveMitosisPendingObserver({
      type: "mitosis_pending_observer",
      workspaceRoot: badRoot,
    });
    const body = result.body as { has_pending: boolean; file_present: boolean };
    expect(body.file_present).toBe(true);
    expect(body.has_pending).toBe(false);
  });
});
