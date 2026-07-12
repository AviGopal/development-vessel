import type { ResolverResult } from "./types.js";
import { DISCOVERY_ENDPOINT, METABOB_API_KEY } from "../config.js";
import { resolveSubstrateGap, resolveSubstrateGapWrite } from "./substrate-gap.js";

export async function resolveDocsDecisionAnswerScan(pointer: {
  type: string;
  dry_run?: boolean;
  limit?: number;
}): Promise<ResolverResult> {
  const dry_run = pointer.dry_run ?? false;
  const limit = pointer.limit ?? 50;

  // (1) Discover vault URLs
  let vaultUrls: string[] = [];
  try {
    const discRes = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "obsidian:note" } }),
      signal: AbortSignal.timeout(8000),
    });
    if (discRes.ok) {
      const discData = (await discRes.json()) as Record<string, unknown>;
      const vessels: unknown[] =
        ((discData["content"] as Record<string, unknown> | undefined)?.["vessels"] as unknown[] | undefined) ??
        (discData["vessels"] as unknown[] | undefined) ??
        [];
      for (const v of vessels) {
        const vessel = v as Record<string, unknown>;
        const endpoint = (vessel["endpoint"] as string | undefined) ?? "";
        const base = endpoint.replace(/\/$/, "");
        const route = (vessel["resolve_endpoint"] as string | undefined) ?? "/resolve";
        const url = route.startsWith("http") ? route : base + route;
        if (url) vaultUrls.push(url);
      }
    }
  } catch {
    // discovery failure is non-fatal; proceed with empty vault list
  }

  let notes_considered = 0;
  let decided = 0;
  let gaps_updated = 0;
  const seenPaths = new Set<string>();

  for (const vaultUrl of vaultUrls) {
    // (2) List notes in Substrate/Decisions
    let paths: string[] = [];
    try {
      const listRes = await fetch(vaultUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "obsidian:list_notes",
          pointer: { type: "obsidian:list_notes", folder: "Substrate/Decisions" },
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (listRes.ok) {
        const listData = (await listRes.json()) as Record<string, unknown>;
        const content = listData["content"];
        let parsed: Record<string, unknown> | null = null;
        if (typeof content === "string") {
          try { parsed = JSON.parse(content) as Record<string, unknown>; } catch { parsed = null; }
        } else if (content !== null && typeof content === "object") {
          parsed = content as Record<string, unknown>;
        }
        const rawPaths = parsed?.["paths"];
        if (Array.isArray(rawPaths)) {
          paths = rawPaths.filter((p): p is string => typeof p === "string");
        }
      }
    } catch {
      continue;
    }

    // (3) For each .md path up to limit, deduped across vaults
    for (const notePath of paths) {
      if (!notePath.endsWith(".md")) continue;
      if (seenPaths.has(notePath)) continue;
      if (notes_considered >= limit) break;
      seenPaths.add(notePath);
      notes_considered++;

      try {
        const noteRes = await fetch(vaultUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "obsidian:note",
            pointer: { type: "obsidian:note", path: notePath },
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (!noteRes.ok) continue;
        const noteData = (await noteRes.json()) as Record<string, unknown>;
        if (!noteData["success"]) continue;
        const originalContent = (noteData["content"] as string | undefined) ?? "";

        // (4) Extract decision text after "## Decision"
        const lines = originalContent.split("\n");
        const decisionIdx = lines.findIndex((l) => l.trim() === "## Decision");
        if (decisionIdx === -1) continue;
        const decisionLines = lines
          .slice(decisionIdx + 1)
          .filter((l) => !l.startsWith("_") && l.trim() !== "");
        const decisionText = decisionLines.join("\n").trim();
        if (!decisionText) continue;

        // Derive IDs from filename
        const filename = notePath.split("/").pop() ?? notePath;
        const panel_id = filename.replace(/\.md$/, "");
        const gap_id = panel_id.replace(/^docs-decision-/, "");

        decided++;

        // (5) Apply decision when not dry_run
        if (!dry_run) {
          // (5a) Read gap and upsert with human_decision
          try {
            const gapResult = await resolveSubstrateGap({ type: "substrateGap", id: gap_id, limit: 1 });
            const gapBody = gapResult.body as Record<string, unknown> | undefined;
            const gaps: unknown[] = Array.isArray(gapBody?.["gaps"]) ? (gapBody!["gaps"] as unknown[]) : [];
            const existingGap = (gaps[0] ?? {}) as Record<string, unknown>;
            const existingMeta = (existingGap["classification_metadata"] as Record<string, unknown> | undefined) ?? {};
            await resolveSubstrateGapWrite({
              type: "substrateGap_write",
              gap: {
                id: gap_id,
                category: existingGap["category"],
                source: existingGap["source"],
                summary: existingGap["summary"],
                detected_at: existingGap["detected_at"],
                classification_metadata: {
                  ...existingMeta,
                  human_decision: decisionText,
                  human_decided_at: new Date().toISOString(),
                  awaiting_human: false,
                },
                status: "open",
              },
            });
            gaps_updated++;
          } catch {
            // gap upsert failure is non-fatal
          }

          // (5b) POST feedback to UI
          try {
            const uiEndpoint =
              process.env["STATEFUL_UI_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8270";
            await fetch(`${uiEndpoint}/api/feedback`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ panelId: panel_id, kind: "answer", text: decisionText }),
              signal: AbortSignal.timeout(8000),
            });
          } catch {
            // UI feedback failure is non-fatal
          }

          // (5c) Mark note processed
          try {
            let newContent: string;
            if (originalContent.includes("status: awaiting-decision")) {
              newContent = originalContent.replace("status: awaiting-decision", "status: decided");
            } else {
              newContent = originalContent + "\n\n_status: decided_";
            }
            await fetch(vaultUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                type: "obsidian:write_note",
                pointer: { type: "obsidian:write_note", path: notePath, content: newContent },
              }),
              signal: AbortSignal.timeout(8000),
            });
          } catch {
            // write-back failure is non-fatal
          }
        }
      } catch {
        // per-note failure must not abort the pass
      }
    }
  }

  return {
    shape: "docsDecisionAnswerScanReport",
    body: { notes_considered, decided, gaps_updated, dry_run },
  };
}
