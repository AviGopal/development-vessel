/**
 * project_plan — Project-thread planner: reads a #project Obsidian note (via discovery, probing which vault peer actually holds the note path), parses its ## To do checkboxes into work items, classifies each item by resolver class (substrate_authorable | obsidian_feature | human_or_llm_question), and emits a projectPlanReport with peer_routing evidence. Dry-run by default; no vault writes..
 * Input shapes (closure linkage): obsidian:note
 * Output shape: projectPlanReport
 */

import { DISCOVERY_ENDPOINT, GOAL_HOST_VESSEL_ENDPOINT, METABOB_API_KEY } from "../config.js";
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
  let ownerUrl = "";
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
        if (ok && !content) { content = j.content ?? ""; ownerUrl = url; }
      } catch { peer_routing.push({ vessel_id: vid, has_note: false }); }
    }
  } catch { /* discovery unreachable: report empty routing */ }
  const todoSection = /## To do[\s\S]*?(?=\n## |$)/.exec(content)?.[0] ?? "";
  const items = [...todoSection.matchAll(/^- \[( |x)\] (.+)$/gm)].map((m) => {
    const text = (m[2] ?? "").trim();
    const lower = text.toLowerCase();
    const cls = /(format|css|style)/.test(lower) ? "obsidian_feature" : text.endsWith("?") ? "human_or_llm_question" : "substrate_authorable";
    return { text, checked: m[1] === "x", dispatched: text.includes("⇒ dispatched"), class: cls };
  });
  const plan_actions = items.filter((it) => !it.checked && !it.dispatched).map((it) => {
    if (it.class === "human_or_llm_question") {
      return { action: "solicit_human", item: it.text, delivery: "discussion_entry", note_path: notePath };
    }
    if (it.class === "obsidian_feature") {
      const target = /(provenance|styling|css|format)/i.test(it.text)
        ? "repos/obsidian-vessel/src/resolvers/write-note-resolver.ts"
        : "repos/obsidian-vessel/src/main.ts";
      return { action: "dispatch_goal", item: it.text, goal: `In ${target}, implement: ${it.text}` };
    }
    return { action: "dispatch_goal", item: it.text, goal: `Author via the substrate loop: ${it.text}` };
  });
  const wet = pointer["dry_run"] === false;
  let noteContent = content;
  const executed: Array<Record<string, unknown>> = [];
  if (wet && ownerUrl && content) {
    const askedRe = /> \[!question\] From the substrate \(project_plan\)\n> ([^\n]*)/g;
    const already = new Set<string>();
    for (const m of noteContent.matchAll(askedRe)) already.add((m[1] || "").trim());
    const asks = plan_actions.filter((a) => a.action === "solicit_human" && !already.has(String(a.item ?? "").trim()));
    if (asks.length > 0) {
      const stamp = new Date().toISOString().slice(0, 10);
      const entries = asks.map((a) => `\n### Query: substrate solicitation (${stamp})\n---\n> [!question] From the substrate (project_plan)\n> ${a.item}\n> Reply below this callout — the system reads this thread.\n`).join("");
      try {
        const wres = await fetch(ownerUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "obsidian:write_note", pointer: { type: "obsidian:write_note", path: notePath, content: noteContent + entries } }), signal: AbortSignal.timeout(8000) });
        const wj = (await wres.json()) as { success?: boolean };
        executed.push({ action: "solicit_human", ok: wj.success === true, count: asks.length });
        noteContent = noteContent + entries;
      } catch (err) { executed.push({ action: "solicit_human", ok: false, error: String(err).slice(0, 120) }); }
    }
    for (const a of plan_actions.filter((x) => x.action === "dispatch_goal")) {
      try {
        const gres = await fetch(`${GOAL_HOST_VESSEL_ENDPOINT}/run-goal`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` }, body: JSON.stringify({ goal: a.goal, tags: ["dispatcher:project_plan", `note:${notePath}`], variables: {} }), signal: AbortSignal.timeout(15000) });
        const gj = (await gres.json()) as { dispatchId?: string; executionId?: string; status?: string };
        executed.push({ action: "dispatch_goal", ok: gres.ok, item: a.item, dispatchId: gj.dispatchId ?? gj.executionId, status: gj.status });
      } catch (err) { executed.push({ action: "dispatch_goal", ok: false, item: a.item, error: String(err).slice(0, 120) }); }
    }
    const before = noteContent;
    for (const e of executed) {
      if (e.ok === true && e.dispatchId && typeof e.item === "string") {
        const marker = " ⇒ dispatched " + String(e.dispatchId).slice(0, 8) + " " + new Date().toISOString().slice(0, 10);
        noteContent = noteContent.split("- [ ] " + e.item).join("- [ ] " + e.item + marker);
      }
    }
    if (noteContent !== before) {
      try {
        const mres = await fetch(ownerUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "obsidian:write_note", pointer: { type: "obsidian:write_note", path: notePath, content: noteContent } }), signal: AbortSignal.timeout(8000) });
        const mj = (await mres.json()) as { success?: boolean };
        executed.push({ action: "mark_dispatched", ok: mj.success === true });
      } catch (err) { executed.push({ action: "mark_dispatched", ok: false, error: String(err).slice(0, 120) }); }
    }
  }
  return { shape: "projectPlanReport", body: { note_path: notePath, peer_routing, items, dry_run: !wet, plan_actions, executed } };
}
