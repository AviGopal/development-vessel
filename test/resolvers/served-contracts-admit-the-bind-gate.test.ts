// The walk's bind gate reads THIS vessel's served contracts before it invokes a producer.
//
// goal-host's bindRequiredInputs (src/resolve-pointer.ts) reads each producer's resolver_schema answer at use time.
// For every field marked `required` it either finds the field bound under its own name (under the contract's
// envelope when it has one), synthesizes it when the field declares `synthesize_from` ("goal_and_upstream", or a
// list of the sources "goal" / "upstream"), or REFUSES to invoke the producer ("unbindable required input").
// It has no alias, one-of or alternative-envelope notion. So a served contract that is stricter than its resolver
// stops the walk from making calls the resolver would accept:
//   - llm_completion_dispatch declared `prompt` required with no synthesize_from, so a walk step with no prompt
//     impulse bound was refused instead of getting a prompt made from the goal plus upstream content;
//   - memoryNote_write declared BOTH title and body required, though its resolver needs only a non-empty body
//     (as `body`, its alias `content`, or under the `note` envelope), so body-only note writes were refused.
// GATE_ADMITS below restates the gate's rule (not imported: vessels cannot import each other's source). The
// cases pin the served contracts against that rule. The CONTROLs pin that the resolver's own checks still refuse
// a note with nothing in it, and that the other contracts are served unchanged.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The memory store location is read from WORKSPACE_ROOT; set it before the resolver module loads.
const ORIGINAL_ROOT = process.env["WORKSPACE_ROOT"];
let dir: string;
type Res = { shape: string; body: Record<string, unknown> };
let resolveMemoryNoteWrite: (p: { type: "memoryNote_write"; [k: string]: unknown }) => Promise<Res>;
let resolveResolverSchema: (p: Record<string, unknown>) => Res;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "served-contracts-"));
  process.env["WORKSPACE_ROOT"] = dir;
  ({ resolveMemoryNoteWrite } = (await import("../../src/resolvers/memory-note.js")) as never);
  ({ resolveResolverSchema } = (await import("../../src/resolvers/resolver-schema.js")) as never);
});

afterAll(async () => {
  if (ORIGINAL_ROOT === undefined) delete process.env["WORKSPACE_ROOT"];
  else process.env["WORKSPACE_ROOT"] = ORIGINAL_ROOT;
  await rm(dir, { recursive: true, force: true });
});

type Field = { name: string; required?: boolean; type?: string; synthesize_from?: unknown };
type Served = { shape: string; known: boolean; envelope?: string; fields?: Field[]; required?: string[]; invocation?: string; notes?: string };
const served = (shape: string): Served => resolveResolverSchema({ shape }).body as unknown as Served;

const honourable = (s: unknown): boolean =>
  s === "goal_and_upstream" || (Array.isArray(s) && s.length > 0 && s.every((x) => x === "goal" || x === "upstream"));
const bound = (v: unknown): boolean => v !== undefined && v !== null && !(typeof v === "string" && v.trim().length === 0);

/** The gate's rule: every required field is bound under its own name, or declares a synthesis the walk can honour
 *  (with a goal to make it from). Returns the names it would refuse on. */
function gateRefuses(c: Served, pointer: Record<string, unknown>, goal: string): string[] {
  if (c.known !== true || !Array.isArray(c.fields)) return [];
  const holder = c.envelope ? ((pointer[c.envelope] ?? {}) as Record<string, unknown>) : pointer;
  return c.fields
    .filter((f) => f.required === true)
    .filter((f) => !bound(holder[f.name]) && !(honourable(f.synthesize_from) && goal.trim().length > 0))
    .map((f) => f.name);
}

describe("MUST-FAIL: llm_completion_dispatch's served prompt is synthesizable, so a prompt-less walk call is bound, not refused", () => {
  it("the served `prompt` field is required and declares synthesize_from \"goal_and_upstream\" (flat pointer)", () => {
    const c = served("llm_completion_dispatch");
    expect(c.known).toBe(true);
    expect(c.envelope).toBeUndefined();
    const prompt = (c.fields ?? []).find((f) => f.name === "prompt");
    expect(prompt?.required).toBe(true);
    expect(prompt?.synthesize_from).toBe("goal_and_upstream");
  });

  it("the gate's rule admits a prompt-less pointer when there is a goal, and still refuses it with none", () => {
    const c = served("llm_completion_dispatch");
    expect(gateRefuses(c, { type: "llm_completion_dispatch" }, "Summarize the last three landed commits")).toEqual([]);
    expect(gateRefuses(c, { type: "llm_completion_dispatch" }, "")).toEqual(["prompt"]);
  });
});

describe("MUST-FAIL: memoryNote_write's served contract no longer requires both title and body", () => {
  it("neither title nor body is served as required", () => {
    const c = served("memoryNote_write");
    expect(c.known).toBe(true);
    const req = new Set(c.required ?? []);
    expect(req.has("title") && req.has("body")).toBe(false);
    expect(c.required).toEqual([]);
    for (const f of c.fields ?? []) expect(f.required).toBe(false);
  });

  it("the gate's rule admits every form the resolver accepts: body-only, content-only, and the note envelope", () => {
    const c = served("memoryNote_write");
    for (const p of [
      { type: "memoryNote_write", body: "397020" },
      { type: "memoryNote_write", title: "a-named-note", content: "the finding text" },
      { type: "memoryNote_write", note: { id: "n1", title: "n1", body: "enveloped" } },
    ]) expect(gateRefuses(c, p, "store the answer in a memory note")).toEqual([]);
  });

  it("the served notes state the real requirement (a non-empty body; title optional), not 'title or body suffices'", () => {
    const n = served("memoryNote_write").notes ?? "";
    expect(n).not.toContain("title or body suffices");
    expect(n).toMatch(/body/);
    expect(n).toMatch(/title. is optional|title is optional/);
  });
});

describe("CONTROL: the memoryNote_write resolver still refuses a note with nothing in it", () => {
  it("neither title nor body: rejected", async () => {
    const r = await resolveMemoryNoteWrite({ type: "memoryNote_write" });
    expect(r.body.action).toBe("rejected");
    expect(String(r.body.reason)).toContain("requires at least a title or a body");
  });

  it("title only (no body): rejected, a titled shell is not a note", async () => {
    const r = await resolveMemoryNoteWrite({ type: "memoryNote_write", title: "only-a-title" });
    expect(r.body.action).toBe("rejected");
    expect(String(r.body.reason)).toContain("empty body");
  });

  it("body only: created", async () => {
    const r = await resolveMemoryNoteWrite({ type: "memoryNote_write", body: "body-only note content" });
    expect(r.body.action).toBe("created");
  });
});

describe("CONTROL: the other served contracts are unchanged", () => {
  it("substrateGap_write: gap envelope, the same six required fields, no synthesize_from", () => {
    const c = served("substrateGap_write");
    expect(c.envelope).toBe("gap");
    expect(c.required).toEqual(["id", "category", "source", "status", "detected_at", "summary"]);
    expect((c.fields ?? []).map((f) => f.name)).toEqual(["id", "category", "source", "status", "detected_at", "summary", "route", "remedy", "classification_metadata"]);
    for (const f of c.fields ?? []) expect(f.synthesize_from).toBeUndefined();
  });

  it("test_suite: flat, vessel the only required field, no synthesize_from", () => {
    const c = served("test_suite");
    expect(c.envelope).toBeUndefined();
    expect(c.required).toEqual(["vessel"]);
    expect((c.fields ?? []).map((f) => f.name)).toEqual(["vessel", "landed_sha", "gap_id", "proposal_id", "timeout_ms"]);
    for (const f of c.fields ?? []) expect(f.synthesize_from).toBeUndefined();
  });

  it("git_log: every field optional, empty invocation", () => {
    const c = served("git_log");
    expect(c.required).toEqual([]);
    expect(c.invocation).toBe('pointer:{type:"git_log"}');
    expect((c.fields ?? []).map((f) => f.name)).toEqual(["repo", "cwd", "limit", "format", "since"]);
  });

  it("llm_completion_dispatch: only prompt is required; the optional fields are unchanged and declare no synthesis", () => {
    const c = served("llm_completion_dispatch");
    expect(c.required).toEqual(["prompt"]);
    expect((c.fields ?? []).map((f) => [f.name, f.required])).toEqual([["prompt", true], ["system_prompt", false], ["model", false], ["max_tokens", false], ["tools", false]]);
    for (const f of (c.fields ?? []).filter((x) => x.name !== "prompt")) expect(f.synthesize_from).toBeUndefined();
  });

  it("an unknown shape still answers known:false", () => {
    expect(served("definitely_not_a_shape").known).toBe(false);
  });
});
