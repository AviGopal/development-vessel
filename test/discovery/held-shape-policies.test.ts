// HELD SHAPES ARE ADVERTISED AS HELD (discovery held-shape-routing; user ruling 2026-10-17T04:47:53Z). dev-vessel's
// registration carries per-shape stateful_data_owner_pin + holder for the shapes whose data it holds, DERIVED from the
// store modules' own declarations; every other shape stays as before (no row-level pin). The one NODE-DISTINCT shape,
// composeOwnership (each node answers from its own capacity, scope and store; compose-placement.ts), is declared
// stateful_data_owner_merge, so discovery lists a same-host peer node's row of it beside this node's own.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const reg = await import("../../src/discovery-registration.js");
const gap = await import("../../src/resolvers/substrate-gap.js");
const mem = await import("../../src/resolvers/memory-note.js");
const lc = await import("../../src/judge/learning-credit.js");
const SRC = (p: string) => readFileSync(join(import.meta.dir, "..", "..", "src", p), "utf8");

describe("held shapes are advertised as held", () => {
  it("[MUST-FAIL] the gap-store and memory-store shapes advertise the owner pin with a holder", () => {
    const p = reg.buildRegistrationPayload() as { shape_policies?: Record<string, { distribution_policy: string; holder: string }>; shapes: string[] };
    for (const s of ["substrateGap", "substrateGap_write", "memoryNote", "memoryNote_write"]) {
      expect(p.shapes).toContain(s);
      expect(p.shape_policies?.[s]?.distribution_policy).toBe("stateful_data_owner_pin");
      expect(p.shape_policies?.[s]?.holder).toBeTruthy();
    }
  });
  it("[CONTROL] a shape dev-vessel serves without holding data carries NO pin, and there is no row-level pin", () => {
    const p = reg.buildRegistrationPayload() as { shape_policies?: Record<string, unknown>; distribution_policy?: unknown; shapes: string[] };
    const unpinned = p.shapes.filter((s) => !p.shape_policies?.[s]);
    expect(unpinned.length).toBeGreaterThan(100);
    expect(unpinned).toContain("resolver_schema");
    expect(p.distribution_policy).toBeUndefined();
  });
  it("[MUST-FAIL] composeOwnership alone is declared node-distinct (stateful_data_owner_merge, no holder); no other shape changes", async () => {
    const placement = await import("../../src/resolvers/compose-placement.js");
    const p = reg.buildRegistrationPayload() as { shape_policies?: Record<string, { distribution_policy: string; holder?: string }>; shapes: string[] };
    expect(p.shapes).toContain("composeOwnership");
    expect(p.shape_policies?.["composeOwnership"]).toEqual({ distribution_policy: "stateful_data_owner_merge" });
    expect([...placement.NODE_DISTINCT_SHAPES]).toEqual(["composeOwnership"]);
    // every other entry is exactly the store modules' pins, as before
    const others = Object.entries(p.shape_policies ?? {}).filter(([s]) => s !== "composeOwnership");
    expect(others.every(([, v]) => v.distribution_policy === "stateful_data_owner_pin" && !!v.holder)).toBe(true);
    const held = new Set<string>([...gap.GAP_STORE_HELD_SHAPES, ...mem.MEMORY_NOTE_HELD_SHAPES, ...lc.LEARNING_CREDIT_HELD_SHAPES]);
    expect(others.map(([s]) => s).sort()).toEqual(p.shapes.filter((s) => held.has(s)).sort());
  });
  it("[UNIT] the holder names the store: this node's gap store on the holder, the designated holder on a non-holder", () => {
    const saved = process.env["GAP_STORE_ENDPOINT"];
    try {
      delete process.env["GAP_STORE_ENDPOINT"];
      expect(reg.heldShapePolicies(["substrateGap"])["substrateGap"]!.holder).toMatch(/^gap-store@(?!designated)/);
      process.env["GAP_STORE_ENDPOINT"] = "http://holder.test/v2/impulses/resolve";
      expect(reg.heldShapePolicies(["substrateGap"])["substrateGap"]!.holder).toBe("gap-store@designated-holder");
      expect(reg.heldShapePolicies(["memoryNote"])["memoryNote"]!.holder).toMatch(/^memory-store@/);
    } finally { if (saved === undefined) delete process.env["GAP_STORE_ENDPOINT"]; else process.env["GAP_STORE_ENDPOINT"] = saved; }
  });
  it("[DERIVED] every dispatch case that returns a resolver from a store module is in that module's declared held set", () => {
    const route = SRC("routes/impulses.ts");
    const held = new Set<string>([...gap.GAP_STORE_HELD_SHAPES, ...mem.MEMORY_NOTE_HELD_SHAPES, ...lc.LEARNING_CREDIT_HELD_SHAPES]);
    const storeResolvers = /resolve(SubstrateGap|SubstrateGapWrite|SubstrateGapLease|MemoryNote|MemoryNoteWrite|GapLearningCreditWrite)\(/;
    const cases = [...route.matchAll(/case "([A-Za-z_]+)":([\s\S]*?)(?=\n\s*case "|\n\s*default:)/g)];
    const offenders = cases.filter(([, , body]) => storeResolvers.test(body!.slice(0, 600))).map(([, shape]) => shape!).filter((s) => !held.has(s));
    expect(offenders).toEqual([]);
    expect(cases.length).toBeGreaterThan(100);
  });
});
