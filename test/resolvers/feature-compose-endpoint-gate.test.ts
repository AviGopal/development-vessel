import { describe, it, expect } from "bun:test";
import { unresolvableImpulseEndpointRefusal } from "../../src/resolvers/feature-compose.js";

// Pins the IMPULSE-ENDPOINT RESOLVE GATE (2026-09-02).
//
// MEASURED TWICE, on the same task, by the substrate itself.
//
// Attempt 1 (776391aa0fc2): emitted a substrateGap via `exports.substrateGap.emit(...)`
// — an invented API, undefined in an ESM vessel. Refused going forward by the
// CJS-in-ESM gate.
//
// Attempt 2 (62e66a7), dispatched to REPAIR attempt 1 with the gap, the gate and a
// teaching refusal all in place: it correctly removed the dead call and wrote a real
// fetch — to `${ACTIVITY_API_ENDPOINT}/v2/impulses/substrateGap`, which is a 404. The
// CJS gate did not fire (correctly — this is not CJS), so the refusal→redraft loop never
// engaged and a second inert emitter landed and pushed.
//
// AUTHORITY, and it is unusually strong: across activity-api and development-vessel
// exactly ONE impulse endpoint literal exists — "/v2/impulses/resolve" — and all 38
// impulse callers in goal-host-vessel/src/index.ts use it. Verified live with a control,
// because a bare 404 here is ambiguous:
//     POST /v2/impulses/resolve + a served shape  -> 200
//     POST /v2/impulses/substrateGap              -> 404 "Not found"
// A 404 from /resolve means SHAPE-NOT-SERVED, not endpoint-missing. Probe with a
// known-good shape before ever concluding an endpoint is absent.
//
// SCOPE — the same discipline as the two sibling gates: RESOLVE, never read, and refuse
// only what cannot work. A literal `/v2/impulses/<segment>` where segment is not
// `resolve` addresses no route in the fleet. Interpolated segments (`${...}`) are NOT
// judged — they cannot be resolved statically, so the gate abstains rather than guess.

const ATTEMPT_2 = [
  "### repos/goal-host-vessel/src/index.ts",
  "+          await fetch(`${ACTIVITY_API_ENDPOINT}/v2/impulses/substrateGap`, {",
  "+            method: \"POST\",",
  "+            body: JSON.stringify({ id: \"x\", category: \"extraction_eligibility\" }),",
  "+          });",
].join("\n");

const CORRECT = [
  "### repos/goal-host-vessel/src/index.ts",
  "+    const r = await fetch(`${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`, {",
  "+      method: \"POST\",",
  "+      body: JSON.stringify({ impulse: { type: \"substrateGap_write\", pointer: { type: \"substrateGap_write\", gap } } }),",
  "+    });",
].join("\n");

// Must abstain: the segment is interpolated and cannot be resolved statically.
const INTERPOLATED = ["### x.ts", "+  await fetch(`${EP}/v2/impulses/${kind}`, { method: \"POST\" });"].join("\n");
// Must ignore: not an impulse route at all.
const OTHER_ROUTE = ["### x.ts", "+  await fetch(`${EP}/v2/activities/execution-traces?limit=10`);"].join("\n");
// Must ignore: removal is the repair.
const REMOVAL = ["### x.ts", "-  await fetch(`${EP}/v2/impulses/substrateGap`, { method: \"POST\" });", "+  await fetch(`${EP}/v2/impulses/resolve`, { method: \"POST\" });"].join("\n");
// Must ignore: a diff header naming a file, not code.
const HEADER = ["### x.ts", "+++ b/src/v2/impulses/substrateGap.ts", "+const n = 1;"].join("\n");

describe("unresolvableImpulseEndpointRefusal — the route resolve gate", () => {
  it("REFUSES the endpoint the substrate invented in 62e66a7", () => {
    const r = unresolvableImpulseEndpointRefusal(ATTEMPT_2);
    expect(r).not.toBeNull();
    expect(r).toContain("substrateGap");
    expect(r).toContain("/v2/impulses/resolve");
  });

  it("ALLOWS the correct endpoint — the load-bearing false-positive case", () => {
    expect(unresolvableImpulseEndpointRefusal(CORRECT)).toBeNull();
  });

  it("ABSTAINS on an interpolated segment it cannot resolve", () => {
    expect(unresolvableImpulseEndpointRefusal(INTERPOLATED)).toBeNull();
  });

  it("ignores non-impulse routes", () => {
    expect(unresolvableImpulseEndpointRefusal(OTHER_ROUTE)).toBeNull();
  });

  it("ignores removals and diff headers", () => {
    expect(unresolvableImpulseEndpointRefusal(REMOVAL)).toBeNull();
    expect(unresolvableImpulseEndpointRefusal(HEADER)).toBeNull();
  });

  it("fails open on empty or non-diff input", () => {
    expect(unresolvableImpulseEndpointRefusal("")).toBeNull();
    expect(unresolvableImpulseEndpointRefusal("nothing here")).toBeNull();
  });
});
