import type { ResolverResult } from "./types.js";
import { DISCOVERY_ENDPOINT } from "../config.js";

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

async function discoverOwnerUrl(shape: string): Promise<string | null> {
  try {
    const res = await fetch(`${DISCOVERY_ENDPOINT}/lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shape }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { endpoint?: string; vesselCapability?: { endpoint?: string } };
    return data.vesselCapability?.endpoint ?? data.endpoint ?? null;
  } catch {
    return null;
  }
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

  const ownerUrl = await discoverOwnerUrl("obsidian:write_note");

  let delivered = 0;
  let skipped_existing = 0;
  let unreachable = 0;

  for (const panel of selected) {
    try {
      const path = `Substrate/Decisions/${panel.id}.md`;

      if (ownerUrl) {
        try {
          const readRes = await fetch(`${ownerUrl}/impulse`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "obsidian:note", path }),
          });
          if (readRes.ok) {
            const readBody = (await readRes.json()) as { body?: { exists?: boolean; content?: string } };
            const exists =
              readBody.body?.exists === true ||
              (typeof readBody.body?.content === "string" && readBody.body.content.length > 0);
            if (exists) {
              skipped_existing++;
              continue;
            }
          }
        } catch {
          // read failure — treat as not-existing, attempt write
        }
      }

      if (!dry_run) {
        const gapId = panel.id.replace(/^docs-decision-/, "");
        const title = panel.title ?? panel.id;
        const body = panel.body ?? "";
        const content = [
          `---`,
          `panel_id: ${panel.id}`,
          `gap_id: ${gapId}`,
          `status: awaiting-decision`,
          `---`,
          `# ${title}`,
          body,
          `## Decision`,
          `_Write your decision below; the substrate reads this section back and applies it._`,
        ].join("\n");

        if (ownerUrl) {
          const writeRes = await fetch(`${ownerUrl}/impulse`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "obsidian:write_note", path, content }),
          });
          if (!writeRes.ok) {
            unreachable++;
            continue;
          }
        } else {
          unreachable++;
          continue;
        }
      }

      delivered++;
    } catch {
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
