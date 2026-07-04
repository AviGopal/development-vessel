/**
 * project_plan — Project-thread planner: reads a #project Obsidian note (via discovery, probing which vault peer actually holds the note path), parses its ## To do checkboxes into work items, classifies each item by resolver class (substrate_authorable | obsidian_feature | human_or_llm_question), and emits a projectPlanReport with peer_routing evidence. Dry-run by default; no vault writes..
 * Input shapes (closure linkage): obsidian:note
 * Output shape: projectPlanReport
 */

import { DISCOVERY_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

export interface ProjectPlanPointer {
  type: "project_plan";
  [key: string]: unknown;
}

export async function resolveProjectPlan(pointer: ProjectPlanPointer): Promise<ResolverResult> {
  const notePath = String(pointer["note_path"] ?? "");
  if (!notePath) return { shape: "projectPlanReport", body: { error: "note_path_required" } };
  const peer_routing: Array<{ vessel_id: string; has_note: boolean }> = [];
  let content = "";
  try {
    const dres = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "obsidian:note" } }),
    });
    const data = (await dres.json()) as { content?: { vessels?: Array<{ vessel_id?: string; endpoint?: string; resolve_endpoint?: string }> }; vessels?: Array<{ vessel_id?: string; endpoint?: string; resolve_endpoint?: string }> };
    const vessels = data.content?.vessels ?? data.vessels ?? [];
    for (const v of vessels) {
      const base = (v.endpoint ?? "").replace(/\/$/, "");
      const route = v.resolve_endpoint ?? "/resolve";
      const url = route.startsWith("http") ? route : `${base}${route.startsWith("/") ? route : `/${route}`}`;
      const vid = String(v.vessel_id ?? url);
      try {
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "obsidian:note", pointer: { type: "obsidian:note", path: notePath } }), signal: AbortSignal.timeout(8000) });
        const j = (await res.json()) as { success?: boolean; content?: string };
        const ok = j.success === true && typeof j.content === "string";
        peer_routing.push({ vessel_id: vid, has_note: ok });
        if (ok && !content) content = j.content ?? "";
      } catch { peer_routing.push({ vessel_id: vid, has_note: false }); }
    }
  } catch { /* discovery unreachable: report empty routing */ }
  const todoSection = /## To do[\s\S]*?(?=\n## |$)/.exec(content)?.[0] ?? "";
  const items = [...todoSection.matchAll(/^- \[( |x)\] (.+)$/gm)].map((m) => {
    const text = (m[2] ?? "").trim();
    const lower = text.toLowerCase();
    const cls = /(format|css|style)/.test(lower) ? "obsidian_feature" : text.endsWith("?") ? "human_or_llm_question" : "substrate_authorable";
    return { text, checked: m[1] === "x", class: cls };
  });
  const plan_actions = items.filter((it) => !it.checked).map((it) => {
    if (it.class === "human_or_llm_question") {
      return { action: "solicit_human", item: it.text, delivery: "discussion_entry", note_path: notePath };
    }
    if (it.class === "obsidian_feature") {
      return { action: "dispatch_goal", item: it.text, goal: `Implement in repos/obsidian-vessel: ${it.text}` };
    }
    return { action: "dispatch_goal", item: it.text, goal: `Author via the substrate loop: ${it.text}` };
  });
  return { shape: "projectPlanReport", body: { note_path: notePath, peer_routing, items, dry_run: true, plan_actions } };
}
