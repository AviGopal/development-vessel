// volumeNodeId()'S KEY PATH IS ONE THE TEST SCRUB REDIRECTS (self-fact-reconcile.ts).
//
// The test scrub (pull-sync's scrubbed_env for the node gate, and learnedStateDefaults for isolated children) points
// every `process.env.X ?? "/workspace/..."` default it finds in src at a scratch path. volumeNodeId() held its default
// in a named constant, which no such scan can see: the redirect of VESSEL_IDENTITY_KEY_PATH held only because
// discovery-registration.ts happens to read the same name inline, and a suite run without that file's read (or
// without the scrub) resolved the live identity key.
// MUST-FAIL: self-fact-reconcile.ts ALONE yields the VESSEL_IDENTITY_KEY_PATH redirect with its /workspace default
//   (red at the parent: the named constant yields nothing).
// CONTROL: discovery-registration.ts alone yields the same name and default, so both reads are redirected to one path.
import { describe, it, expect, afterAll } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { learnedStateDefaults } from "../../src/test-child-env.js";

const SRC = new URL("../../src/", import.meta.url).pathname;
const dirs: string[] = [];
function scanOnly(rel: string): Map<string, string> {
  const d = mkdtempSync(join(tmpdir(), "key-path-scan-"));
  dirs.push(d);
  copyFileSync(join(SRC, rel), join(d, rel.split("/").pop()!));
  return learnedStateDefaults(d);
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("volumeNodeId key path: visible to the test scrub", () => {
  it("MUST-FAIL: self-fact-reconcile.ts alone yields the VESSEL_IDENTITY_KEY_PATH redirect", () => {
    expect(scanOnly("resolvers/self-fact-reconcile.ts").get("VESSEL_IDENTITY_KEY_PATH")).toBe("/workspace/keys/development-vessel.ed25519.pem");
  });
  it("CONTROL: discovery-registration.ts alone yields the same name and default", () => {
    expect(scanOnly("discovery-registration.ts").get("VESSEL_IDENTITY_KEY_PATH")).toBe("/workspace/keys/development-vessel.ed25519.pem");
  });
});
