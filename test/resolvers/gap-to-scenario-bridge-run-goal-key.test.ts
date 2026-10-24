// THE BRIDGE'S SCAFFOLD DISPATCH CARRIES THIS VESSEL'S KEY (operator security review, 2026-10-19).
//
// goal-host's /run-goal authenticates its callers (goal-host src/inbound-auth.ts). The bridge's vessel-authoring
// dispatch was the one development-vessel caller that POSTed to it with no Authorization at all, so under the door it
// would be refused and the scaffold never dispatched. CONTRACT: the dispatch sends `Authorization: ApiKey <this
// vessel's METABOB_API_KEY>`; control: the request still names the scaffold template and the gap's capability shape.
// SEAM: globalThis.fetch records the /run-goal request; config's key is set before the module graph loads (when an
// earlier file in the same process loaded config without a key, the header must then be absent, and the case says so).
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Empty counts as unset: a scrubbed test env may carry the name with no value.
if (!process.env["METABOB_API_KEY"]) process.env["METABOB_API_KEY"] = "bridge-run-goal-key-fixture";
const { METABOB_API_KEY } = await import("../../src/config.js");
const { resolveGapToScenarioBridge } = await import("../../src/resolvers/gap-to-scenario-bridge.js");

const root = join(tmpdir(), `bridge-run-goal-key-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const realFetch = globalThis.fetch;
let runGoal: Array<{ authorization: string | null; body: Record<string, any> }> = [];
let savedRoot: string | undefined;

beforeEach(() => {
  savedRoot = process.env["WORKSPACE_ROOT"];
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "gaps"), { recursive: true });
  mkdirSync(join(root, "validation", "failure-modes", "scenarios"), { recursive: true });
  writeFileSync(join(root, "gaps", "gaps.json"), JSON.stringify([{
    id: "bridge-run-goal-key-gap", category: "missing_capability", source: "substrate_detected", status: "open",
    summary: "bridge key fixture", classification_metadata: { shape: "bridgeKeyFixtureShape" },
  }]));
  process.env["WORKSPACE_ROOT"] = root;
  runGoal = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const u = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (u.endsWith("/run-goal")) {
      runGoal.push({ authorization: new Headers(init?.headers as HeadersInit | undefined).get("authorization"), body: JSON.parse(String(init?.body ?? "{}")) });
      return Response.json({ dispatchId: "bridge-fixture", status: "running" }, { status: 202 });
    }
    return Response.json({ error: "no network in this test" }, { status: 503 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedRoot === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = savedRoot;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("gap_to_scenario_bridge scaffold dispatch", () => {
  it("bridge-run-goal-key the vessel-authoring dispatch to goal-host carries this vessel's ApiKey", async () => {
    await resolveGapToScenarioBridge({
      type: "gap_to_scenario_bridge",
      scenarios_dir: join(root, "validation", "failure-modes", "scenarios"),
      vessel_scenarios_dir: join(root, "validation", "failure-modes", "vessel-scenarios"),
    } as never);
    expect(runGoal.length).toBe(1);
    if (METABOB_API_KEY) expect(runGoal[0]!.authorization).toBe(`ApiKey ${METABOB_API_KEY}`);
    else expect(runGoal[0]!.authorization).toBeNull();
    expect(runGoal[0]!.body["targetTemplateId"]).toBe("development-vessel:scaffold-and-publish-vessel");
    expect(runGoal[0]!.body["variables"]?.capability_shape).toBe("bridgeKeyFixtureShape");
  });
});
