import { describe, it, expect, afterEach } from "bun:test";
import { resolveObsidianCommandGate } from "../../src/resolvers/obsidian-command-gate.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockConceptDb(priors: Array<{ cmd: string; rev: string; count?: number }>) {
  const concepts = priors.map((p) => ({
    summary: `obsidian command ${p.cmd} → ${p.rev} (${p.count ?? 1} obs)`,
    content: JSON.stringify({
      command_id: p.cmd,
      reversibility_class: p.rev,
      observation_count: p.count ?? 1,
    }),
  }));
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("/concepts/search")) {
      return new Response(JSON.stringify({ concepts }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("obsidian_command_gate", () => {
  it("returns the learned reversible allow-set when no candidates given", async () => {
    mockConceptDb([
      { cmd: "editor:save-file", rev: "reversible" },
      { cmd: "editor:focus-top", rev: "reversible" },
      { cmd: "app:delete-file", rev: "hard_irreversible" },
    ]);
    const r = await resolveObsidianCommandGate({ type: "obsidian_command_gate", apiKey: "k" });
    const b = r.body as { allowed: string[]; learned_count: number };
    expect(r.shape).toBe("obsidianCommandGateVerdict");
    expect(b.learned_count).toBe(3);
    expect(b.allowed.sort()).toEqual(["editor:focus-top", "editor:save-file"]);
  });

  it("operate mode: allow reversible, deny unobserved + hard-irreversible, escalate soft", async () => {
    mockConceptDb([
      { cmd: "editor:save-file", rev: "reversible" },
      { cmd: "app:delete-file", rev: "hard_irreversible" },
      { cmd: "editor:cut", rev: "soft_irreversible" },
    ]);
    const r = await resolveObsidianCommandGate({
      type: "obsidian_command_gate",
      apiKey: "k",
      command_ids: ["editor:save-file", "app:delete-file", "editor:cut", "some:never-seen"],
    });
    const b = r.body as {
      allowed: string[]; denied: string[]; escalate: string[]; extra_deny_globs: string[];
      command_verdicts: Array<{ command_id: string; verdict: string }>;
    };
    expect(b.allowed).toEqual(["editor:save-file"]);
    expect(b.denied.sort()).toEqual(["app:delete-file", "some:never-seen"]);
    expect(b.escalate).toEqual(["editor:cut"]);
    // everything not auto-allowed feeds the dispatch deny-set
    expect(b.extra_deny_globs.sort()).toEqual(["app:delete-file", "editor:cut", "some:never-seen"]);
    expect(b.command_verdicts.find((v) => v.command_id === "some:never-seen")!.verdict).toBe("deny");
  });

  it("learn mode: unobserved commands are allowed (explore-to-learn)", async () => {
    mockConceptDb([{ cmd: "editor:save-file", rev: "reversible" }]);
    const r = await resolveObsidianCommandGate({
      type: "obsidian_command_gate",
      apiKey: "k",
      mode: "learn",
      command_ids: ["some:never-seen", "editor:save-file"],
    });
    const b = r.body as { allowed: string[]; denied: string[] };
    expect(b.allowed.sort()).toEqual(["editor:save-file", "some:never-seen"]);
    expect(b.denied).toEqual([]);
  });

  it("degrades cleanly when concept-db is unreachable", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const r = await resolveObsidianCommandGate({
      type: "obsidian_command_gate",
      apiKey: "k",
      command_ids: ["editor:save-file"],
    });
    const b = r.body as { error?: string; allowed: string[] };
    expect(b.error).toBeDefined();
    expect(b.allowed).toEqual([]);
  });
});
