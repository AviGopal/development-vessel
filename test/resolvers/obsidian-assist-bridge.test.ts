import { describe, it, expect, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveObsidianAssistBridge } from "../../src/resolvers/obsidian-assist-bridge.js";

const realFetch = globalThis.fetch;
let tmp: string;
afterEach(async () => {
  globalThis.fetch = realFetch;
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

function mockFetch(opts: { hasBehavior: boolean }) {
  const dispatched: string[] = [];
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes("/concepts/search")) {
      return new Response(JSON.stringify({ concepts: opts.hasBehavior ? [{ content: "{}" }] : [] }), { status: 200 });
    }
    if (u.includes("/run-goal")) {
      const body = JSON.parse(init?.body ?? "{}");
      dispatched.push(body?.variables?.pattern_id);
      return new Response(JSON.stringify({ dispatchId: "d1", status: "running" }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return dispatched;
}

describe("obsidian_assist_bridge — autonomous assist authoring", () => {
  it("authors a read-assist when the operator is active (anti-spam on re-run)", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "assist-"));
    const patternsDir = path.join(tmp, "patterns");
    const dispatched = mockFetch({ hasBehavior: true });
    const r1 = await resolveObsidianAssistBridge({ type: "obsidian_assist_bridge", apiKey: "k", patternsDir });
    const b1 = r1.body as { operator_active: boolean; clusters_written: number; authors_dispatched: number };
    expect(b1.operator_active).toBe(true);
    expect(b1.clusters_written).toBe(1);
    expect(b1.authors_dispatched).toBe(1);
    expect(dispatched).toContain("obsidian-assist-active-note");
    // cluster carries the non-intrusive guard rails
    const cluster = JSON.parse(await fs.readFile(path.join(patternsDir, "obsidian-assist-active-note.json"), "utf8")) as { expected_outputs: string[]; topology_hint: string; deny_list: string[] };
    expect(cluster.expected_outputs).toEqual(["obsidianAssistDelivered"]);
    expect(cluster.topology_hint).toContain("Substrate/Assists/");
    expect(cluster.deny_list).toContain("execute_command");
    // re-run: cluster exists → UPSERT but author NOT re-dispatched
    const r2 = await resolveObsidianAssistBridge({ type: "obsidian_assist_bridge", apiKey: "k", patternsDir });
    const b2 = r2.body as { clusters_written: number; authors_dispatched: number };
    expect(b2.clusters_written).toBe(1);
    expect(b2.authors_dispatched).toBe(0);
  });

  it("does NOT develop assists in a vacuum (no operator signal)", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "assist-"));
    mockFetch({ hasBehavior: false });
    const r = await resolveObsidianAssistBridge({ type: "obsidian_assist_bridge", apiKey: "k", patternsDir: path.join(tmp, "patterns") });
    const b = r.body as { operator_active: boolean; authors_dispatched: number };
    expect(b.operator_active).toBe(false);
    expect(b.authors_dispatched).toBe(0);
  });
});
