// The vessel-scaffold-trigger-tick dispatch step must reach goal-host with this vessel's real key.
//
// The step is an http_fetch POST to goal-host's /run-goal. No executor expands a `${...}` placeholder in a
// template's header values, and http_fetch attaches the node key only when the step has not set its own
// Authorization. A step that carries the literal "ApiKey ${METABOB_API_KEY}" therefore sends that literal and
// suppresses the real key, so a goal-host that checks inbound credentials refuses every tick.
//
// These tests drive the real step config through the real http_fetch code path against a stub goal-host on
// an ephemeral loopback port. The stub answers 401 unless it sees `ApiKey <the test key>`. The only change made
// to the seeded step is its port (the host stays loopback, so http_fetch still treats it as substrate-local).
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveHttpFetch, type HttpFetchPointer } from "../../src/resolvers/http-fetch.js";
import { VESSEL_SCAFFOLD_TRIGGER_TICK_TEMPLATE } from "../../src/seed/vessel-scaffold-trigger-tick.js";

const TEST_KEY = "test-scaffold-trigger-key";

let server: ReturnType<typeof Bun.serve>;
let prevKey: string | undefined;
const seen: Array<string | null> = [];

beforeAll(() => {
  prevKey = process.env["METABOB_API_KEY"];
  process.env["METABOB_API_KEY"] = TEST_KEY;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const auth = req.headers.get("authorization");
      seen.push(auth);
      if (auth !== `ApiKey ${TEST_KEY}`) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ dispatchId: "stub-dispatch" }), { status: 202, headers: { "content-type": "application/json" } });
    },
  });
});

afterAll(() => {
  server?.stop(true);
  if (prevKey === undefined) delete process.env["METABOB_API_KEY"];
  else process.env["METABOB_API_KEY"] = prevKey;
});

function dispatchStep(): HttpFetchPointer {
  const task = VESSEL_SCAFFOLD_TRIGGER_TICK_TEMPLATE.tasks.find((t) => t.id === "dispatch_scaffold");
  expect(task).toBeDefined();
  return (task as unknown as { config: HttpFetchPointer }).config;
}

function toStub(pointer: HttpFetchPointer): HttpFetchPointer {
  const u = new URL(pointer.url);
  expect(u.hostname).toBe("127.0.0.1");
  u.port = String(server.port);
  return { ...pointer, url: u.toString() };
}

function stubPath(): string {
  return `http://127.0.0.1:${server.port}/run-goal`;
}

describe("vessel-scaffold-trigger-tick: the goal-host dispatch carries the real key", () => {
  // MUST-FAIL: red while the step carries its own literal Authorization, green once http_fetch attaches the key.
  it("scaffold-trigger-dispatch-authenticates the seeded dispatch step is accepted by a goal-host that checks the key", async () => {
    const step = dispatchStep();
    expect(step.type).toBe("http_fetch");
    expect(new URL(step.url).pathname).toBe("/run-goal");
    seen.length = 0;
    const r = await resolveHttpFetch(toStub(step));
    const body = r.body as { status: number; ok: boolean };
    expect(seen).toEqual([`ApiKey ${TEST_KEY}`]);
    expect(body.status).toBe(202);
    expect(body.ok).toBe(true);
  });

  it("scaffold-trigger-no-placeholder no header of the seeded dispatch step holds an unexpanded ${...} placeholder", () => {
    const headers = dispatchStep().headers ?? {};
    const unexpanded = Object.entries(headers).filter(([, v]) => v.includes("${"));
    expect(unexpanded).toEqual([]);
  });

  // CONTROL: a step with no Authorization header gets the real key attached by http_fetch. This is the
  // mechanism the fix relies on; it is green at base and at tip.
  it("scaffold-trigger-control-bare-step a step with no Authorization header gets the real key attached", async () => {
    seen.length = 0;
    const r = await resolveHttpFetch({
      type: "http_fetch",
      method: "POST",
      url: stubPath(),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "control" }),
    });
    expect(seen).toEqual([`ApiKey ${TEST_KEY}`]);
    expect((r.body as { status: number }).status).toBe(202);
  });

  // STUB CONTROL: the stub really refuses a literal placeholder, so the must-fail test's green is not a
  // stub that accepts anything.
  it("scaffold-trigger-control-stub-refuses-literal the stub goal-host refuses an unexpanded placeholder", async () => {
    seen.length = 0;
    const r = await resolveHttpFetch({
      type: "http_fetch",
      method: "POST",
      url: stubPath(),
      headers: { "Content-Type": "application/json", Authorization: "ApiKey ${METABOB_API_KEY}" },
      body: JSON.stringify({ goal: "control" }),
    });
    expect(seen).toEqual(["ApiKey ${METABOB_API_KEY}"]);
    expect((r.body as { status: number }).status).toBe(401);
  });
});
