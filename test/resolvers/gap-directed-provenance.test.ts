// A GAP ROW'S `directed` IS AN OPERATOR'S FIELD (operator security review, 2026-10-19; folded into the row
// development-vessel-resolve-route-does-not-authenticate-feature-compose-or-gap-to-feature).
//
// Measured: classification_metadata.directed on a gap row makes the decomposer drop the autonomy scope for its steps
// (and the steps, a recommit child and a narrowed child inherit it), and ANY keyed substrateGap_write could set it.
//
// CONTRACT pinned here, through the real route and the real store (temp root; identity is a globalThis.fetch stub):
//   - A keyed non-operator write with directed:true is stored WITHOUT directed (and without directed_by), and the
//     strip is logged by name (directed_claim_stripped). A forged directed_by or _directed_grant is never trusted.
//   - A non-operator cannot clear an operator's direction either: its directed:false leaves the stored values.
//   - An operator:direct write is stored directed, stamped directed_by with the principal's label (key id, never the key).
//   - Readers honour directed only with that provenance (gapDirected): a LEGACY row (directed:true, no directed_by) is
//     undirected; the three in-process readers use gapDirected (source pins).
//   - CONTROL: an in-process write propagating an honoured direction (the decomposer's and the narrower's path) keeps it.
//     goal-host's operator-origin compose path is pinned in test/routes/compose-door-auth.test.ts (X-Operator-Authorization).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGapStore } from "./gap-store-snapshot.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";
import { isolateLearnedStateInProcess } from "./isolated-gap-store-run.js";

const ROOT = join(tmpdir(), `gap-directed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
isolateLearnedStateInProcess(ROOT);
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";

const sg = await import("../../src/resolvers/substrate-gap.js");
const od = await import("../../src/lib/operator-direct.js");
const { impulsesRouter } = await import(`../../src/routes/impulses.js?${"gap-directed-provenance-isolated"}`);
const RUN = Math.random().toString(36).slice(2, 8);

// A loopback literal: the credential module sends keys over plain http only to private hosts.
const IDENTITY = "http://127.0.0.1:59137";
const PLAIN_KEY = "gap-directed-plain-key-fixture";
const OPERATOR_KEY = "gap-directed-operator-key-fixture";

type Row = Record<string, unknown>;
const originalFetch = globalThis.fetch;
const origLog = console.log;
const origWarn = console.warn;
const saved: Record<string, string | undefined> = {};
let warned: string[] = [];
let gapStore: { restore: () => Promise<void> } | null = null;

beforeAll(() => {
  gapStore = snapshotGapStore(sg.gapStoreRootForTest(), sg.__settleBirthEvaluationsForTests);
  for (const k of ["GAP_STORE_ENDPOINT", "IDENTITY_VESSEL_URL", "METABOB_API_KEY"]) saved[k] = process.env[k];
  delete process.env["GAP_STORE_ENDPOINT"];
  delete process.env["METABOB_API_KEY"];
  process.env["IDENTITY_VESSEL_URL"] = IDENTITY;
  const root = sg.gapStoreRootForTest();
  if (!root.startsWith(tmpdir()) && !root.startsWith("/tmp/")) throw new Error(`gap store root ${root} is not a temp dir`);
  mkdirSync(join(root, "gaps"), { recursive: true });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url === `${IDENTITY}/v1/auth/resolve`) {
      const key = String(body?.impulse?.pointer?.apiKey ?? "");
      const scopes = key === PLAIN_KEY ? ["read", "write"] : key === OPERATOR_KEY ? ["read", "write", "operator:direct"] : null;
      if (!scopes) return Response.json({ success: false, error: "invalid" }, { status: 401 });
      return Response.json({ success: true, data: { authenticated: true, orgId: "o", userId: "u", keyId: key === OPERATOR_KEY ? "kid-operator" : "kid-plain", scopes } });
    }
    const p = body?.pointer ?? body?.impulse?.pointer;
    if (p?.type === "vesselCapability") return Response.json({ content: { vessels: [] } });
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    return Response.json({ body: { impulses: [] } });
  }) as unknown as typeof fetch;
  sg.__setBirthJudgeForTests(async () => "present");
  console.log = () => {};
  console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); };
});
afterAll(async () => {
  await gapStore?.restore();
  globalThis.fetch = originalFetch;
  console.log = origLog;
  console.warn = origWarn;
  sg.__setBirthJudgeForTests(null);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
});
beforeEach(() => { warned = []; });

const gapOf = (id: string, meta: Row): Row => ({ id, category: "systematic_failure", source: "operator", status: "open", detected_at: new Date().toISOString(), summary: `directed-provenance fixture ${id}`, classification_metadata: meta });
const write = (gap: Row, key: string, extra: Row = {}) => impulsesRouter.request("/v2/impulses/resolve", {
  method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${key}` },
  body: JSON.stringify({ impulse: { pointer: { type: "substrateGap_write", gap, ...extra } } }),
});
async function storedMeta(id: string): Promise<Row> {
  await sg.__settleBirthEvaluationsForTests();
  const r = await sg.resolveSubstrateGap({ type: "substrateGap", id, limit: 1 } as never);
  const row = ((r.body as { gaps?: Row[] }).gaps ?? [])[0];
  return ((row?.["classification_metadata"] ?? {}) as Row);
}

describe("a gap row's directed is honoured only with an operator's provenance", () => {
  it("gap-directed a keyed non-operator write with directed:true is stored without it, and the strip is logged", async () => {
    const id = `gd-plain-${RUN}`;
    const r = await write(gapOf(id, { directed: true, edit_site: "repos/fixture-vessel/src/a.ts" }), PLAIN_KEY);
    expect(r.status).toBe(200);
    const m = await storedMeta(id);
    expect(m["edit_site"]).toBe("repos/fixture-vessel/src/a.ts");
    expect("directed" in m).toBe(false);
    expect("directed_by" in m).toBe(false);
    expect(od.gapDirected(m)).toBe(false);
    expect(warned.some((l) => l.includes(`directed_claim_stripped: gap ${id}`))).toBe(true);
  });

  it("gap-directed a forged directed_by and an inbound _directed_grant from a non-operator are never trusted", async () => {
    const id = `gd-forged-${RUN}`;
    await write(gapOf(id, { directed: true, directed_by: "operator:key:forged" }), PLAIN_KEY, { _directed_grant: "operator:key:forged" });
    const m = await storedMeta(id);
    expect("directed" in m).toBe(false);
    expect("directed_by" in m).toBe(false);
  });

  it("gap-directed an operator:direct write is stored directed, stamped with the principal's label", async () => {
    const id = `gd-operator-${RUN}`;
    expect((await write(gapOf(id, { directed: true }), OPERATOR_KEY)).status).toBe(200);
    const m = await storedMeta(id);
    expect(m["directed"]).toBe(true);
    expect(m["directed_by"]).toBe("operator:key:kid-operator");
    expect(od.gapDirected(m)).toBe(true);
    expect(warned.some((l) => l.includes("directed_claim_stripped"))).toBe(false);
  });

  it("gap-directed a non-operator can neither clear nor re-stamp an operator's direction", async () => {
    const id = `gd-keep-${RUN}`;
    await write(gapOf(id, { directed: true }), OPERATOR_KEY);
    await write(gapOf(id, { directed: false, directed_by: "operator:key:forged", note: "rewrite" }), PLAIN_KEY);
    const m = await storedMeta(id);
    expect(m["directed"]).toBe(true);
    expect(m["directed_by"]).toBe("operator:key:kid-operator");
    expect(m["note"]).toBe("rewrite");
  });

  it("gap-directed a legacy row (directed:true without directed_by) is undirected to every reader", () => {
    expect(od.gapDirected({ directed: true })).toBe(false);
    expect(od.gapDirected({ directed: true, directed_by: "" })).toBe(false);
    expect(od.gapDirected({ directed: true, directed_by: "operator:key:k" })).toBe(true);
    expect(od.inheritedDirectedGrant({ directed: true })).toBeNull();
  });

  it("gap-directed the in-process readers honour directed only through gapDirected (source pins)", () => {
    const src = (f: string) => readFileSync(join(import.meta.dir, "..", "..", "src", f), "utf8");
    expect(src("resolvers/gap-to-feature.ts")).toContain("const childDirected = gapDirected(meta) || opts.directed === true;");
    expect(src("judge/gap-admission.ts")).toContain("const childDirected = gapDirected(meta) || opts.directed === true;");
    expect(src("resolvers/feature-compose.ts")).toContain("...(gapDirected(meta) ? { directed: true } : {}) }");
    for (const f of ["resolvers/gap-to-feature.ts", "judge/gap-admission.ts", "resolvers/feature-compose.ts", "judge/gap-attempt-credit.ts"]) {
      expect(src(f)).not.toMatch(/meta\.directed === true/);
    }
    expect(src("resolvers/substrate-gap.ts")).toContain("gateGapDirected(pointer as Record<string, unknown>);");
  });

  it("gap-directed control: an in-process write propagating an honoured direction keeps it, with the parent's label", async () => {
    const id = `gd-inherit-${RUN}`;
    const parentMeta = { directed: true, directed_by: "operator:key:kid-operator" };
    await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", _directed_grant: od.inheritedDirectedGrant(parentMeta) ?? undefined, gap: gapOf(id, { directed: true }) } as never);
    const m = await storedMeta(id);
    expect(m["directed"]).toBe(true);
    expect(m["directed_by"]).toBe("operator:key:kid-operator");
  });

  it("gap-directed control: an in-process write with no grant cannot direct a row", async () => {
    const id = `gd-inproc-${RUN}`;
    await sg.resolveSubstrateGapWrite({ type: "substrateGap_write", gap: gapOf(id, { directed: true }) } as never);
    expect("directed" in (await storedMeta(id))).toBe(false);
  });
});
