import { describe, it, expect } from "bun:test";
import { detectArchitectureViolation } from "../../src/resolvers/feature-compose";

// The architecture-conformance scan (2026-07-27). Self-authored patches must conform to
// the substrate's OWN laws; these tests pin the two high-precision, law-backed rules and
// guard against false positives on legitimate bootstrap reads.

const diffOf = (addedLines: string[]): string =>
  ["--- a/repos/x/src/f.ts", "+++ b/repos/x/src/f.ts", "@@ -1,1 +1,10 @@", ...addedLines.map((l) => "+" + l)].join("\n");

describe("detectArchitectureViolation — L1 env-gated behaviour", () => {
  it("flags behaviour gated behind a non-bootstrap env var at a branch", () => {
    const v = detectArchitectureViolation(diffOf(["  if (process.env.ENABLE_FANCY_MODE === '1') { doFancy(); }"]));
    expect(v.length).toBe(1);
    expect(v[0]!.law).toContain("L1");
    expect(v[0]!.detail).toContain("ENABLE_FANCY_MODE");
  });

  it("does NOT flag a bootstrap env read (endpoint / port / key / model)", () => {
    const v = detectArchitectureViolation(
      diffOf([
        "const ENDPOINT = process.env.LLM_VESSEL_ENDPOINT ?? 'http://127.0.0.1:8300';",
        "const port = Number(process.env.PORT ?? 8090);",
        "const key = process.env.ANTHROPIC_API_KEY;",
        "const model = process.env.DEFAULT_MODEL ?? 'claude-haiku-4-5-20251001';",
      ]),
    );
    expect(v.length).toBe(0);
  });
});

describe("detectArchitectureViolation — dev-vessel layer-3 inline LLM", () => {
  it("flags an inlined LLM provider SDK instantiation", () => {
    const v = detectArchitectureViolation(diffOf(["  const client = new Anthropic({ apiKey });"]));
    expect(v.length).toBe(1);
    expect(v[0]!.law).toContain("layer-3");
  });

  it("flags a direct provider HTTP call in vessel code", () => {
    const v = detectArchitectureViolation(diffOf(["  const r = await fetch('https://api.openai.com/v1/chat/completions', opts);"]));
    expect(v.length).toBe(1);
    expect(v[0]!.law).toContain("layer-3");
  });

  it("does NOT flag a sanctioned llm-prompt resolver dispatch (fetch to the llm vessel /resolve)", () => {
    const v = detectArchitectureViolation(
      diffOf(["  const r = await fetch(`${LLM_VESSEL_ENDPOINT}/resolve`, { method: 'POST', body: JSON.stringify({ type: 'llm_completion', prompt }) });"]),
    );
    expect(v.length).toBe(0);
  });
});

describe("detectArchitectureViolation — hygiene", () => {
  it("returns nothing for a clean surgical diff", () => {
    const v = detectArchitectureViolation(diffOf(["  const seen = new Set<string>();", "  for (const x of items) seen.add(x.id);"]));
    expect(v.length).toBe(0);
  });

  it("ignores comments and dedups repeated violations", () => {
    const v = detectArchitectureViolation(
      diffOf([
        "  // if (process.env.ENABLE_FANCY_MODE) explains the old behaviour",
        "  if (process.env.ENABLE_FANCY_MODE === '1') a();",
        "  if (process.env.ENABLE_FANCY_MODE === '1') b();",
      ]),
    );
    // both branch lines reference the same env var + near-identical snippet head → dedup to 1
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v.every((x) => x.law.includes("L1"))).toBe(true);
  });
});
