import type { ResolverResult } from "./types.js";

interface TransportHealth {
  activeReservations: number;
  connections: Array<{ limited: boolean }>;
  streamResets: number;
}

interface TransportHealthResponse {
  transport: TransportHealth;
}

export async function resolveTransportHealthObserver(pointer: {
  shape: string;
  [key: string]: unknown;
}): Promise<ResolverResult> {
  let degraded = false;
  let reason = "";

  try {
    const transportEndpoint = process.env["TRANSPORT_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8401";
    const res = await fetch(`${transportEndpoint}/health`);
    const data = (await res.json()) as TransportHealthResponse;
    const transport = data.transport;

    if (transport.activeReservations === 0) {
      degraded = true;
      reason = "activeReservations is 0";
    } else if (
      transport.connections.length > 0 &&
      transport.connections.every((c) => c.limited)
    ) {
      degraded = true;
      reason = "all connections are limited";
    } else if (transport.streamResets > 0) {
      degraded = true;
      reason = `streamResets=${transport.streamResets}`;
    }
  } catch (err) {
    degraded = true;
    reason = `health endpoint unreachable: ${String(err)}`;
  }

  if (degraded) {
    return {
      shape: "substrateGap_write",
      body: {
        category: "operational_health",
        gap: `Transport health degraded: ${reason}`,
        pointer,
      },
    };
  }

  return {
    shape: "ok",
    body: { status: "transport healthy" },
  };
}
