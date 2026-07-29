import type { ResolverResult } from "./types.js";

interface TransportHealth {
  activeReservations: number;
  connections: Array<{ limited: boolean }>;
  streamResets: number;
  redialCount?: number;
  egressNoReservationCount?: number;
  lastRedialReason?: string;
  reservationTTL?: number;
  peers?: Array<{ id: string; circuits: number }>;
}

interface TransportHealthResponse {
  transport: TransportHealth;
}

interface RedialRateWindow {
  timestamps: number[];
}

const redialRateWindow: RedialRateWindow = { timestamps: [] };
const RATE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const RATE_THRESHOLD_PER_MIN = 1; // redials/min

function checkRedialRateDegradation(redialCount: number): { degraded: boolean; reason?: string } {
  const now = Date.now();
  // Remove timestamps older than the window
  redialRateWindow.timestamps = redialRateWindow.timestamps.filter(
    (ts) => now - ts < RATE_WINDOW_MS
  );
  // Add the current redial count as a sample
  redialRateWindow.timestamps.push(now);

  if (redialRateWindow.timestamps.length < 2) {
    return { degraded: false };
  }

  // Calculate rate: redials in the window / window duration in minutes
  const windowDurationMinutes = RATE_WINDOW_MS / (60 * 1000);
  const rate = redialRateWindow.timestamps.length / windowDurationMinutes;

  if (rate > RATE_THRESHOLD_PER_MIN) {
    return {
      degraded: true,
      reason: `redial rate ${rate.toFixed(2)}/min sustained over ~5min (threshold: ${RATE_THRESHOLD_PER_MIN}/min)`,
    };
  }

  return { degraded: false };
}

export async function resolveTransportHealthObserver(pointer: {
  shape: string;
  [key: string]: unknown;
}): Promise<ResolverResult> {
  let degraded = false;
  let reason = "";
  let transportData: TransportHealth = {
    activeReservations: 0,
    connections: [],
    streamResets: 0,
  };

  try {
    const transportEndpoint = process.env["TRANSPORT_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8401";
    const res = await fetch(`${transportEndpoint}/health`);
    const data = (await res.json()) as TransportHealthResponse;
    const transport = data.transport;
    transportData = transport;

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

    // Check delta-rate degradation: redialCount rate or egressNoReservationCount without redials
    const redialCount = transport.redialCount ?? 0;
    const egressNoReservationCount = transport.egressNoReservationCount ?? 0;

    if (redialCount > 0) {
      const rateCheck = checkRedialRateDegradation(redialCount);
      if (rateCheck.degraded) {
        degraded = true;
        reason = rateCheck.reason ?? "redial rate exceeded";
      }
    }

    // egressNoReservationCount climbing without corresponding redials
    if (egressNoReservationCount > 0 && redialCount === 0) {
      degraded = true;
      reason = `egressNoReservationCount=${egressNoReservationCount} without redials`;
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
        counters: {
          redialCount: transportData.redialCount ?? 0,
          egressNoReservationCount: transportData.egressNoReservationCount ?? 0,
        },
        lastRedialReason: transportData.lastRedialReason,
      },
    };
  }

  return {
    shape: "ok",
    body: {
      status: "transport healthy",
      redialCount: transportData.redialCount ?? 0,
      egressNoReservationCount: transportData.egressNoReservationCount ?? 0,
      lastRedialReason: transportData.lastRedialReason,
      reservationTTL: transportData.reservationTTL,
      peers: transportData.peers ?? [],
    },
  };
}
