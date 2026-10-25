import { beforeEach, afterEach, test, expect } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as mod from "../../src/resolvers/gap-to-scenario-bridge";

// This check pins the correct behaviour for vessel-authoring dispatch:
// when the bridge posts a goal to goal-host, it MUST include goal text and tags
// for the target template, rather than posting only a bare scenario id + shape.
//
// Current defect (origin/dev): the POST body contains only scenario_id and
// capability_shape, and the catch swallows every error. The right behaviour is
// to include goal_text and tags in variables (and to surface failures), so this
// assertion intentionally expects those keys and will FAIL until the bridge is
// corrected.

let baseDir = "";
let scenariosDir = "";
let vesselScenariosDir = "";

const saved = { fetch: globalThis.fetch } as { fetch: typeof fetch };

const captured: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "g2sb-"));
  scenariosDir = join(baseDir, "scenarios");
  vesselScenariosDir = join(baseDir, "vessel-scenarios");
  await mkdir(scenariosDir, { recursive: true });
  await mkdir(vesselScenariosDir, { recursive: true });

  // Stub fetch so no network is performed and the POST payload is captured.
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toString();
    const bodyText = typeof init?.body === "string" ? init!.body : (init?.body ? String(init.body) : "");
    const parsed = bodyText ? JSON.parse(bodyText) : undefined;
    captured.push({ url: url.toString(), method, body: parsed });
    // Return a benign 200 so the resolver proceeds as if dispatch succeeded.
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = saved.fetch;
  await rm(baseDir, { recursive: true, force: true });
  captured.length = 0;
});

// Utility: craft a gap that most likely routes as vessel-authoring.
function vesselAuthoringGap(id: string, shape: string) {
  return {
    id,
    // Provide multiple routing hints so the bridge's classifier recognizes vessel-authoring.
    meta: {
      shape,
      routing_class: "vessel_authoring",
      routing_classes: ["vessel_authoring"],
      scenario_kind: "vessel_authoring",
      tags: ["vessel.addition", "authoring"],
    },
    // Some bridges consult a pre-baked category; include it to maximize routing.
    category: "vessel_authoring",
  } as unknown as Record<string, unknown>;
}

test("gap-to-scenario bridge posts vessel-authoring goal WITH goal_text and tags", async () => {
  // Arrange: pointer with writable dirs and three candidate gaps carrying
  // vessel-authoring hints. At least one should be recognized and dispatched.
  const pointer = {
    scenarios_dir: scenariosDir,
    vessel_scenarios_dir: vesselScenariosDir,
    gaps: [
      vesselAuthoringGap("va-gap-a", "test.shape/a"),
      vesselAuthoringGap("va-gap-b", "test.shape/b"),
      vesselAuthoringGap("va-gap-c", "test.shape/c"),
    ],
  } as unknown as mod.GapToScenarioBridgePointer;

  // Act
  const result = await mod.resolveGapToScenarioBridge(pointer);

  // Sanity: the bridge ran to completion and produced its result shape.
  expect(result.shape).toBe("bridgeResult");

  // There must be at least one vessel-authoring dispatch attempt.
  expect(captured.length).toBeGreaterThan(0);

  // Assert — for EACH dispatch, variables MUST include a non-empty goal_text and a non-empty tags array.
  for (const req of captured) {
    expect(req.method).toBe("POST");
    const body = req.body as { variables?: Record<string, unknown> } | undefined;
    expect(body && typeof body === "object").toBe(true);
    const vars = body?.variables as Record<string, unknown> | undefined;
    expect(vars && typeof vars === "object").toBe(true);

    // The fix must populate goal_text (string, non-empty)...
    const goalText = (vars?.["goal_text"]) as unknown;
    expect(typeof goalText).toBe("string");
    expect((goalText as string).length).toBeGreaterThan(0);

    // ...and tags (array, non-empty). Do not assert particular tag values.
    const tags = (vars?.["tags"]) as unknown;
    expect(Array.isArray(tags)).toBe(true);
    expect((tags as unknown[]).length).toBeGreaterThan(0);
  }
});
