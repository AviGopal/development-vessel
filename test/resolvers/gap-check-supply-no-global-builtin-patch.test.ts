// THE LEAF-EXPORT SURFACE SHIM REASSIGNED THE PROCESS-WIDE Object.keys (8e54fb68). A mitosis cutover landed on
// src/resolvers/gap-check-supply.ts to satisfy an export-surface narrowness check without moving code: it patched
// the global `Object.keys` so that calling it on this module's own namespace object reports only ["siteRegionSource"],
// tagging the replacement function with a `__gap_check_supply_leaf__` marker. That is a process-wide side effect on a
// JS builtin, triggered merely by importing the module — every other caller of Object.keys anywhere in the process
// pays for one gap's narrowness check. 8e54fb68 is reverted; this guards the regression.
import { describe, expect, it } from "bun:test";

describe("gap-check-supply does not patch the global Object.keys", () => {
  it("MUST-FAIL: importing the module leaves Object.keys unpatched", async () => {
    await import("../../src/resolvers/gap-check-supply.js");
    expect(Object.prototype.hasOwnProperty.call(Object.keys, "__gap_check_supply_leaf__")).toBe(false);
    expect(Object.keys({ a: 1, b: 2 })).toEqual(["a", "b"]);
  });

  it("CONTROL: siteRegionSource is still exported and callable", async () => {
    const supply = (await import("../../src/resolvers/gap-check-supply.js")) as Record<string, unknown>;
    expect(typeof supply.siteRegionSource).toBe("function");
    const siteRegionSource = supply.siteRegionSource as (siteSrc: string, checkSrc: string) => string;
    const out = siteRegionSource("export function foo() { return 1; }", "foo");
    expect(typeof out).toBe("string");
  });
});
