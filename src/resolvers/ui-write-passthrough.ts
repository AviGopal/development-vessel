/**
 * Passthrough resolver for uiPanel_write and uiQuestion_write.
 *
 * Forwards the impulse pointer to stateful-ui-vessel's /resolve endpoint
 * so dev-vessel can advertise the shape via discovery without owning the
 * state. The actual panel store lives in stateful-ui-vessel; this resolver
 * exists so the shape-dispatch lint passes and so any activity that fetches
 * dev-vessel as the resolver for these shapes still produces the same
 * end-state.
 */

import type { ResolverResult } from "./types.js";

export interface UiWritePointer {
  type: "uiPanel_write" | "uiQuestion_write";
  id?: string;
  title?: string;
  body?: string;
  kind?: string;
  importance?: string;
  asks?: unknown[];
}

const STATEFUL_UI_ENDPOINT =
  process.env["STATEFUL_UI_VESSEL_ENDPOINT"] ?? "http://127.0.0.1:8270";

/**
 * ROUTE BY SHAPE (gap 248-escalations-were-asked-of-a-vessel-no-human-reads, 2026-09-29). The pinned
 * default (stateful-ui-vessel :8270) is a vessel no human surface reads, so every needs-human and
 * pending-verify question went unseen and the hopeless-category seal's only escape never reached a
 * person. Discovery already advertises the live surface (human-surface-vessel) for these shapes.
 * Order: human-surface first, other non-development-vessel producers next (development-vessel*
 * advertises these shapes through THIS passthrough, so routing there would loop), pinned endpoint
 * last as the fallback. Resolved per call; failures fall through to the next target.
 */
export async function resolveUiWriteTarget(shape: string): Promise<string[]> {
  const targets: string[] = [];
  // Discovery only when the process was given one: a test run under env -i has none, and must not
  // reach live discovery and post questions onto the live human surface.
  const discovery = process.env["DISCOVERY_ENDPOINT"];
  if (discovery) try {
    const r = await fetch(`${discovery}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${process.env["METABOB_API_KEY"] ?? ""}` },
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape } }),
      signal: AbortSignal.timeout(3000),
    });
    if (r.ok) {
      const vessels = ((await r.json()) as { content?: { vessels?: Array<{ vesselId?: string; endpoint?: string; resolve_endpoint?: string }> } }).content?.vessels ?? [];
      const ranked = vessels
        .filter((v) => !String(v.vesselId ?? "").startsWith("development-vessel"))
        .sort((a, b) => Number(!String(a.vesselId ?? "").startsWith("human-surface")) - Number(!String(b.vesselId ?? "").startsWith("human-surface")));
      for (const v of ranked) {
        const re = String(v.resolve_endpoint ?? "");
        const url = /^https?:\/\//.test(re) ? re : (v.endpoint ? String(v.endpoint).replace(/\/+$/, "") + (re || "/resolve") : "");
        if (url && !targets.includes(url)) targets.push(url);
      }
    }
  } catch { /* discovery unreadable: fall back to the pinned endpoint below */ }
  const pinned = `${STATEFUL_UI_ENDPOINT}/resolve`;
  if (!targets.includes(pinned)) targets.push(pinned);
  return targets;
}

export async function resolveUiWritePassthrough(
  pointer: UiWritePointer,
): Promise<ResolverResult> {
  const targets = await resolveUiWriteTarget(pointer.type);
  let res: Response | null = null;
  let lastError = "";
  for (const url of targets) {
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `ApiKey ${process.env["METABOB_API_KEY"] ?? ""}` },
        body: JSON.stringify({ impulse: { pointer } }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) break;
      lastError = `${url} answered ${res.status}`;
    } catch (err) {
      lastError = `${url}: ${String(err)}`;
      res = null;
    }
  }
  if (!res) {
    return { shape: pointer.type, body: { ok: false, error: `no ui write target accepted: ${lastError}`, tried: targets } };
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    return {
      shape: pointer.type,
      body: { ok: false, error: `stateful-ui-vessel ${res.status}`, detail: parsed },
    };
  }
  return {
    shape: pointer.type,
    body: { ok: true, result: parsed },
  };
}
