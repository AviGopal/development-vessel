import type { ResolverResult } from "./types.js";
import { DISCOVERY_ENDPOINT, METABOB_API_KEY } from "../config.js";

export interface DocsDecisionDeliverPointer {
  type: "docs_decision_deliver";
  dry_run?: boolean;
  limit?: number;
}

interface Panel {
  id: string;
  title?: string;
  body?: string;
  asks?: unknown;
}

async function discoverOwnerUrls(_capability: string): Promise<string[]> {
  const res = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
    body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "obsidian:write_note" } }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const data = await res.json() as { content?: { vessels?: Array<{ endpoint: string; resolve_endpoint?: string }> }; vessels?: Array<{ endpoint: string; resolve_endpoint?: string }> };
  const vessels: Array<{ endpoint: string; resolve_endpoint?: string }> = data.content?.vessels ?? data.vessels ?? [];
  return vessels.map((v: { endpoint: string; resolve_endpoint?: string }) => {
    const base = v.endpoint.replace(/\/$/, "");
    const route: string = v.resolve_endpoint ?? "/resolve";
    if (route.startsWith("http")) return route;
    return base + (route.startsWith("/") ? route : "/" + route);
  });
}

export async function resolveDocsDecisionDeliver(
  pointer: DocsDecisionDeliverPointer,
): Promise<ResolverResult> {
  const dry_run = pointer.dry_run ?? false;
  const limit = pointer.limit ?? 20;

  const stateEndpoint =
    process.env["STATEFUL_UI_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8270";

  let panels: Panel[] = [];
  try {
    const res = await fetch(`${stateEndpoint}/api/state`);
    if (!res.ok) throw new Error(`state fetch ${res.status}`);
    const json = (await res.json()) as { panels?: unknown };
    const raw = json.panels;
    let arr: unknown[];
    if (Array.isArray(raw)) {
      arr = raw;
    } else if (raw && typeof raw === "object") {
      arr = Object.values(raw as Record<string, unknown>);
    } else {
      arr = [];
    }
    panels = (arr as Panel[]).filter(
      (p) => typeof p.id === "string" && p.id.startsWith("docs-decision-"),
    );
  } catch {
    return {
      shape: "docsDecisionDeliveryReport",
      body: {
        panels_considered: 0,
        delivered: 0,
        skipped_existing: 0,
        unreachable: 1,
        dry_run,
      },
    };
  }

  const selected = panels.slice(0, limit);
  const panels_considered = selected.length;

  const ownerUrls = await discoverOwnerUrls("obsidian:write_note");

  let delivered = 0;
  let skipped_existing = 0;
  let unreachable = 0;

  for (const panel of selected) {
    const path = `Substrate/Decisions/${panel.id}.md`;
    const gapId = panel.id.replace(/^docs-decision-/, "");
    const content = [
      `---`,
      `panel_id: ${panel.id}`,
      `gap_id: ${gapId}`,
      `status: awaiting-decision`,
      `---`,
      `# ${panel.title ?? panel.id}`,
      panel.body ?? "",
      `## Decision`,
      `_Write your decision below; the substrate reads this section back and applies it._`,
    ].join("\n");
    if (dry_run) {
      delivered++;
      continue;
    }
    let responded = 0;
    let wrote = 0;
    const vaultHadNote: boolean[] = [];
    for (const url of ownerUrls) {
      try {
        const readRes = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "obsidian:note", pointer: { type: "obsidian:note", path } }),
          signal: AbortSignal.timeout(8000),
        });
        responded++;
        let hasNote = false;
        if (readRes.ok) {
          const readData = await readRes.json() as { success?: boolean; content?: string };
          hasNote = readData.success === true && typeof readData.content === "string" && readData.content.length > 0;
        }
        if (hasNote) {
          vaultHadNote.push(true);
          continue;
        }
        vaultHadNote.push(false);
        const writeRes = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "obsidian:write_note", pointer: { type: "obsidian:write_note", path, content } }),
          signal: AbortSignal.timeout(8000),
        });
        if (writeRes.ok) {
          wrote++;
        }
      } catch {
        // per-url failure — continue to next vault
      }
    }
    if (wrote >= 1) {
      delivered++;
    } else if (responded >= 1 && wrote === 0 && vaultHadNote.length > 0 && vaultHadNote.every((v: boolean) => v)) {
      skipped_existing++;
    } else if (responded === 0) {
      unreachable++;
    }
  }

  return {
    shape: "docsDecisionDeliveryReport",
    body: {
      panels_considered,
      delivered,
      skipped_existing,
      unreachable,
      dry_run,
    },
  };
}
