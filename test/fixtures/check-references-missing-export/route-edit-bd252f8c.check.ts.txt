import { it, expect } from "bun:test";

// This check must fail on an expect() assertion caused by the defect, not on module load.
// Index initialises an LLM port at import time unless an endpoint is set; provide a dummy
// endpoint to allow a clean import during tests without contacting any service.
process.env.LLM_VESSEL_ENDPOINT = process.env.LLM_VESSEL_ENDPOINT || "http://127.0.0.1:8220";

it("route-edit-bd252f8c: exact procedure must execute via shellResult (lettercount)", async () => {
  // Import the module-under-test as a namespace and call the evidence-named symbol `shellResult`.
  const mod = await import("../../src/index");
  const shell = (mod as unknown as Record<string, unknown>)["shellResult"] as unknown as
    | ((cmd: string) => Promise<{ stdout?: string; stderr?: string; code?: number }>)
    | undefined;

  // Ensure we are asserting behaviour on the exported symbol, not failing for load/shape reasons.
  expect(typeof shell).toBe("function");

  // The defect: when correctness requires an exact procedure, the universal fallback generates a value
  // instead of executing it, despite a shellResult tool being available. Measured wrong outputs included
  // 17 for "incontrovertible" (true count 16). Exercise that path: expect the exact computation result.
  const r1 = await (shell as (cmd: string) => Promise<{ stdout?: string }>)(
    "printf %s 'incontrovertible' | wc -m"
  );
  // Failing assertion due to the defect (current behaviour produces an incorrect generated count).
  expect(String(r1?.stdout ?? "").trim()).toBe("16");
});
