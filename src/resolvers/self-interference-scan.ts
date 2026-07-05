// self_interference_scan: detects self-interference stuck states from durable evidence — interrupted dispatches, compose BUSY refusals, same-error rollback streaks per vessel, re-landing storms, and abandoned approach decisions; files one substrateGap per distinct incident kind when emit_gap is set.
import type { ResolverResult } from "./types.js";
import { readdir, readFile, unlink } from "node:fs/promises";
import { resolveSubstrateGapWrite } from "./substrate-gap.js";

export interface SelfInterferenceScanPointer {
  type: "self_interference_scan";
  max_incidents?: number;
  emit_gap?: boolean;
  window_hours?: number;
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
  let rollbackStreaks = 0;
  let relandingStorms = 0;
  let abandonedDecisions = 0;
  const windowHours = typeof pointer.window_hours === "number" ? pointer.window_hours : 24;
  void windowHours;
  const composeReports: Array<{ vessel: string; verdict: string; at?: string; failure_class?: string; first_error?: string; gap_id?: string }> = [];
  try {
    const names = await readdir("/workspace/proposals");
    for (const name of names) {
      if (!name.endsWith("-compose-report.json")) continue;
      try {
        const rep = JSON.parse(await Bun.file(`/workspace/proposals/${name}`).text()) as { touched_vessels?: string[]; verdict?: string; at?: string; completed?: string; failure_class?: string; gap_id?: string; verify?: Array<{ output?: string }> };
        const vessel = Array.isArray(rep.touched_vessels) && rep.touched_vessels.length > 0 ? String(rep.touched_vessels[0]) : "unknown";
        const firstOutput = Array.isArray(rep.verify) && rep.verify.length > 0 && typeof rep.verify[0]?.output === "string" ? rep.verify[0].output : undefined;
        const firstError = typeof firstOutput === "string" ? firstOutput.split("\n")[0] : undefined;
        composeReports.push({ vessel, verdict: String(rep.verdict ?? ""), at: rep.at ?? rep.completed, failure_class: rep.failure_class, first_error: firstError, gap_id: rep.gap_id });
      } catch { }
    }
    const unfavByVessel = new Map<string, Array<{ first_error?: string }>>();
    for (const r of composeReports) {
      if (r.verdict !== "UNFAVORABLE") continue;
      const arr = unfavByVessel.get(r.vessel) ?? [];
      arr.push({ first_error: r.first_error });
      unfavByVessel.set(r.vessel, arr);
    }
    for (const [vessel, arr] of unfavByVessel) {
      const counts = new Map<string, number>();
      for (const e of arr) {
        const key = e.first_error ?? "";
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      for (const [line, n] of counts) {
        if (n >= 3 && line.length > 0) {
          rollbackStreaks += 1;
          if (incidents.length < cap * 3) incidents.push({ kind: "rollback_streak", id: vessel, detail: line.slice(0, 120) });
        }
      }
    }
  } catch { }
  let gaps: Array<{ id?: string; summary?: string; classification_metadata?: { resolution_commits?: unknown[]; approach_decisions?: Array<{ outcome?: unknown; at?: string }> } }> = [];
  try {
    gaps = JSON.parse(await Bun.file("/workspace/gaps/gaps.json").text()) as typeof gaps;
    for (const g of gaps) {
      const commits = g.classification_metadata?.resolution_commits;
      const summary = typeof g.summary === "string" ? g.summary : "";
      if ((Array.isArray(commits) && commits.length >= 3) || summary.includes("re-landed")) {
        relandingStorms += 1;
        if (incidents.length < cap * 3) incidents.push({ kind: "relanding_storm", id: String(g.id ?? ""), detail: summary.slice(0, 120) });
      }
    }
    const favByGap = new Map<string, number>();
    for (const r of composeReports) {
      if (r.verdict !== "FAVORABLE" || !r.gap_id) continue;
      favByGap.set(r.gap_id, (favByGap.get(r.gap_id) ?? 0) + 1);
    }
    for (const [gid, n] of favByGap) {
      if (n >= 3) {
        relandingStorms += 1;
        if (incidents.length < cap * 3) incidents.push({ kind: "relanding_storm", id: gid, detail: `favorable_recompose_count=${n}` });
      }
    }
  } catch { }
  try {
    const now = Date.now();
    for (const g of gaps) {
      const decisions = g.classification_metadata?.approach_decisions;
      if (!Array.isArray(decisions)) continue;
      for (const d of decisions) {
        if (d && typeof d === "object" && !("outcome" in d) && typeof d.at === "string") {
          const t = Date.parse(d.at);
          if (!Number.isNaN(t) && now - t > 6 * 3600 * 1000) {
            abandonedDecisions += 1;
            if (incidents.length < cap * 3) incidents.push({ kind: "abandoned_decision", id: String(g.id ?? ""), detail: d.at });
          }
        }
      }
    }
  } catch { }
  let killedRuns = 0;
  try {
    const markerDir = '/workspace/authoring-inflight';
    let entries: string[] = [];
    try { entries = await readdir(markerDir); } catch { }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const raw = await readFile(`${markerDir}/${entry}`, 'utf8');
        const m = JSON.parse(raw);
        const pid = typeof m.pid === 'number' ? m.pid : 0;
        const resolver = m.resolver;
        const target_file = m.target_file;
        const started_at = m.started_at;
        let dead = false;
        if (pid > 0) {
          try { process.kill(pid, 0); } catch { dead = true; }
        }
        if (dead) {
          killedRuns += 1;
          if (incidents.length < cap * 3) incidents.push({ kind: 'killed_authoring_run', id: entry, detail: (resolver + ' on ' + target_file + ' started ' + started_at + ' pid ' + pid + ' dead; marker ' + markerDir + '/' + entry).slice(0, 200) });
          try { await unlink(`${markerDir}/${entry}`); } catch { }
        }
      } catch { }
    }
  } catch { }
  if (pointer.emit_gap) {
    const seen = new Set<string>();
    for (const inc of incidents) {
      if (seen.has(inc.kind)) continue;
      seen.add(inc.kind);
      try {
        await resolveSubstrateGapWrite({
          type: "substrateGap_write",
          gap: {
            id: `self-interference-${inc.kind}-${inc.id}`,
            category: "systematic_failure",
            source: "substrate_detected",
            summary: `${inc.kind} for ${inc.id}: ${inc.detail}`,
            detected_at: new Date().toISOString(),
            status: "open",
            classification_metadata: { incident_kind: inc.kind, detail: inc.detail },
          },
        } as never);
      } catch { }
    }
  }
  return { shape: "selfInterferenceReport", body: { interrupted_dispatches: interrupted, compose_busy_refusals: busyCount, rollback_streaks: rollbackStreaks, relanding_storms: relandingStorms, abandoned_decisions: abandonedDecisions, killed_authoring_runs: killedRuns, incidents, scanned: true, max_incidents: cap } };
}
