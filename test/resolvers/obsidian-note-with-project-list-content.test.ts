import { describe, it, expect, afterEach } from "bun:test";
import { resolveObsidianNoteWithProjectListContent } from "../../src/resolvers/obsidian-note-with-project-list-content.js";

// HERMETIC. This called the resolver with no fetch stub, and the resolver makes three live calls
// with 20s timeouts each against bun's 5s test timeout — so it failed as a timeout under load.
// Its assertions were `typeof r.shape === "string"` and `has body`, which EVERY possible return
// value satisfies, including the catch-all error body. The test could not distinguish a report
// from a failure, which is the one distinction worth making for a resolver that swallows its
// exceptions into `{ error }`.

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const SHAPE = "obsidian:note with project list content";

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("obsidian_note_with_project_list_content resolver", () => {
  it("returns a report body (not an error body) when its sources answer", async () => {
    globalThis.fetch = (async () => json({ executions: [], gaps: [], body: { gaps: [] } })) as unknown as typeof fetch;
    const r = await resolveObsidianNoteWithProjectListContent({
      type: "obsidian_note_with_project_list_content",
    });
    expect(r.shape).toBe(SHAPE);
    const body = r.body as Record<string, unknown>;
    // the distinction the old assertions could not make
    expect(body["error"]).toBeUndefined();
    // a fully-answered run carries NO degradation marker — absence is the healthy signal
    expect(body["degraded"]).toBeUndefined();
    expect(body).toHaveProperty("projects");
    expect(body).toHaveProperty("compositionEdges");
    expect(body).toHaveProperty("openGapShapes");
  });

  it("still emits its shape, with the failure named in the body, when a source throws", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r = await resolveObsidianNoteWithProjectListContent({
      type: "obsidian_note_with_project_list_content",
    });
    // Shape stability on the failure path is the contract: a consumer binding this shape must
    // not have to handle a thrown exception, but must be able to SEE that it degraded.
    expect(r.shape).toBe(SHAPE);
    const body = r.body as Record<string, any>;
    expect(body["degraded"]).toBe(true);
    // named per source, so a partial outage is distinguishable from a total one
    expect(Object.keys(body["source_errors"]).sort()).toEqual(["compositionGraph", "substrateGaps", "templates"]);
    expect(String(body["source_errors"]["templates"])).toContain("ECONNREFUSED");
  });
});
