const IMPULSE_ENDPOINT = "http://127.0.0.1:8090/v2/impulses/resolve";

interface RhythmBody {
  axis: string;
  axis_code: string;
  family: string;
  budget: number;
  alpha: number;
  beta: number;
  staleness: number;
}

interface Rhythm {
  id: string;
  body: RhythmBody;
}

interface RhythmRealitySyncPointer {
  type: "rhythm_reality_sync";
}

async function fetchWithTimeout(body: unknown, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(IMPULSE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveRhythmRealitySync(
  _pointer: RhythmRealitySyncPointer,
): Promise<{
  shape: "rhythmRealitySyncReport";
  body: {
    open_gap_count: number;
    updated: Array<{ id: string; family: string; old_staleness: number; new_staleness: number }>;
    considered: number;
  };
}> {
  // (1) Read rhythm registry
  let rhythms: Rhythm[] = [];
  try {
    const res = await fetchWithTimeout(
      { impulse: { type: "poolImpulse", shape: "timeShapedRhythm", limit: 50 } },
      800,
    );
    if (res.ok) {
      const data = (await res.json()) as { body?: { items?: Rhythm[] } | Rhythm[] };
      const items =
        Array.isArray(data) ? data :
        Array.isArray((data as { body?: { impulses?: Rhythm[] } }).body?.impulses) ? (data as { body: { impulses: Rhythm[] } }).body.impulses :
        Array.isArray((data as { body?: { items?: Rhythm[] } }).body?.items) ? (data as { body: { items: Rhythm[] } }).body.items :
        [];
      rhythms = items as Rhythm[];
    }
  } catch {
    // degrade to empty
  }

  // (2) Read open gap count
  let openGapCount = 0;
  try {
    const res = await fetchWithTimeout(
      { impulse: { type: "gap_lifecycle_scan" } },
      2000,
    );
    if (res.ok) {
      const data = (await res.json()) as { body?: { open?: number } };
      openGapCount = typeof data?.body?.open === "number" ? data.body.open : 0;
    }
  } catch {
    openGapCount = 0;
  }

  // (3) Recompute staleness for gap-closing family only
  const updated: Array<{ id: string; family: string; old_staleness: number; new_staleness: number }> = [];

  for (const rhythm of rhythms) {
    if (rhythm.body.family === "gap-closing") {
      const old_staleness = rhythm.body.staleness;
      const cadenceResult = await (async () => {
        const { resolvePoolImpulse } = await import('./pool-impulse.js');
        return resolvePoolImpulse({ type: 'poolImpulse', shape: 'gapClosingCadence', limit: 1, status: 'open' });
      })();
      const cadenceImpulses = (cadenceResult.body as { impulses?: Array<{ payload?: { target_backlog?: unknown } }> }).impulses;
      const cadenceFirst = cadenceImpulses?.[0];
      const cadenceTb = cadenceFirst?.payload?.target_backlog;
      const targetBacklog = (typeof cadenceTb === 'number' && cadenceTb > 0) ? cadenceTb : 400;
      const new_staleness = Math.min(1, openGapCount / targetBacklog);
      if (old_staleness !== new_staleness) {
        // (4) Write back via poolImpulse_write
        try {
          await fetchWithTimeout(
            {
              impulse: {
                type: "poolImpulse_write",
                id: rhythm.id,
                shape: "timeShapedRhythm",
                source: "rhythm-reality-sync",
                body: { ...rhythm.body, staleness: new_staleness },
              },
            },
            800,
          );
        } catch {
          // best-effort; still record the update
        }
        updated.push({ id: rhythm.id, family: rhythm.body.family, old_staleness, new_staleness });
      }
    }
    // family "reality-modeling" and all others: leave staleness unchanged
  }

  // (5) Return report
  return {
    shape: "rhythmRealitySyncReport",
    body: {
      open_gap_count: openGapCount,
      updated,
      considered: rhythms.length,
    },
  };
}
