import { describe, it, expect, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveObsidianReflect } from "../../src/resolvers/obsidian-reflect.js";

const realFetch = globalThis.fetch;
let tmp: string;
afterEach(async () => {
  globalThis.fetch = realFetch;
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

function mockConcepts(behavior: any[], surface: any[]) {
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    if (u.includes("shape=obsidian_behavior")) {
      return new Response(JSON.stringify({ concepts: behavior.map((m) => ({ content: JSON.stringify(m), summary: "s" })) }), { status: 200 });
    }
    if (u.includes("shape=obsidian_action_effect")) {
      return new Response(JSON.stringify({ concepts: surface.map((s) => ({ content: JSON.stringify(s) })) }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("obsidian_reflect — respond half (render learned model to board)", () => {
  it("writes a board page summarizing the operator model + command surface", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "refl-"));
    const renderPath = path.join(tmp, "Workflow.md");
    mockConcepts(
      [
        { current_kind: "active-leaf-change", expected_next_kind: "active-leaf-change", consistency: 0.64, samples: 47 },
        { current_kind: "layout-change", expected_next_kind: "active-leaf-change", consistency: 0.8, samples: 20 },
      ],
      Array.from({ length: 204 }, (_, i) => ({ command_id: `c${i}` })),
    );
    const r = await resolveObsidianReflect({ type: "obsidian_reflect", apiKey: "k", renderPath, writeToVault: false });
    const body = r.body as { wrote: boolean; behavioural_models: number; command_surface: number; top_expectation: string };
    expect(body.wrote).toBe(true);
    expect(body.behavioural_models).toBe(2);
    expect(body.command_surface).toBe(204);
    // strongest (consistency*samples) first → layout-change (0.8*20=16) vs active-leaf (0.64*47=30) → active-leaf wins
    expect(body.top_expectation).toBe("active-leaf-change→active-leaf-change");
    const written = await fs.readFile(renderPath, "utf8");
    expect(written).toContain("substrate_board: workflow");
    expect(written).toContain("204 commands");
    expect(written).toContain("active-leaf-change");
  });

  it("renders a 'still watching' board when no operator model yet", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "refl-"));
    const renderPath = path.join(tmp, "Workflow.md");
    mockConcepts([], []);
    const r = await resolveObsidianReflect({ type: "obsidian_reflect", apiKey: "k", renderPath, writeToVault: false });
    const body = r.body as { wrote: boolean; behavioural_models: number };
    expect(body.wrote).toBe(true);
    expect(body.behavioural_models).toBe(0);
    expect(await fs.readFile(renderPath, "utf8")).toContain("still watching");
  });
});
