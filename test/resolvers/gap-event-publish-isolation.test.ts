// A TEST'S GAP WRITE MUST NOT REACH THE LIVE EVENT BUS.
//
// resolveSubstrateGapWrite publishes devvessel.gap.written to `${ACTIVITY_API_ENDPOINT ?? ACTIVITY_API_URL ??
// http://127.0.0.1:8080}/v2/events/publish`. Inside a container that is the live activity-api, and the suite runs
// there (post-land, compose verify), so every test gap write landed on the live bus during the measurement window:
// 38 publishes from four test files, measured with a listener on the publish URL.
//
// Two layers: (1) the resolver refuses to publish when its gap store root is a scratch (temp) root, unless a test
// opts in; (2) the test files that write gaps stub the publish URL. The listener here stands in for the bus at the
// same address the resolver uses (ACTIVITY_API_ENDPOINT, read at publish time).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let publishes: string[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    if (req.method === "POST" && u.pathname === "/v2/events/publish") {
      try { publishes.push(String(((await req.json()) as { data?: { gap_id?: unknown } }).data?.gap_id)); } catch { publishes.push("?"); }
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  },
});
const LISTENER = `http://127.0.0.1:${server.port}`;
const VESSEL_ROOT = join(import.meta.dir, "..", "..");

const ROOT = mkdtempSync(join(tmpdir(), "gap-publish-isolation-"));
const saved = { ws: process.env["WORKSPACE_ROOT"], ep: process.env["ACTIVITY_API_ENDPOINT"], skip: process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] };
process.env["WORKSPACE_ROOT"] = ROOT;
process.env["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER"] = "1";
const mod = await import(`../../src/resolvers/substrate-gap.js?${"gap-publish-isolation"}`);
if (!mod.gapStoreRootForTest().startsWith(tmpdir())) throw new Error("refusing to run against a non-temp gap store");

beforeAll(() => {
  process.env["ACTIVITY_API_ENDPOINT"] = LISTENER;
  mkdirSync(join(ROOT, "gaps"), { recursive: true });
  writeFileSync(join(ROOT, "gaps", "gaps.json"), "[]");
});
afterAll(() => {
  for (const [k, v] of [["WORKSPACE_ROOT", saved.ws], ["ACTIVITY_API_ENDPOINT", saved.ep], ["SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER", saved.skip]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  server.stop(true);
  rmSync(ROOT, { recursive: true, force: true });
});

const gap = (id: string) => ({ type: "substrateGap_write", gap: { id, category: "source_divergence", source: "substrate_detected", status: "open", summary: `publish isolation probe ${id}` } });

describe("the gap-written publish is refused from a scratch gap store", () => {
  test("a write to a scratch-root store publishes nothing", async () => {
    publishes = [];
    const r = await mod.resolveSubstrateGapWrite(gap("publish-isolation-probe-a") as never, { vocabulary: null });
    expect(r.shape).toBe("substrateGapWriteResult");
    expect(publishes).toEqual([]);
  });

  test("control: the same write with the test opt-in reaches the listener (the address is live)", async () => {
    publishes = [];
    mod.__allowGapEventPublishFromScratchForTests?.(true);
    try {
      await mod.resolveSubstrateGapWrite(gap("publish-isolation-probe-b") as never, { vocabulary: null });
    } finally {
      mod.__allowGapEventPublishFromScratchForTests?.(false);
    }
    expect(publishes).toEqual(["publish-isolation-probe-b"]);
  });

  test("the scratch predicate: temp roots are scratch, the deployed store root is not", () => {
    expect(typeof mod.isScratchGapStoreRoot).toBe("function");
    expect(mod.isScratchGapStoreRoot(ROOT)).toBe(true);
    expect(mod.isScratchGapStoreRoot(join(tmpdir(), "x"))).toBe(true);
    expect(mod.isScratchGapStoreRoot("/tmp/abc")).toBe(true);
    expect(mod.isScratchGapStoreRoot("/workspace")).toBe(false);
    expect(mod.isScratchGapStoreRoot("/workspace/git/super-repo")).toBe(false);
    expect(mod.isScratchGapStoreRoot("/tmpfoo")).toBe(false);
  });
});

describe("a gap-writing test file publishes nothing to the bus", () => {
  test("gap-write-demand-goals.test.ts, run with a listener on the publish URL, sends 0 publishes", async () => {
    publishes = [];
    const out = join(ROOT, "child-out.txt");
    const p = Bun.spawn(["bash", "-c", `bun test ./test/resolvers/gap-write-demand-goals.test.ts > ${JSON.stringify(out)} 2>&1`], {
      cwd: VESSEL_ROOT,
      env: { HOME: process.env["HOME"] ?? "", PATH: process.env["PATH"] ?? "", ACTIVITY_API_ENDPOINT: LISTENER, SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER: "1" },
    });
    await p.exited;
    const text = (() => { try { return readFileSync(out, "utf8"); } catch { return ""; } })();
    // The child must actually have run its cases, or 0 publishes proves nothing.
    expect(text).toMatch(/\b[1-9]\d* pass/);
    expect(publishes).toEqual([]);
  }, 120_000);
});
