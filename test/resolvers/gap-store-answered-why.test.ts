// A GAP-STORE READ THAT IS NOT A substrateGap ANSWER IS REPORTED WITH THE HOLDER'S OWN DETAIL (CHANGE-30b).
//
// forwardToGapStore (substrate-gap.ts) turns every failed forward into a structuredError whose body.detail says
// which way it failed: "gap store at <ep> answered HTTP 401" vs "… unreachable: The operation timed out" vs
// "… unreachable: The socket connection was closed unexpectedly". The cutover's landing-lease gate and the own-check
// load logged only the shape, so on a spoke every one of those read "gap store answered structuredError".
//
//   [MUST-FAIL] loadOwnCheck on a structuredError read reports the detail text.
//   [CONTROL]   an answer with no detail still reads as before (shape only); an empty read reads "nothing".
import { describe, expect, it } from "bun:test";

const gate = (await import("../../src/resolvers/staged-mitosis-gate.js")) as Record<string, any>;

describe("a failed gap-store read carries the holder's detail", () => {
  it("[MUST-FAIL] loadOwnCheck reports the structuredError's detail text", async () => {
    const load = await gate.loadOwnCheck("development-vessel", "gap-x", async () => ({ shape: "structuredError", body: { detail: "gap store at <ep> unreachable: The operation timed out." } }));
    expect(load.status).toBe("unreadable");
    expect(String(load.why)).toContain("The operation timed out");
    expect(String(load.why)).toContain("gap store answered structuredError");
  });

  it("[CONTROL] with no detail the reason is the shape alone; an empty read is 'nothing'", async () => {
    const a = await gate.loadOwnCheck("development-vessel", "gap-x", async () => ({ shape: "structuredError", body: {} }));
    expect(a.why).toBe("gap store answered structuredError");
    const b = await gate.loadOwnCheck("development-vessel", "gap-x", async () => null);
    expect(b.why).toBe("gap store answered nothing");
  });
});
