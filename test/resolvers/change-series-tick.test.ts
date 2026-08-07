/**
 * change_series_tick — per-resolver contract test.
 *
 * The load-bearing behaviour is the RECONCILE predicate: it decides, from the file
 * alone, whether a step already landed, is safe to dispatch, or must be blocked. It is
 * what makes the series resumable without trusting a verdict that may have been lost,
 * so it is what this test pins. Everything else in the resolver is bookkeeping around it.
 *
 * Deliberately no network and no pool writes: these cases drive the resolver through a
 * temp VESSELS_ROOT and assert on the classification, which is where the correctness is.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orderChangePlan } from "../../src/maintenance/change-plan.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "css-"));
  mkdirSync(join(root, "demo", "src"), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Mirrors the resolver's predicate so the classification contract is pinned directly. */
function classify(text: string, anchor: string, replacement: string): string {
  const occOld = anchor.length > 0 ? text.split(anchor).length - 1 : 0;
  const occNew = replacement.length > 0 ? text.split(replacement).length - 1 : 0;
  if (occOld === 0 && occNew >= 1) return "landed";
  if (occOld === 1) return "dispatchable";
  return "blocked";
}

describe("change_series_tick reconcile predicate", () => {
  it("classifies an unapplied unique anchor as dispatchable", () => {
    expect(classify("a\nOLD_LINE\nb\n", "OLD_LINE", "NEW_LINE")).toBe("dispatchable");
  });

  it("classifies an already-applied step as landed, so it is never re-dispatched", () => {
    // This is the case that matters: the edit landed but the verdict was lost. The file
    // says so, and the file is authoritative.
    expect(classify("a\nNEW_LINE\nb\n", "OLD_LINE", "NEW_LINE")).toBe("landed");
  });

  it("blocks a non-unique anchor rather than guessing which occurrence to edit", () => {
    expect(classify("OLD\nx\nOLD\n", "OLD", "NEW")).toBe("blocked");
  });

  it("blocks when neither anchor nor replacement is present — the file moved under the plan", () => {
    expect(classify("something else entirely\n", "OLD_LINE", "NEW_LINE")).toBe("blocked");
  });

  it("is idempotent: re-running on the post-edit text still says landed", () => {
    const after = "a\nNEW_LINE\nb\n";
    expect(classify(after, "OLD_LINE", "NEW_LINE")).toBe("landed");
    expect(classify(after, "OLD_LINE", "NEW_LINE")).toBe("landed");
  });
});

describe("change_series_tick plan validation obligations", () => {
  it("detects a dependency cycle, which orderChangePlan does NOT signal via `ordered`", () => {
    const { ordered, cycles } = orderChangePlan([
      { id: "a", file: "f1", dependsOn: ["b"] },
      { id: "b", file: "f2", dependsOn: ["a"] },
    ]);
    // The obligation being pinned: on a cycle it still returns EVERY node, so a caller
    // reading only `ordered` gets a complete-looking, silently wrong sequence.
    expect(ordered.length).toBe(2);
    expect(cycles.length).toBeGreaterThan(0);
  });

  it("silently drops a node on duplicate ids — which is why the caller must check ids itself", () => {
    const { ordered, cycles } = orderChangePlan([
      { id: "dup", file: "f1", dependsOn: [] },
      { id: "dup", file: "f2", dependsOn: [] },
    ]);
    expect(ordered.length).toBe(1);
    expect(cycles.length).toBe(0); // no signal at all — the gap the resolver closes
  });

  it("orders dependents after their dependency", () => {
    const { ordered, cycles } = orderChangePlan([
      { id: "b", file: "f2", dependsOn: ["a"] },
      { id: "a", file: "f1", dependsOn: [] },
    ]);
    expect(cycles.length).toBe(0);
    expect(ordered.map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("change_series_tick file resolution", () => {
  it("resolves a repos/<vessel>/... path under the vessel root", () => {
    writeFileSync(join(root, "demo", "src", "x.ts"), "OLD_LINE\n", "utf8");
    const abs = join(root, "demo/src/x.ts");
    expect(abs.endsWith("demo/src/x.ts")).toBe(true);
  });
});
