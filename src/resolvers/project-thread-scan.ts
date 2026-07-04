/**
 * project_thread_scan — substrate-authored resolver (Seam ③).
 * Output shape: projectThreadScanReport
 */

import { DISCOVERY_ENDPOINT, METABOB_API_KEY } from "../config.js";
import { resolveProjectPlan } from "./project-plan.js";
import type { ResolverResult } from "./types.js";

export interface ProjectThreadScanPointer {
  type: "project_thread_scan";
  [key: string]: unknown;
}

export async function resolveProjectThreadScan(pointer: ProjectThreadScanPointer): Promise<ResolverResult> {
  const folder = String(pointer["folder"] ?? "Substrate/Inbox");
  const query = String(pointer["query"] ?? "project");
  const scanned_peers: Array<{ vessel_id: string; results: number }> = [];
  const paths = new Set<string>();
  try {
    const dres = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "obsidian:search" } }),
    });
    const data = (await dres.json()) as { content?: { vessels?: Array<{ vessel_id?: string; endpoint?: string; resolve_endpoint?: string }> }; vessels?: Array<{ vessel_id?: string; endpoint?: string; resolve_endpoint?: string }> };
    const vessels = data.content?.vessels ?? data.vessels ?? [];
    for (const v of vessels) {
      const base = (v.endpoint ?? "").replace(/\/$/, "");
      const route = v.resolve_endpoint ?? "/resolve";
      const url = route.startsWith("http") ? route : `${base}${route.startsWith("/") ? route : `/${route}`}`;
      const vid = String(v.vessel_id ?? url);
      try {
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "obsidian:search", pointer: { type: "obsidian:search", query, folder, limit: 25 } }), signal: AbortSignal.timeout(8000) });
        const j = (await res.json()) as { success?: boolean; content?: string };
        let count = 0;
        if (j.success === true && typeof j.content === "string") {
          try {
            const rows = JSON.parse(j.content) as Array<{ path?: string }>;
            for (const r of rows) if (typeof r.path === "string" && r.path.startsWith(folder)) { paths.add(r.path); count++; }
          } catch { /* non-JSON search content: skip peer rows */ }
        }
        scanned_peers.push({ vessel_id: vid, results: count });
      } catch { scanned_peers.push({ vessel_id: vid, results: 0 }); }
    }
  } catch { /* discovery unreachable: report empty scan */ }
  const notes: Array<{ note_path: string; items_found: number; open_items: number }> = [];
  for (const note_path of paths) {
    try {
      const plan = await resolveProjectPlan({ type: "project_plan", note_path, dry_run: true });
      const body = plan.body as { items?: Array<{ checked?: boolean }> };
      const items = Array.isArray(body.items) ? body.items : [];
      notes.push({ note_path, items_found: items.length, open_items: items.filter((i) => i.checked !== true).length });
    } catch { notes.push({ note_path, items_found: 0, open_items: 0 }); }
  }
  return { shape: "projectThreadScanReport", body: { folder, query, scanned_peers, notes } };
}
