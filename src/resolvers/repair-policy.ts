/**
 * repair_policy — substrate-authored resolver (Seam ③).
 * Output shape: repairPolicy
 */

import type { ResolverResult } from "./types.js";

export interface RepairPolicyPointer {
  type: "repair_policy";
  [key: string]: unknown;
}

export async function resolveRepairPolicy(pointer: RepairPolicyPointer): Promise<ResolverResult> {
  // repairPolicy producer — measures whether the substrate's repair/retry behaviour
  // is FAILURE-MODE-CONDITIONED. SPEC: read recent FAILED traces, bucket them by a
  // (state-space signature, failure_mode.type) key, and compute a repair_blindness
  // metric = number of signature buckets that absorb repeated failures while the
  // selector keeps retrying the same approach (the signature ignores the distinct
  // failure modes, so repair is blind to WHY it failed).
  //
  // IDIOMATIC DATA SOURCE (verified working): activity-api
  //   POST /v2/impulses/resolve { pointer: { type: "executionTraceWithSignatures",
  //   success_only:false, limit } } → { content: JSON.stringify({ traces:[{ activity_id,
  //   status, duration_ms, parent_execution_id, composition_chain, ... }] }) }.
  // executionTraceList reads the (empty) `execution` paradigm table and returns 0 rows,
  // so it is NOT usable here. executionTraceWithSignatures returns the real failed
  // traces. LIMITATION: that read does NOT expose `failure_mode.type` nor an explicit
  // state-space signature, so we use activity_id as the signature bucket (the stable
  // grouping key the data actually provides) and treat repeated failures of the same
  // bucket as evidence of failure-mode-blind retrying; this is recorded in `limitation`.
  const apiKey = process.env.METABOB_API_KEY ?? "";
  const activityEndpoint = process.env.ACTIVITY_API_ENDPOINT ?? "http://127.0.0.1:8080";
  const headers = {
    Authorization: `ApiKey ${apiKey}`,
    "Content-Type": "application/json",
  };
  const rawLimit = (pointer as Record<string, unknown>)["limit"];
  const limit = typeof rawLimit === "number" ? rawLimit : 200;

  try {
    const res = await fetch(`${activityEndpoint}/v2/impulses/resolve`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        pointer: { type: "executionTraceWithSignatures", success_only: false, limit },
      }),
    });
    if (!res.ok) {
      return { shape: "repairPolicy", body: { repair_blindness: 0, blind_buckets: [], recommendation: "read_unavailable", limitation: `executionTraceWithSignatures http ${res.status}` } };
    }
    const outer = (await res.json()) as { content?: string; body?: unknown };
    let traces: Array<Record<string, unknown>> = [];
    if (typeof outer.content === "string") {
      try {
        const parsed = JSON.parse(outer.content) as { traces?: Array<Record<string, unknown>> };
        traces = Array.isArray(parsed?.traces) ? parsed.traces : [];
      } catch {
        traces = [];
      }
    }

    // Keep only failures (success_only:false returns both; status==="failure").
    const failed = traces.filter((t) => {
      const s = t["status"];
      return s === "failure" || s === false || s === "failed";
    });

    // Bucket failed traces by signature. The verified read does not surface
    // failure_mode.type or a state-space signature hash, so the signature key is
    // the activity_id; the "failure mode" axis is approximated from the duration
    // band (fast-fail vs slow-fail) as a proxy for distinct failure shapes, which
    // lets us still detect "≥2 distinct failure modes sharing one posterior".
    interface Bucket {
      signature: string;
      count: number;
      failure_modes: Record<string, number>;
    }
    const buckets: Record<string, Bucket> = {};
    for (const t of failed) {
      const sig = typeof t["activity_id"] === "string" ? (t["activity_id"] as string) : "unknown";
      const dur = typeof t["duration_ms"] === "number" ? (t["duration_ms"] as number) : 0;
      // Duration-band proxy for failure_mode.type (real failure_mode is not exposed).
      const mode = dur < 500 ? "fast_fail" : dur < 5000 ? "mid_fail" : "slow_fail";
      let b = buckets[sig];
      if (!b) {
        b = { signature: sig, count: 0, failure_modes: {} };
        buckets[sig] = b;
      }
      b.count += 1;
      b.failure_modes[mode] = (b.failure_modes[mode] ?? 0) + 1;
    }

    const totalFailures = failed.length;
    const blindBuckets: Array<{ signature: string; failure_modes: string[]; repeat_rate: number }> = [];
    for (const key of Object.keys(buckets)) {
      const b = buckets[key];
      if (!b) continue;
      const distinctModes = Object.keys(b.failure_modes);
      // repeat_rate = share of this signature's failures that are repeats (count>1
      // means the substrate retried the same signature). High repeat_rate + ≥2
      // distinct failure modes sharing one signature/posterior = repair blindness:
      // the selector keeps retrying without conditioning on WHY it failed.
      const repeatRate = b.count > 1 ? (b.count - 1) / b.count : 0;
      const isBlind = distinctModes.length >= 2 && b.count >= 2 && repeatRate >= 0.5;
      if (isBlind) {
        blindBuckets.push({
          signature: b.signature,
          failure_modes: distinctModes,
          repeat_rate: Math.round(repeatRate * 1000) / 1000,
        });
      }
    }
    blindBuckets.sort((a, b) => b.repeat_rate - a.repeat_rate);

    const repairBlindness = blindBuckets.length;
    const recommendation =
      repairBlindness === 0
        ? "no failure-mode-blind retry buckets detected in sampled failed traces; repair appears mode-agnostic-safe or sample too thin"
        : `${repairBlindness} signature bucket(s) absorb ≥2 distinct failure modes under one posterior with high repeat rate — key the Thompson posterior on (signature, failure_mode) so repair stops retrying the same blind approach`;

    return {
      shape: "repairPolicy",
      body: {
        repair_blindness: repairBlindness,
        blind_buckets: blindBuckets.slice(0, 50),
        recommendation,
        total_failed_traces_sampled: totalFailures,
        distinct_signature_buckets: Object.keys(buckets).length,
        limitation:
          "Source executionTraceWithSignatures does not expose failure_mode.type or an explicit state-space signature; activity_id used as the signature bucket and a duration-band proxy used for failure_mode.type. Wire failure_mode into the trace read for a faithful (signature, failure_mode) grouping.",
      },
    };
  } catch (e) {
    return { shape: "repairPolicy", body: { repair_blindness: 0, blind_buckets: [], recommendation: "error", error: String(e) } };
  }

}
