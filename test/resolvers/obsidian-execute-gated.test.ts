import { describe, it, expect, afterEach } from "bun:test";
import { resolveObsidianExecuteGated } from "../../src/resolvers/obsidian-execute-gated.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Fake concept-db priors (used by the inner obsidian_command_gate) + the
// obsidian plugin execute endpoint.
function mock(opts: { priors: Array<{ cmd: string; rev: string }>; execResult?: object }) {
  const concepts = opts.priors.map((p) => ({
    content: JSON.stringify({ command_id: p.cmd, reversibility_class: p.rev, observation_count: 1 }),
  }));
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/concepts/search")) {
      return new Response(JSON.stringify({ concepts }), { status: 200 });
    }
    if (u.includes("/resolve")) {
      return new Response(
        JSON.stringify({ success: true, content: JSON.stringify(opts.execResult ?? { executed: true, changed: true }) }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return calls;
}

describe("obsidian_execute_gated", () => {
  it("executes a learned-reversible command (gate allow → plugin reached)", async () => {
    const calls = mock({ priors: [{ cmd: "editor:save-file", rev: "reversible" }], execResult: { executed: true, changed: false } });
    const r = await resolveObsidianExecuteGated({
      type: "obsidian_execute_gated",
      command_id: "editor:save-file",
      obsidianEndpoint: "http://plugin",
      apiKey: "k",
    });
    const b = r.body as { executed: boolean; gate_verdict: string; effect: { executed: boolean } };
    expect(b.gate_verdict).toBe("allow");
    expect(b.executed).toBe(true);
    expect(b.effect.executed).toBe(true);
    // plugin /resolve WAS called
    expect(calls.some((c) => c.includes("http://plugin/resolve"))).toBe(true);
  });

  it("REFUSES an unobserved command — never reaches the plugin", async () => {
    const calls = mock({ priors: [{ cmd: "editor:save-file", rev: "reversible" }] });
    const r = await resolveObsidianExecuteGated({
      type: "obsidian_execute_gated",
      command_id: "app:delete-file",
      obsidianEndpoint: "http://plugin",
      apiKey: "k",
    });
    const b = r.body as { executed: boolean; refused: boolean; gate_verdict: string };
    expect(b.executed).toBe(false);
    expect(b.refused).toBe(true);
    expect(b.gate_verdict).toBe("deny");
    // plugin execute endpoint NEVER called (only concept-db for the gate)
    expect(calls.some((c) => c.includes("/resolve"))).toBe(false);
  });

  it("REFUSES a hard-irreversible learned command", async () => {
    const calls = mock({ priors: [{ cmd: "plugin:reset", rev: "hard_irreversible" }] });
    const r = await resolveObsidianExecuteGated({
      type: "obsidian_execute_gated",
      command_id: "plugin:reset",
      obsidianEndpoint: "http://plugin",
      apiKey: "k",
    });
    const b = r.body as { executed: boolean; gate_verdict: string };
    expect(b.executed).toBe(false);
    expect(b.gate_verdict).toBe("deny");
    expect(calls.some((c) => c.includes("/resolve"))).toBe(false);
  });

  it("requires command_id", async () => {
    const r = await resolveObsidianExecuteGated({ type: "obsidian_execute_gated", command_id: "", apiKey: "k" });
    expect((r.body as { error?: string }).error).toContain("required");
  });
});
