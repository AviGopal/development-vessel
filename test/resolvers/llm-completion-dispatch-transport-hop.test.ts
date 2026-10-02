// llm_completion_dispatch hands this vessel's key to the federation transport as a HEADER on
// the local hop, and never puts it in the request body it builds (or the result it returns).
//
// Once the transport's ingress admits callers by their own credential (it no longer lends
// the node's key), a resolve that crosses with no credential is refused for every
// trust_group shape, llm_completion included. The transport moves the local hop's
// Authorization header into the wire pointer itself; the body must stay credential-free,
// because the body is what dev-vessel traces.
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { transportHopHeaders } from "../../src/resolvers/federated-llm-egress.js";

const FAKE_KEY = "mb-test-dev-vessel-transport-hop-0123456789";
const EGRESS = "http://127.0.0.1:18401";
interface Call { url: string; authorization: string | null; body: string }
let calls: Call[] = [];
let result: unknown;

beforeAll(async () => {
  const p = Bun.spawn(["bun", join(import.meta.dir, "fixtures", "llm-dispatch-transport-hop-probe.ts")], {
    env: {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
      METABOB_API_KEY: FAKE_KEY, FED_TRANSPORT_EGRESS: EGRESS, FED_SUBSTRATE_ID: "this-substrate",
      DISCOVERY_ENDPOINT: "http://127.0.0.1:18100", DISCOVERY_VESSEL_ENDPOINT: "http://127.0.0.1:18100",
    },
    stdout: "pipe", stderr: "ignore",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const line = out.split("\n").find((l) => l.startsWith("PROBE "));
  if (!line) throw new Error("probe printed no result");
  ({ calls, result } = JSON.parse(line.slice(6)) as { calls: Call[]; result: unknown });
}, 60_000);

const isTransport = (u: string) => u.startsWith(EGRESS + "/");
const arms = () => calls.filter((c) => !c.body.includes("vesselCapability"));

describe("transportHopHeaders", () => {
  test("attaches the key only to the local transport", () => {
    const E = "http://127.0.0.1:8401";
    expect(transportHopHeaders(E + "/egress/resolve?target=x", E, "k1").Authorization).toBe("ApiKey k1");
    expect(transportHopHeaders(E + "/v2/impulses/resolve", E, "k1").Authorization).toBe("ApiKey k1");
    expect(transportHopHeaders("http://10.0.0.5:8220/resolve", E, "k1").Authorization).toBeUndefined();
    expect(transportHopHeaders("http://127.0.0.1:8220/resolve", E, "k1").Authorization).toBeUndefined();
    expect(transportHopHeaders("::bad::", E, "k1").Authorization).toBeUndefined();
    expect(transportHopHeaders(E + "/egress/resolve", E, "").Authorization).toBeUndefined();
  });
});

describe("resolveLlmCompletionDispatch over the federation transport", () => {
  test("the local loop's transport-mirrored arm and the federated egress arm both carry the key as a header", () => {
    const viaTransport = arms().filter((c) => isTransport(c.url));
    const urls = viaTransport.map((c) => c.url);
    expect(urls.some((u) => u.endsWith("/v2/impulses/resolve"))).toBe(true); // local loop, mirrored hub arm
    expect(urls.some((u) => u.includes("/egress/resolve?target="))).toBe(true); // lazy federated fallback
    for (const c of viaTransport) expect(c.authorization).toBe(`ApiKey ${FAKE_KEY}`);
  });

  test("an arm that is not the local transport is never handed the key", () => {
    const elsewhere = arms().filter((c) => !isTransport(c.url));
    expect(elsewhere.length).toBe(1);
    expect(elsewhere[0]!.authorization).toBeNull();
  });

  test("no request body, and not the returned (traced) result, carries the credential", () => {
    for (const c of arms()) {
      expect(c.body).not.toContain(FAKE_KEY);
      expect(c.body).not.toContain("_auth");
      expect(c.body.toLowerCase()).not.toContain("authorization");
      expect(JSON.parse(c.body).type).toBe("llm_completion");
    }
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
    expect((result as { shape?: string }).shape).toBe("structuredError");
  });
});
