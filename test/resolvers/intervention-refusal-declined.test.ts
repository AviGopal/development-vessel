// A REFUSED INTERVENTION IS A DECLINED OUTCOME (REALIGNMENT §2.2: reached / failed / DECLINED).
//
// intervention_evaluate wrote a REFUSE only to a local refusals.json, with no outcome and no intervener principal,
// so the trace store never learned a refusal happened. A REFUSE now also writes a declined record to the trace
// store through the contract goal-host's walk trace uses and activity-api's isReachInapplicable reads: the tag
// declined:<class> and metadata.decline {class, reason_text, decliner_id}, with the intervener principal beside it.
//   MUST-FAIL: a REFUSE posts that record with its class and the intervener principal (red before the fix: no POST).
//   CONTROL: an ACCEPT posts nothing to the trace store.
// The trace store, concept-db and identity are stood in for by globalThis.fetch; the refusal file is a temp root.
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInterventionEvaluate } from "../../src/resolvers/intervention-evaluate.js";

// A query-string instance of the route module (test/observers/topology-chain.test.ts replaces routes/impulses.js
// process-wide with a stub; see intervention-refused-write-principal.test.ts).
const { impulsesRouter } = await import(`../../src/routes/impulses.js?${"intervention-refusal-declined"}`);

const IDENTITY = "http://127.0.0.1:59108";
const KEY_A = "key-a-declined-fixture";
const KEY_B = "key-b-declined-fixture";

type Posted = { url: string; body: Record<string, any> };
let posted: Posted[] = [];
let tmpRoot = "";
const originalFetch = globalThis.fetch;
const savedRoot = process.env["WORKSPACE_ROOT"];
let warnSpy: ReturnType<typeof spyOn> | null = null;

/** concept-db answers `concepts`, a GET of the trace list answers one success row, a POST to it is captured. */
function install(concepts: Array<{ id: string; name?: string }>): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    if (url === `${IDENTITY}/v1/auth/resolve`) {
      const key = JSON.parse(String(init?.body ?? "{}"))?.impulse?.pointer?.apiKey;
      if (key === KEY_A) return Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", keyId: "ka", scopes: ["read", "write"] } });
      if (key === KEY_B) return Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", keyId: "kb", scopes: ["read", "write"] } });
      return Response.json({ success: false, error: "invalid" }, { status: 401 });
    }
    if (url.includes("/concepts/search")) return Response.json({ concepts });
    if (url.includes("/execution-traces")) {
      if ((init?.method ?? "GET").toUpperCase() === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        posted.push({ url, body });
        return Response.json({ success: true, execution_id: body.execution_id });
      }
      return Response.json({ traces: [{ execution_id: "exec_ok", status: "success" }] });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

// The neighbour's proven REFUSE recipe: a removal verb, a concept whose name overlaps the target path, no citation.
const REFUSE_CHANGE = {
  target_path: "repos/metabob-activity-api/src/routes/activities.ts",
  diff_summary: "delete activities route entirely",
  source: "operator" as const,
  intent: "cleanup",
};
const REFUSE_CONCEPTS = [{ id: "concept_abc", name: "activities core path" }];

beforeEach(() => {
  posted = [];
  tmpRoot = mkdtempSync(join(tmpdir(), "intervention-refusal-declined-"));
  process.env["WORKSPACE_ROOT"] = tmpRoot;
  process.env["IDENTITY_VESSEL_URL"] = IDENTITY;
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env["IDENTITY_VESSEL_URL"];
  if (savedRoot === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = savedRoot;
  warnSpy?.mockRestore();
  rmSync(tmpRoot, { recursive: true, force: true });
});
afterAll(() => { globalThis.fetch = originalFetch; });

const declinedPosts = () => posted.filter((p) => Array.isArray(p.body.tags) && p.body.tags.some((t: unknown) => String(t).startsWith("declined:")));

describe("intervention_evaluate: a REFUSE is a declined outcome in the trace store", () => {
  it("MUST-FAIL: a REFUSE posts declined:<class> with metadata.decline and the intervener principal", async () => {
    install(REFUSE_CONCEPTS);
    const result = await resolveInterventionEvaluate(
      { type: "intervention_evaluate", proposed_change: REFUSE_CHANGE, cited_evidence: [], strictness: "balanced", conceptDbUrl: "http://concept", tracesUrl: "http://traces/v2/activities/execution-traces?limit=10" },
      { intervener: "key_id:ka" },
    );
    const body = result.body as Record<string, unknown>;
    expect(body.verdict).toBe("REFUSE");

    const decl = declinedPosts();
    expect(decl.length).toBe(1);
    const rec = decl[0]!.body;
    expect(rec.tags).toEqual(["declined:contradicts_priors_without_evidence"]);
    expect(rec.template_id).toBe("intervention_evaluate");
    expect(rec.success).toBe(false);
    expect(rec.metadata.decline).toEqual({
      class: "contradicts_priors_without_evidence",
      reason_text: String(body.refusal_basis),
      decliner_id: "intervention_evaluate",
    });
    expect(rec.metadata.intervener_principal).toBe("key_id:ka");
    // Never sent to the pointer's overridable read URL.
    expect(decl[0]!.url.startsWith("http://traces/")).toBe(false);

    // The refusal record joins back to the declined record, and names the intervener.
    const stored = JSON.parse(readFileSync(join(tmpRoot, "refusals", "refusals.json"), "utf-8"));
    expect(stored.length).toBe(1);
    expect(stored[0].id).toBe(body.refusal_id);
    expect(rec.metadata.refusal_id).toBe(stored[0].id);
    expect(stored[0].principal).toBe("key_id:ka");
    expect(stored[0].decline_class).toBe("contradicts_priors_without_evidence");
    expect(stored[0].declined_execution_id).toBe(rec.execution_id);
    expect(body.declined_execution_id).toBe(rec.execution_id);
  });

  it("MUST-FAIL: an operator edit of a substrate-authored file under strict policy declines as would_break_grading_loop", async () => {
    const subPath = "repos/dev/substrate-authored-file.ts";
    mkdirSync(join(tmpRoot, "repos/dev"), { recursive: true });
    writeFileSync(join(tmpRoot, subPath), "// Substrate-Authored-By: development-vessel\nconst x = 1;\n", "utf-8");
    install([{ id: "concept_z", name: "unrelated" }]);
    const result = await resolveInterventionEvaluate({
      type: "intervention_evaluate",
      proposed_change: { target_path: subPath, diff_summary: "tweak constant value", source: "operator", intent: "small fix" },
      cited_evidence: [{ kind: "memo", ref: "operator says so" }],
      strictness: "strict",
      conceptDbUrl: "http://concept",
      tracesUrl: "http://traces/v2/activities/execution-traces?limit=10",
    });
    expect((result.body as Record<string, unknown>).verdict).toBe("REFUSE");
    const decl = declinedPosts();
    expect(decl.length).toBe(1);
    expect(decl[0]!.body.tags).toEqual(["declined:would_break_grading_loop"]);
    expect(decl[0]!.body.metadata.decline.class).toBe("would_break_grading_loop");
    // No principal was validated (an in-process call): the record says so rather than guessing.
    expect(decl[0]!.body.metadata.intervener_principal).toBe("unidentified");
  });

  it("CONTROL: an ACCEPT posts nothing to the trace store", async () => {
    install([{ id: "concept_xyz", name: "unrelated topic" }]);
    const result = await resolveInterventionEvaluate(
      {
        type: "intervention_evaluate",
        proposed_change: { target_path: "repos/metabob-activity-api/src/routes/activities.ts", diff_summary: "fix observability projection", source: "operator", intent: "fix flagged by phantom scan" },
        cited_evidence: [{ kind: "trace_id", ref: "exec_nv5xefms", note: "real" }],
        strictness: "balanced",
        conceptDbUrl: "http://concept",
        tracesUrl: "http://traces/v2/activities/execution-traces?limit=10",
      },
      { intervener: "key_id:ka" },
    );
    const body = result.body as Record<string, unknown>;
    expect(body.verdict).toBe("ACCEPT");
    expect(posted.length).toBe(0);
    expect(body.refusal_id).toBeUndefined();
  });

  it("the resolve route names the intervener from the credential identity validated, never from the pointer", async () => {
    install(REFUSE_CONCEPTS);
    const pointer = { type: "intervention_evaluate", proposed_change: REFUSE_CHANGE, cited_evidence: [], strictness: "balanced", conceptDbUrl: "http://concept", tracesUrl: "http://traces/v2/activities/execution-traces?limit=10", intervener: "key_id:forged" };
    const res = await impulsesRouter.request("/v2/impulses/resolve", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `ApiKey ${KEY_A}` },
      body: JSON.stringify({ impulse: { pointer } }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; body: Record<string, unknown> };
    expect(json.success).toBe(true);
    expect(json.body.verdict).toBe("REFUSE");
    expect(json.body.intervener_principal).toBe("key_id:ka");
    expect(declinedPosts()[0]!.body.metadata.intervener_principal).toBe("key_id:ka");

    // No credential: still evaluated, unidentified.
    posted = [];
    const anon = await impulsesRouter.request("/v2/impulses/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ impulse: { pointer } }),
    });
    const anonJson = (await anon.json()) as { body: Record<string, unknown> };
    expect(anonJson.body.verdict).toBe("REFUSE");
    expect(declinedPosts()[0]!.body.metadata.intervener_principal).toBe("unidentified");
  });
});

describe("interventionRefused_write: a refusal record's principal is server-stamped, never the writer's claim", () => {
  const write = (key: string, id: string, extra: Record<string, unknown>) => impulsesRouter.request("/v2/impulses/resolve", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `ApiKey ${key}` },
    body: JSON.stringify({ impulse: { type: "interventionRefused_write", refusal: { id, proposed_change: { source: "operator" }, refusal_basis: "b", substrate_priors_cited: [], strictness: "balanced", ...extra } } }),
  });
  const storedById = (id: string) => (JSON.parse(readFileSync(join(tmpRoot, "refusals", "refusals.json"), "utf-8")) as Array<Record<string, unknown>>).find((r) => r["id"] === id);

  it("MUST-FAIL: writer B creating a record that names principal A ends up with principal B", async () => {
    install([]);
    expect((await write(KEY_B, "refusal-forged-principal", { principal: "key_id:ka" })).status).toBe(200);
    expect(storedById("refusal-forged-principal")?.["principal"]).toBe("key_id:kb");
    expect(storedById("refusal-forged-principal")?.["written_by"]).toBe("key_id:kb");
  });

  it("CONTROL: a writer naming itself as the principal keeps it", async () => {
    install([]);
    expect((await write(KEY_A, "refusal-own-principal", { principal: "key_id:ka" })).status).toBe(200);
    expect(storedById("refusal-own-principal")?.["principal"]).toBe("key_id:ka");
  });
});
