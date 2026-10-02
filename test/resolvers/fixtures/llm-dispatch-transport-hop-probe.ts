// Child process for llm-completion-dispatch-transport-hop.test.ts. The resolver reads its key
// and egress at module load and bun shares one module cache across a run, so the scenario runs
// here, under the environment the test sets, and reports what each fetch carried.
const calls: Array<{ url: string; authorization: string | null; body: string }> = [];
let discoveryCalls = 0;
const EGRESS = process.env["FED_TRANSPORT_EGRESS"]!;
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  const body = typeof init?.body === "string" ? init.body : "";
  calls.push({ url, authorization: new Headers(init?.headers ?? {}).get("authorization"), body });
  if (url.endsWith("/resolve") && body.includes("vesselCapability")) {
    discoveryCalls++;
    // First lookup (findLlmCompletionEndpoints): a hub arm mirrored onto the local transport's
    // resolve surface, and a plain HTTP arm elsewhere. Later lookups (the lazy federated
    // fallback): a hub arm reachable only through the transport egress.
    if (discoveryCalls === 1) {
      return Response.json({ content: { vessels: [
        { vesselId: "llm-resolver-a@hub-x", endpoint: EGRESS, resolve_endpoint: "/v2/impulses/resolve", health_score: 0.9 },
        { vesselId: "llm-resolver-local", endpoint: "http://10.0.0.5:8220", resolve_endpoint: "/resolve", health_score: 0.5 },
      ] } });
    }
    return Response.json({ content: { vessels: [
      { vesselId: "llm-resolver-b@hub-x", endpoint: EGRESS, libp2p_multiaddr: ["/ip4/10.0.0.1/tcp/4001/p2p/QmR/p2p-circuit/p2p/QmB"] },
    ] } });
  }
  // Every arm refuses, so the resolver walks the local loop and then the federated one.
  return Response.json({ error: "unauthorized" }, { status: 502 });
}) as typeof fetch;

const { resolveLlmCompletionDispatch } = await import("../../../src/resolvers/llm-completion-dispatch.js");
const result = await resolveLlmCompletionDispatch({ type: "llm_completion_dispatch", prompt: "hello", tools: [] });
process.stdout.write("\nPROBE " + JSON.stringify({ calls, result }) + "\n");
process.exit(0);
