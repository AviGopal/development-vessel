// STUB THE GAP-WRITTEN PUBLISH for a test file that writes gaps through substrate-gap.
//
// resolveSubstrateGapWrite POSTs to `<activity-api>/v2/events/publish`, which inside a container is the live bus.
// The resolver already refuses to publish from a scratch store; this is the second layer for a file whose store
// root lost the module-load race. Only the publish URL is intercepted; every other fetch goes to the original.
export function stubGapEventPublish(): { count: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let n = 0;
  const stub = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.endsWith("/v2/events/publish")) {
      n += 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    return original(input as never, init);
  }) as typeof fetch;
  globalThis.fetch = stub;
  return {
    count: () => n,
    restore: () => { if (globalThis.fetch === stub) globalThis.fetch = original; },
  };
}
