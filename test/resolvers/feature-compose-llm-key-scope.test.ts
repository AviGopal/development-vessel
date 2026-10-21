// A DIRECT LLM ARM OFF THIS MACHINE GETS NO NODE KEY (self-auth.ts, "same-host peers only"; user ruling
// "Narrow: direct off-host only (Recommended)", 2026-10-21T10:22:11Z).
//
// feature-compose's llmCall used to put `Authorization: ApiKey <node key>` on every endpoint of its failover list,
// including a plain HTTP row on another host, which has no transport in front of it to decide who may hold the key.
// Expected:
//   - a direct endpoint off this machine is called WITHOUT the key (it answers or refuses on its own), with one
//     names-only line (the must-fail);
//   - an overlay hop through this node's own federation egress keeps the key, as before: the transport's same-authority
//     peer list decides whether it goes further (control);
//   - a same-host endpoint keeps the key (control).
//
// EACH CASE RUNS IN ITS OWN CHILD PROCESS. In one bun process with the rest of the suite the overlay control went red
// while it was green alone: the key the module sends is config.ts' value frozen at its first import, and the module
// graph (config, self-auth, feature-compose, global fetch) is shared with every other file of that process, so what this
// file set before its import was not what the module held. A child with an explicit env (isolatedChildEnv plus the
// values below) imports a fresh graph, stubs fetch, runs one failover and prints what each request carried; the parent
// asserts on that JSON only. Every value is this file's own: a dummy key, localhost, and an .invalid name that never
// resolves. No real key, no real address.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedChildEnv } from "./isolated-gap-store-run.js";

const DUMMY = `dummy-node-key-${Math.random().toString(36).slice(2, 10)}`;
const FC = join(import.meta.dir, "..", "..", "src", "resolvers", "feature-compose.ts");
const VESSEL = join(import.meta.dir, "..", "..");
const ROOT = mkdtempSync(join(tmpdir(), "llm-key-scope-"));
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

const LOCAL = "http://localhost:18110/resolve";
const FAR_TARGET = "/dns4/far-hub.invalid/tcp/4001/p2p/12D3KooWDummyRelay/p2p-circuit/p2p/12D3KooWDummyDest";
const EGRESS = `http://localhost:8401/egress/resolve?target=${encodeURIComponent(FAR_TARGET)}&vessel=llm-resolver-dummy&expect_substrate=far-substrate`;
const OFFHOST = "http://far-arm.invalid:18100/resolve";

type Call = { url: string; auth: string | null };
type ChildOut = { exported: boolean; result?: string; error?: string; calls: Call[]; warned: string[] };

/** One failover over `endpoints` in a fresh child process. Each URL in `answers` returns its status (200 answers "OK");
 *  any other URL answers 503. */
function failoverInChild(endpoints: string[], answers: Record<string, number>): ChildOut {
  const code = [
    `const calls = [], warned = [];`,
    `console.warn = (...a) => { warned.push(a.map(String).join(" ")); };`,
    `console.log = () => {}; console.error = () => {};`,
    `const answers = ${JSON.stringify(answers)};`,
    `globalThis.fetch = async (input, init) => {`,
    `  const url = typeof input === "string" ? input : String(input?.url ?? input);`,
    `  calls.push({ url, auth: new Headers(init?.headers).get("authorization") });`,
    `  const status = answers[url] ?? 503;`,
    `  return status === 200 ? Response.json({ content: "OK", resolved: true }) : new Response("unavailable (test)", { status });`,
    `};`,
    `const fc = await import(${JSON.stringify(FC)});`,
    `const out = { exported: typeof fc.llmCallWithFailover === "function", calls, warned };`,
    `if (out.exported) {`,
    `  try { out.result = await fc.llmCallWithFailover(${JSON.stringify(endpoints)}, "prompt", "auto"); }`,
    `  catch (e) { out.error = String(e?.message ?? e); }`,
    `}`,
    `process.stdout.write("CHILD_RESULT " + JSON.stringify(out) + "\\n");`,
  ].join("\n");
  const env = isolatedChildEnv(ROOT, { METABOB_API_KEY: DUMMY, FED_TRANSPORT_EGRESS: "http://localhost:8401", NODE_ENV: "test", TZ: "UTC" });
  const p = Bun.spawnSync([process.execPath, "-e", code], { env, cwd: VESSEL, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const stdout = new TextDecoder().decode(p.stdout);
  const line = stdout.split("\n").find((l) => l.startsWith("CHILD_RESULT "));
  if (!line) throw new Error(`child printed no result (exit ${p.exitCode}): ${new TextDecoder().decode(p.stderr).slice(-600)}`);
  return JSON.parse(line.slice("CHILD_RESULT ".length)) as ChildOut;
}

describe("feature-compose llmCallWithFailover: the node key's scope", () => {
  it("CONTROL: over [local arm, overlay egress hop] both carry the node key; the transport decides past the hop", () => {
    const r = failoverInChild([LOCAL, EGRESS], { [EGRESS]: 200 }); // the local arm is down (503), so the call spills to the egress hop
    expect(r.exported).toBe(true);
    expect(r.result).toBe("OK");
    expect(r.calls).toEqual([{ url: LOCAL, auth: `ApiKey ${DUMMY}` }, { url: EGRESS, auth: `ApiKey ${DUMMY}` }]);
    expect(r.warned.filter((w) => w.startsWith("[cross-node-key]"))).toEqual([]);
  }, 60_000);

  it("CONTROL: a same-host arm still receives the node key, and nothing is logged", () => {
    const r = failoverInChild([LOCAL], { [LOCAL]: 200 });
    expect(r.exported).toBe(true);
    expect(r.result).toBe("OK");
    expect(r.calls).toEqual([{ url: LOCAL, auth: `ApiKey ${DUMMY}` }]);
    expect(r.warned.filter((w) => w.startsWith("[cross-node-key]"))).toEqual([]);
  }, 60_000);

  it("MUST-FAIL: an endpoint off this machine is called without the key; the next endpoint still gets it", () => {
    const r = failoverInChild([OFFHOST, LOCAL], { [LOCAL]: 200 }); // the off-machine arm answers 503, so the call moves on to the local arm
    expect(r.exported).toBe(true);
    expect(r.result).toBe("OK");
    expect(r.calls).toEqual([{ url: OFFHOST, auth: null }, { url: LOCAL, auth: `ApiKey ${DUMMY}` }]);
    expect(r.warned.filter((w) => w.startsWith("[cross-node-key]"))).toEqual(["[cross-node-key] refused non-local far-arm.invalid"]);
    expect(r.warned.some((w) => w.includes(DUMMY))).toBe(false);
  }, 60_000);
});
