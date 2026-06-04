/**
 * dispatch_latest_auto_draft — Break 2 close (2026-06-04).
 *
 * 6+ `gap-closing:auto-*` templates accumulate in the registry with zero
 * executions because boredom's rotation doesn't include a "dispatch the
 * newest unexecuted auto-draft" goal and Thompson sampling skips templates
 * with no posterior.
 *
 * This resolver:
 *   1. Lists auto-* templates from activity-api (filtered server-side via
 *      ?q=gap-closing).
 *   2. Lists recent execution traces and computes the set of template ids
 *      already exercised.
 *   3. Picks the newest unexecuted auto-* template (by id-suffix timestamp).
 *   4. POSTs to light-dispatch /dispatch fire-and-forget so the trace lands
 *      and the Thompson posterior gets seeded.
 *
 * No LLM. Deterministic. Idempotent on already-dispatched templates (skips).
 */

import type { ResolverResult } from "./types.js";

const ACTIVITY_API = process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
const LIGHT_DISPATCH = process.env["LIGHT_DISPATCH_ENDPOINT"] ?? "http://127.0.0.1:8280";
const API_KEY = process.env["METABOB_API_KEY"] ?? "";

export interface DispatchLatestAutoDraftPointer {
  type: "dispatch_latest_auto_draft";
  templates_limit?: number;
  traces_limit?: number;
  dry_run?: boolean;
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) h["Authorization"] = `ApiKey ${API_KEY}`;
  return h;
}

function unwrapId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const m = id.match(/^activity:⟨(.+)⟩$/);
  return m ? m[1]! : id;
}

function autoTimestamp(id: string): number {
  // gap-closing:auto-<ts>-<slug>-<ts2> ⇒ use the trailing or leading ts.
  const matches = id.match(/(\d{13})/g);
  if (!matches || matches.length === 0) return 0;
  return parseInt(matches[matches.length - 1]!, 10);
}

export async function resolveDispatchLatestAutoDraft(
  pointer: DispatchLatestAutoDraftPointer,
): Promise<ResolverResult> {
  const tplLimit = pointer.templates_limit ?? 60;
  const traceLimit = pointer.traces_limit ?? 200;
  const dryRun = pointer.dry_run === true;

  // 1. Templates.
  let templates: Array<{ id: string }> = [];
  try {
    const r = await fetch(
      `${ACTIVITY_API}/v2/activities/templates?q=gap-closing&limit=${tplLimit}`,
      { headers: authHeaders(), signal: AbortSignal.timeout(10_000) },
    );
    if (r.ok) {
      const j = (await r.json()) as { templates?: Array<{ id?: unknown }> };
      for (const t of j.templates ?? []) {
        const id = unwrapId(t.id);
        if (id && id.startsWith("gap-closing:auto-")) templates.push({ id });
      }
    }
  } catch (err) {
    return { shape: "autoDraftDispatchResult", body: { error: `templates fetch failed: ${(err as Error).message}` } };
  }

  // 2. Recent trace template ids.
  const executed = new Set<string>();
  try {
    const r = await fetch(
      `${ACTIVITY_API}/v2/activities/execution-traces?limit=${traceLimit}`,
      { headers: authHeaders(), signal: AbortSignal.timeout(10_000) },
    );
    if (r.ok) {
      const j = (await r.json()) as { executions?: Array<Record<string, unknown>>; traces?: Array<Record<string, unknown>> };
      const arr = j.executions ?? j.traces ?? [];
      for (const t of arr) {
        const tid = unwrapId(t["activity_id"] ?? t["template_id"] ?? t["activity_template_id"]);
        if (tid) executed.add(tid);
      }
    }
  } catch { /* degrade — treat as no exec history */ }

  // 3. Unexecuted candidates, newest first.
  const candidates = templates
    .filter((t) => !executed.has(t.id))
    .sort((a, b) => autoTimestamp(b.id) - autoTimestamp(a.id));

  if (candidates.length === 0) {
    return {
      shape: "autoDraftDispatchResult",
      body: {
        auto_templates_total: templates.length,
        executed_set_size: executed.size,
        unexecuted_count: 0,
        dispatched: null,
        note: "no unexecuted auto-* templates",
      },
    };
  }

  const picked = candidates[0]!;
  if (dryRun) {
    return {
      shape: "autoDraftDispatchResult",
      body: {
        auto_templates_total: templates.length,
        unexecuted_count: candidates.length,
        dispatched: null,
        would_dispatch: picked.id,
        dry_run: true,
      },
    };
  }

  // 4. Light-dispatch.
  let dispatchStatus: number | "error" = "error";
  let dispatchBody: string = "";
  try {
    const r = await fetch(`${LIGHT_DISPATCH}/dispatch`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        template_id: picked.id,
        variables: { source: "dispatch_latest_auto_draft" },
        tags: ["intent:auto_draft_seed", "boredom_source", `auto_draft:${picked.id}`],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    dispatchStatus = r.status;
    dispatchBody = (await r.text()).slice(0, 400);
  } catch (err) {
    dispatchBody = (err as Error).message;
  }

  return {
    shape: "autoDraftDispatchResult",
    body: {
      auto_templates_total: templates.length,
      unexecuted_count: candidates.length,
      dispatched: picked.id,
      dispatch_status: dispatchStatus,
      dispatch_response: dispatchBody,
      completed_at: new Date().toISOString(),
    },
  };
}
