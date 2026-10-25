/**
 * checkSupplySite: the row's edit_site wins whenever it is set.
 *
 * It used to win only under repos/<vessel>/ and only for a file already in the clone, so a row naming
 * a file its fix creates, or a site outside the vessel tree, was re-sited onto the first existing
 * src/*.ts its summary mentioned (often src/index.ts). The summary fallback is for rows with no
 * edit_site only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `gcs-site-wins-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
const VESSEL = "development-vessel";
const ENV_KEYS = ["WORKSPACE_ROOT", "VESSELS_CLONE_ROOT", "SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", "GAP_STORE_ENDPOINT"] as const;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
process.env["WORKSPACE_ROOT"] = ROOT;
process.env["VESSELS_CLONE_ROOT"] = CLONES;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
delete process.env["GAP_STORE_ENDPOINT"];

const { checkSupplySite } = await import("../../src/resolvers/gap-check-supply.js");

beforeAll(() => {
  // The clone holds the files the summaries name; the edit_site file of the first row does NOT exist yet.
  mkdirSync(join(CLONES, VESSEL, "src", "resolvers"), { recursive: true });
  writeFileSync(join(CLONES, VESSEL, "src", "index.ts"), "export {};\n");
  writeFileSync(join(CLONES, VESSEL, "src", "resolvers", "substrate-gap.ts"), "export {};\n");
});
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const row = (summary: string, edit_site?: string) => ({
  id: "fixture-row",
  summary,
  classification_metadata: edit_site ? { edit_site } : {},
});

describe("checkSupplySite", () => {
  test("MUST-FAIL: a row whose edit_site names a file its fix creates resolves to that file, not the summary's src/index.ts", () => {
    const r = row(
      "a suite run can still reach live state; the lane's test env is built in src/index.ts and the scrub misses roots",
      "repos/development-vessel/src/resolvers/test-child-env.ts",
    );
    expect(checkSupplySite(r, VESSEL)).toBe("repos/development-vessel/src/resolvers/test-child-env.ts");
  });

  test("MUST-FAIL: an edit_site outside the vessel tree resolves to itself", () => {
    const r = row("federation doc describes the relay wrongly; see src/index.ts", "docs/FEDERATION.md");
    expect(checkSupplySite(r, VESSEL)).toBe("docs/FEDERATION.md");
  });

  test("a line suffix on the edit_site is dropped, as before", () => {
    expect(checkSupplySite(row("x", "repos/development-vessel/src/index.ts:42"), VESSEL)).toBe("repos/development-vessel/src/index.ts");
  });

  test("CONTROL: with no edit_site, the summary's first existing src file is the site", () => {
    const r = row("the gap store write in src/resolvers/substrate-gap.ts drops a field; also see src/index.ts");
    expect(checkSupplySite(r, VESSEL)).toBe("repos/development-vessel/src/resolvers/substrate-gap.ts");
  });

  test("CONTROL: with no edit_site, a summary naming only absent files has no site", () => {
    expect(checkSupplySite(row("something in src/not-there.ts is wrong"), VESSEL)).toBeNull();
  });
});
