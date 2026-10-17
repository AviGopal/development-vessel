// DECLARED RESOLVER TIERS (user ruling 2026-10-17T10:22:59Z, "Full declared-tier fix"; gap resolvers-do-not-declare-
// their-tier-in-registration-so-tier-is-inferred-from-a-name-list). dev-vessel's registration carries `resolvers[]`
// entries `{ id: shape, tier }` taken from the resolver modules' OWN declarations, for advertised shapes only. Discovery
// echoes each as `resolver_tier` on the shape's capability row; light-dispatch stamps it on the trace task. Measured
// before: llm_completion_dispatch (213 of 12,527 light-dispatched tasks in 24 h) was stamped "deterministic", so the M4
// tier-restricted skip never let it learn.
// MUST-FAIL on the parent (c0eac078): the payload has no `resolvers`, and declaredResolverTiers does not exist.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const reg = await import("../../src/discovery-registration.js");
const SRC = (p: string) => readFileSync(join(import.meta.dir, "..", "..", "src", p), "utf8");

describe("dev-vessel declares its resolvers' tiers in registration", () => {
  it("[MUST-FAIL] llm_completion_dispatch is declared llm in the registration payload", () => {
    const p = reg.buildRegistrationPayload() as { shapes: string[]; resolvers?: Array<{ id: string; tier: string }> };
    expect(p.shapes).toContain("llm_completion_dispatch");
    expect(p.resolvers).toContainEqual({ id: "llm_completion_dispatch", tier: "llm" });
  });

  it("[CONTROL] only advertised shapes are declared, and a shape no module declares is absent (never defaulted)", () => {
    expect((reg as any).declaredResolverTiers(["llm_completion_dispatch"])).toEqual([{ id: "llm_completion_dispatch", tier: "llm" }]);
    expect((reg as any).declaredResolverTiers([])).toEqual([]);
    expect((reg as any).declaredResolverTiers(["resolver_schema"])).toEqual([]);
    const p = reg.buildRegistrationPayload() as { resolvers?: Array<{ id: string }>; shapes: string[] };
    for (const r of p.resolvers ?? []) expect(p.shapes).toContain(r.id);
  });

  it("[WIRING] the declaration lives with the resolver it describes, and registration reads it from there", () => {
    expect(SRC("resolvers/llm-completion-dispatch.ts")).toContain('export const LLM_COMPLETION_DISPATCH_DECLARED_TIERS = { llm_completion_dispatch: "llm" } as const;');
    const r = SRC("discovery-registration.ts");
    expect(r).toContain('import { LLM_COMPLETION_DISPATCH_DECLARED_TIERS } from "./resolvers/llm-completion-dispatch.js";');
    expect(r).toContain("resolvers: declaredResolverTiers(advertised),");
  });
});
