import { test, expect } from "bun:test";
import * as mod from "../../src/resolvers/ui-write-passthrough";

// Reproduces: THE ONLY DESIGNED ESCAPE FROM THE HOPELESS-CATEGORY SEAL IS DELIVERED
// TO A VESSEL NO HUMAN SURFACE READS. We simulate discovery advertising the
// human-surface-vessel for uiQuestion_write, but make that target return 503. The
// current implementation then falls back to the pinned stateful-ui-vessel :8270 and
// succeeds — exactly the defect. The correct behavior is to NOT deliver to 8270.
// We assert the returned content does not include the pinned surface's telltale
// text "the retired vessel is dead" — and this assertion FAILS under the defect.

test("ui write passthrough should not deliver to the retired pinned endpoint when discovery offers a human surface", async () => {
  const originalFetch = globalThis.fetch;
  const originalDiscovery = process.env["DISCOVERY_ENDPOINT"];
  process.env["DISCOVERY_ENDPOINT"] = "http://disco";

  // Fake network: discovery + two targets.
  globalThis.fetch = (async (input: string | URL, init?: { body?: string | null }) => {
    const url = typeof input === "string" ? input : input.toString();
    const raw = init?.body ?? null;
    let body: unknown = undefined;
    try {
      if (typeof raw === "string") body = JSON.parse(raw);
    } catch {
      body = undefined;
    }

    // Discovery answers with a human-surface producer for uiQuestion_write, but we
    // DO NOT provide any humanAskRoute record (so routed=false and no timers).
    if (url === "http://disco/resolve") {
      const p = (body as { pointer?: { type?: string; shape?: string } } | undefined)?.pointer;
      if (p?.type === "vesselCapability" && p.shape === "uiQuestion_write") {
        return new Response(
          JSON.stringify({
            content: {
              vessels: [
                { vesselId: "human-surface-vessel:hs1", endpoint: "http://127.0.0.1:8310", resolve_endpoint: "/resolve" },
                { vesselId: "development-vessel:other", endpoint: "http://127.0.0.1:8200", resolve_endpoint: "/resolve" },
              ],
            },
          }),
          { status: 200 },
        );
      }
      if (p?.type === "vesselCapability" && p.shape === "poolImpulse") {
        // No poolImpulse producers returned => preferredAskVesselIds = [] (no route record)
        return new Response(JSON.stringify({ content: { vessels: [] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ content: { vessels: [] } }), { status: 200 });
    }

    // Human surface resolve endpoint: simulate a brief outage (restart window)
    if (url === "http://127.0.0.1:8310/resolve") {
      return new Response("unavailable", { status: 503 });
    }

    // PINNED fallback (stateful-ui-vessel :8270) — the retired vessel no human reads.
    if (url === "http://127.0.0.1:8270/resolve") {
      return new Response(
        JSON.stringify({ delivered: "pinned", note: "the retired vessel is dead" }),
        { status: 200 },
      );
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const result = await mod.resolveUiWritePassthrough({ type: "uiQuestion_write", title: "gap-248", body: "repro" });
    // The correct behavior would be to refuse delivery rather than silently
    // route to the pinned retired surface. We assert the absence of the retired
    // vessel's telltale phrase; this FAILS today because the defect delivers to 8270.
    expect(result.shape).toBe("uiQuestion_write");
    expect(JSON.stringify(result.body)).not.toContain("the retired vessel is dead");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDiscovery === undefined) delete process.env["DISCOVERY_ENDPOINT"]; else process.env["DISCOVERY_ENDPOINT"] = originalDiscovery;
  }
});
