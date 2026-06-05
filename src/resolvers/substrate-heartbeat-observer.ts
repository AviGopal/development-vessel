import { readFile, stat } from "node:fs/promises";
import type { ResolverResult } from "./types.js";

/**
 * substrate_heartbeat_observer (round 2, 2026-06-05) — promotes the
 * substrate-heartbeat.json file (written by substrate-health-tick on each
 * boredom cadence) into impulse form. The file's freshness is a coarse
 * liveness signal: if it stops updating, boredom is not running. Without an
 * impulse, the substrate cannot detect its own quiescence.
 */

const DEFAULT_PATH = process.env["SUBSTRATE_HEARTBEAT_PATH"] ?? "/workspace/substrate-heartbeat.json";

export interface SubstrateHeartbeatObserverPointer {
  type: "substrate_heartbeat_observer";
  heartbeatPath?: string;
  staleThresholdMs?: number;
}

export async function resolveSubstrateHeartbeatObserver(
  pointer: SubstrateHeartbeatObserverPointer,
): Promise<ResolverResult> {
  const path = pointer.heartbeatPath ?? DEFAULT_PATH;
  const staleMs = pointer.staleThresholdMs ?? 5 * 60 * 1000;

  let st;
  try {
    st = await stat(path);
  } catch {
    return {
      shape: "substrateHeartbeatState",
      body: {
        heartbeat_path: path,
        file_present: false,
        age_seconds: null,
        stale: true,
        last_written_iso: null,
        contents_summary: null,
        parse_error: null,
        stale_threshold_ms: staleMs,
        generated_at: new Date().toISOString(),
      },
    };
  }

  const ageMs = Date.now() - st.mtimeMs;
  const ageSeconds = Math.round(ageMs / 1000);
  const lastWrittenIso = new Date(st.mtimeMs).toISOString();

  let contents: Record<string, unknown> = {};
  let parseError: string | null = null;
  try {
    const raw = await readFile(path, "utf8");
    contents = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    parseError = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
  }

  const summary: Record<string, unknown> = {};
  for (const key of ["ts", "overall_passing", "template_count", "vessels_down"]) {
    if (key in contents) summary[key] = contents[key];
  }

  return {
    shape: "substrateHeartbeatState",
    body: {
      heartbeat_path: path,
      file_present: true,
      age_seconds: ageSeconds,
      stale: ageMs > staleMs,
      last_written_iso: lastWrittenIso,
      contents_summary: summary,
      parse_error: parseError,
      stale_threshold_ms: staleMs,
      generated_at: new Date().toISOString(),
    },
  };
}
