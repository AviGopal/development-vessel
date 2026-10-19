// dispatch_goal IS GATED LIKE A WRITE (operator security review, 2026-10-19).
//
// Measured: dispatch_goal is neither a `*_write` nor a mutating primitive, so the resolve route's write gate
// let it through unauthenticated, and the resolver forwards the goal to goal-host /run-goal with this
// vessel's own fleet key. Any caller that could reach the published port started a walk as this vessel,
// an edit-intent goal included: a confused deputy in front of goal-host's own gate.
//
// CONTRACT pinned here:
//   - dispatch_goal without a credential identity authenticates is refused 401 at both doors, and
//     nothing reaches goal-host (no /run-goal request is made at all).
//   - A forged key is refused the same way.
//   - Control: with a key identity authenticates, the dispatch reaches goal-host /run-goal.
// SEAMS: identity and goal-host are stood in for by globalThis.fetch; any other network call fails the test.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

const { impulsesRouter } = await import(`../../src/routes/impulses.js?${"dispatch-goal-gate-isolated"}`);
const { isWritePointerType } = await import("../../src/lib/caller-credential.js");

// A loopback literal: the credential module sends keys over plain http only to private hosts.
const IDENTITY = "http://127.0.0.1:59131";
const VALID_KEY = "dispatch-goal-gate-valid-key-fixture";
const FORGED_KEY = "dispatch-goal-gate-forged-key-fixture";

const originalFetch = globalThis.fetch;
let runGoalCalls: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = [];
let violations: string[] = [];
const spies: Array<ReturnType<typeof spyOn>> = [];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["IDENTITY_VESSEL_URL", "METABOB_API_KEY"]) saved[k] = process.env[k];
  process.env["IDENTITY_VESSEL_URL"] = IDENTITY;
  delete process.env["METABOB_API_KEY"];
  runGoalCalls = [];
  violations = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const u = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = (() => { try { return JSON.parse(String(init?.body ?? "{}")); } catch { return {}; } })();
    if (u === `${IDENTITY}/v1/auth/resolve`) {
      if (body?.impulse?.pointer?.apiKey === VALID_KEY) {
        return Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", keyId: "k", scopes: ["read", "write"] } });
      }
      return Response.json({ success: false, error: "invalid" }, { status: 401 });
    }
    if (u.endsWith("/run-goal")) {
      const h = new Headers(init?.headers as HeadersInit | undefined);
      runGoalCalls.push({ url: u, authorization: h.get("authorization"), body });
      return Response.json({ dispatchId: "dispatch-goal-gate-fixture", status: "running" }, { status: 202 });
    }
    violations.push(u);
    throw new TypeError("unexpected network call in test: " + u);
  }) as unknown as typeof fetch;
  for (const m of ["log", "warn", "info"] as const) spies.push(spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  while (spies.length) spies.pop()!.mockRestore();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  expect(violations).toEqual([]);
});

const pointer = { type: "dispatch_goal", goal: "dispatch-goal gate fixture goal", target_template_id: "fixture:template" };
const viaResolve = (auth?: string) => impulsesRouter.request("/v2/impulses/resolve", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
  body: JSON.stringify({ impulse: { pointer } }),
});
const viaExecute = (auth?: string) => impulsesRouter.request("/resolvers/execute", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
  body: JSON.stringify({ resolver: "dispatch_goal", config: pointer }),
});

describe("dispatch_goal is gated like a write", () => {
  it("dispatch-goal-gate dispatch_goal is a write-type pointer", () => {
    expect(isWritePointerType("dispatch_goal")).toBe(true);
  });

  it("dispatch-goal-gate an unkeyed dispatch_goal is refused 401 at the resolve door and no walk starts", async () => {
    const r = await viaResolve();
    expect(r.status).toBe(401);
    expect(await r.text()).toContain("caller_credential_required: dispatch_goal");
    expect(runGoalCalls).toEqual([]);
  });

  it("dispatch-goal-gate an unkeyed dispatch_goal is refused 401 at the execute door and no walk starts", async () => {
    const r = await viaExecute();
    expect(r.status).toBe(401);
    expect(runGoalCalls).toEqual([]);
  });

  it("dispatch-goal-gate a forged key is refused 401 and no walk starts", async () => {
    expect((await viaResolve(`ApiKey ${FORGED_KEY}`)).status).toBe(401);
    expect((await viaExecute(`ApiKey ${FORGED_KEY}`)).status).toBe(401);
    expect(runGoalCalls).toEqual([]);
  });

  it("dispatch-goal-gate control: an authenticated dispatch_goal reaches goal-host /run-goal", async () => {
    const r = await viaResolve(`ApiKey ${VALID_KEY}`);
    expect(r.status).toBe(200);
    expect(runGoalCalls.length).toBe(1);
    expect(runGoalCalls[0]!.body["goal"]).toBe(pointer.goal);
  });
});
