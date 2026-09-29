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
import { VESSEL_ID } from "../config.js";

export interface UiWritePointer {
  type: "uiPanel_write" | "uiQuestion_write";
  /** Set when another node's passthrough forwarded this write here; it is then delivered locally. */
  forwarded_from?: string;
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
/**
 * WHICH SURFACE A PERSON READS is a fact about humans, so it is a shaped record read at use time, not a
 * constant (law 1): the newest open poolImpulse of shape `humanAskRoute` ({prefer_vessel_ids}) on any
 * poolImpulse producer. The user reads node 1's surface (2026-09-29); node 2 reaches it only through
 * node 1's development-vessel, which this record can name. No record: empty list, today's order.
 */
async function preferredAskVesselIds(discovery: string): Promise<string[]> {
  try {
    const dr = await fetch(`${discovery}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${process.env["METABOB_API_KEY"] ?? ""}` },
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "poolImpulse" } }),
      signal: AbortSignal.timeout(3000),
    });
    if (!dr.ok) return [];
    const producers = ((await dr.json()) as { content?: { vessels?: Array<{ endpoint?: string; resolve_endpoint?: string }> } }).content?.vessels ?? [];
    let newest: { updated_at?: string; body?: { prefer_vessel_ids?: unknown } } | null = null;
    for (const p of producers) {
      const re = String(p.resolve_endpoint ?? "");
      const url = /^https?:\/\//.test(re) ? re : (p.endpoint ? String(p.endpoint).replace(/\/+$/, "") + (re || "/resolve") : "");
      if (!url) continue;
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `ApiKey ${process.env["METABOB_API_KEY"] ?? ""}` },
          body: JSON.stringify({ impulse: { type: "poolImpulse", shape: "humanAskRoute", status: "open" } }),
          signal: AbortSignal.timeout(3000),
        });
        if (!r.ok) continue;
        const imps = ((await r.json()) as { body?: { impulses?: Array<{ shape?: string; updated_at?: string; body?: { prefer_vessel_ids?: unknown } }> } }).body?.impulses ?? [];
        for (const imp of imps) {
          if (imp.shape === "humanAskRoute" && (!newest || String(imp.updated_at ?? "") > String(newest.updated_at ?? ""))) newest = imp;
        }
      } catch { /* one producer unreachable: others may answer */ }
    }
    const ids = newest?.body?.prefer_vessel_ids;
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  } catch { return []; }
}

export async function resolveUiWriteTarget(shape: string, forwarded = false): Promise<string[]> {
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
      // A forwarded write is delivered locally, never forwarded again; this vessel is never a target.
      const preferred = forwarded ? [] : await preferredAskVesselIds(discovery);
      const rank = (v: { vesselId?: string }): number => {
        const id = String(v.vesselId ?? "");
        const p = preferred.indexOf(id);
        if (p >= 0) return p;
        return preferred.length + (id.startsWith("human-surface") ? 0 : 1);
      };
      const ranked = vessels
        .filter((v) => {
          const id = String(v.vesselId ?? "");
          if (id === VESSEL_ID) return false;
          // Another node's development-vessel is a hop only when the ask route names it.
          return !id.startsWith("development-vessel") || preferred.includes(id);
        })
        .sort((a, b) => rank(a) - rank(b));
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
  const targets = await resolveUiWriteTarget(pointer.type, !!pointer.forwarded_from);
  // Mark a write we hand to another node so its passthrough delivers it there and does not forward it.
  const outgoing = pointer.forwarded_from ? pointer : { ...pointer, forwarded_from: VESSEL_ID };
  let res: Response | null = null;
  let lastError = "";
  for (const url of targets) {
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `ApiKey ${process.env["METABOB_API_KEY"] ?? ""}` },
        body: JSON.stringify({ impulse: { pointer: outgoing } }),
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
