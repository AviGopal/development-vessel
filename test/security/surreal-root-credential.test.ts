// THE DATABASE ROOT LOGIN GOES ONLY TO THE CONFIGURED DATABASE.
//
// surrealdb_export, surrealdb_import and residual_shape_discovery talk to SurrealDB's /sql with
// `Authorization: Basic <SURREALDB_USERNAME:SURREALDB_PASSWORD>`, which is the root login. Each one takes
// `pointer.surrealUrl` as an override, so whoever writes the pointer can name the URL and collect the
// root credential.
//
// The rule: a surrealUrl that is not the configured SURREALDB_URL is REFUSED outright. It is not sent
// unauthenticated, because these are root operations. Blank means unset.
//
// Each case uses a RECORDING fetch stub:
//   - override: the pointer names http://attacker.invalid. The resolver must return a refusal and send no
//     request at all (so no request can carry a credential);
//   - control: without an override the request goes to the configured URL and carries the Basic login,
//     so a fix that simply refused everything also fails.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveSurrealdbExport } from "../../src/resolvers/surrealdb-export.js";
import { resolveSurrealdbImport } from "../../src/resolvers/surrealdb-import.js";
import { resolveResidualShapeDiscovery } from "../../src/resolvers/residual-shape-discovery.js";

const ATTACKER = "http://attacker.invalid";
const CONFIGURED = "http://127.0.0.1:8000";
const BASIC = "Basic " + Buffer.from("root:db-pass-under-test").toString("base64");

type Seen = { url: string; authorization: string | null };
const realFetch = globalThis.fetch;
const saved: Record<string, string | undefined> = {};
const ENV = { SURREALDB_URL: CONFIGURED, SURREALDB_USERNAME: "root", SURREALDB_PASSWORD: "db-pass-under-test" };
let dir = "";

beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "surreal-root-"));
  fs.mkdirSync(path.join(dir, "in"), { recursive: true });
  fs.writeFileSync(path.join(dir, "in", "concept.jsonl"), JSON.stringify({ name: "x" }) + "\n");
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function recordingFetch(): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    seen.push({ url, authorization: new Headers(init?.headers ?? {}).get("authorization") });
    return new Response(JSON.stringify([{ status: "OK", result: [] }]), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return seen;
}

const cases: Array<{ name: string; run: (surrealUrl?: string) => Promise<{ shape: string; body: unknown }> }> = [
  {
    name: "surrealdb_export",
    run: (surrealUrl) => resolveSurrealdbExport({ type: "surrealdb_export", tables: ["concept"], output_dir: path.join(dir, `out-${Math.random()}`), ...(surrealUrl !== undefined ? { surrealUrl } : {}) } as never),
  },
  {
    name: "surrealdb_import",
    run: (surrealUrl) => resolveSurrealdbImport({ type: "surrealdb_import", input_dir: path.join(dir, "in"), tables: ["concept"], ...(surrealUrl !== undefined ? { surrealUrl } : {}) } as never),
  },
  {
    name: "residual_shape_discovery",
    run: (surrealUrl) => resolveResidualShapeDiscovery({ type: "residual_shape_discovery", emit_proposals: false, ...(surrealUrl !== undefined ? { surrealUrl } : {}) } as never),
  },
];

for (const c of cases) {
  describe(`${c.name}: SurrealDB root login`, () => {
    it("a pointer surrealUrl that is not the configured database is refused, and no request is sent", async () => {
      const seen = recordingFetch();
      const r = await c.run(ATTACKER);
      expect(seen.filter((s) => s.url.startsWith(ATTACKER))).toEqual([]);
      expect(seen.filter((s) => s.authorization !== null && s.authorization.startsWith("Basic"))).toEqual([]);
      expect(r.shape).toBe("structuredError");
      expect(JSON.stringify(r.body)).toContain("SURREALDB_URL");
    });

    it("control: without an override the configured database gets the root login", async () => {
      const seen = recordingFetch();
      await c.run();
      const sql = seen.filter((s) => s.url.startsWith(`${CONFIGURED}/sql`));
      expect(sql.length).toBeGreaterThan(0);
      expect(sql.every((s) => s.authorization === BASIC)).toBe(true);
    });

    it("a blank surrealUrl means unset: the configured database, with the login", async () => {
      const seen = recordingFetch();
      await c.run("  ");
      expect(seen.filter((s) => s.url.startsWith(`${CONFIGURED}/sql`) && s.authorization === BASIC).length).toBeGreaterThan(0);
    });
  });
}
