// self_interference_scan v0 skeleton: counts self-interference incidents from durable evidence (scan wired next).
import type { ResolverResult } from "./types.js";

export interface SelfInterferenceScanPointer {
  type: "self_interference_scan";
  max_incidents?: number;
}

export async function resolveSelfInterferenceScan(pointer: SelfInterferenceScanPointer): Promise<ResolverResult> {
  const cap = typeof pointer.max_incidents === "number" ? pointer.max_incidents : 10;
  const incidents: Array<{ kind: string; id: string; detail: string }> = [];
  let interrupted = 0;
  try {
    const recs = JSON.parse(await Bun.file("/workspace/goal-host-dispatches.json").text()) as Array<{ dispatchId?: string; error?: string }>;
    for (const r of recs) {
      if (typeof r?.error === "string" && r.error.startsWith("interrupted: goal-host restarted")) { interrupted += 1; if (incidents.length < cap) incidents.push({ kind: "interrupted_dispatch", id: String(r.dispatchId ?? ""), detail: r.error.slice(0, 120) }); }
    }
  } catch { }
  let busyCount = 0;
  try {
    const lines = (await Bun.file("/workspace/proposals/busy-refusals.jsonl").text()).split("\n").filter((l) => l.trim().length > 0);
    busyCount = lines.length;
    for (const l of lines.slice(-cap)) { if (incidents.length < cap * 2) incidents.push({ kind: "compose_busy_refusal", id: "", detail: l.slice(0, 120) }); }
  } catch { }
  return { shape: "selfInterferenceReport", body: { interrupted_dispatches: interrupted, compose_busy_refusals: busyCount, incidents, scanned: true, max_incidents: cap } };
}
