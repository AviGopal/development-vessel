import { describe, it, expect, afterEach } from "bun:test";
import { resolveObsidianLearnCommands } from "../../src/resolvers/obsidian-learn-commands.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Mock: command_catalog returns `catalog` commands; concept search returns the
 * already-known command_ids; concept_create_write records each persist call.
 */
function mockFetch(catalog: Array<{ id: string; permission_class?: string; reversibility_class?: string }>, known: string[]) {
  const persisted: string[] = [];
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes("/concepts/search")) {
      return new Response(
        JSON.stringify({ concepts: known.map((id) => ({ content: JSON.stringify({ command_id: id }) })) }),
        { status: 200 },
      );
    }
    if (u.endsWith("/resolve") && !u.includes("/v2/impulses/")) {
      // obsidian command_catalog fetch
      return new Response(JSON.stringify({ success: true, content: JSON.stringify({ shape: "obsidian:command_catalog", commands: catalog }) }), { status: 200 });
    }
    if (u.includes("/v2/impulses/resolve")) {
      const body = JSON.parse(init?.body ?? "{}");
      const content = JSON.parse(body?.impulse?.pointer?.conceptData?.content ?? "{}");
      persisted.push(content.command_id);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return persisted;
}

describe("obsidian_learn_commands — catalog mode (default, non-intrusive)", () => {
  it("persists only NEW commands from the catalog (idempotent dedup)", async () => {
    const persisted = mockFetch(
      [
        { id: "backlink:open", permission_class: "navigate", reversibility_class: "reversible" },
        { id: "editor:delete", permission_class: "destructive", reversibility_class: "hard_irreversible" },
        { id: "workspace:next-tab", permission_class: "navigate" },
      ],
      ["backlink:open"], // already known → must be skipped
    );
    const r = await resolveObsidianLearnCommands({ type: "obsidian_learn_commands", apiKey: "k", obsidianEndpoint: "http://h:27183", conceptDbBase: "http://c:8260" });
    const body = r.body as { mode: string; catalog_size: number; already_known: number; learned: number; persisted: number };
    expect(body.mode).toBe("catalog");
    expect(body.catalog_size).toBe(3);
    expect(body.already_known).toBe(1);
    expect(body.learned).toBe(2); // editor:delete + workspace:next-tab (backlink:open skipped)
    expect(body.persisted).toBe(2);
    expect(persisted.sort()).toEqual(["editor:delete", "workspace:next-tab"]);
  });

  it("does NOT execute commands (catalog read only) — second run with all-known persists nothing", async () => {
    const persisted = mockFetch(
      [{ id: "a:one", permission_class: "navigate" }, { id: "b:two", permission_class: "navigate" }],
      ["a:one", "b:two"],
    );
    const r = await resolveObsidianLearnCommands({ type: "obsidian_learn_commands", apiKey: "k" });
    const body = r.body as { learned: number; persisted: number };
    expect(body.learned).toBe(0);
    expect(body.persisted).toBe(0);
    expect(persisted).toEqual([]);
  });

  it("unreachable vessel is a graceful idle, not a hard error", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r = await resolveObsidianLearnCommands({ type: "obsidian_learn_commands", apiKey: "k" });
    const body = r.body as { mode: string; unreachable: boolean; learned: number };
    expect(body.mode).toBe("catalog");
    expect(body.unreachable).toBe(true);
    expect(body.learned).toBe(0);
  });

  it("missing api key degrades cleanly", async () => {
    const r = await resolveObsidianLearnCommands({ type: "obsidian_learn_commands", apiKey: "" });
    expect((r.body as { error: string }).error).toBe("missing_api_key");
  });
});
