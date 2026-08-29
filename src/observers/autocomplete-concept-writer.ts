/**
 * autocomplete-concept-writer — lifecycle observer that closes the substrate's
 * learning-feedback loop by writing concepts back to concept-db when
 * substrate-authored "auto-*" templates execute successfully.
 *
 * Background (observation 2026-06-04, `validation/findings/self-improvement-loop-2026-06-04/`):
 * - Activity multiplies around concept-db (templates +5, scenarios +18, mitosis +3)
 *   but ts_sum / new-concept count stayed flat (6/0).
 * - concept-bridge-observer covers analysis-vessel reads (problem_detection etc.)
 *   but does not see substrate-authored gap-closing-auto / apply-proposal /
 *   mitosis-cutover successes.
 * - Without this observer, the ribosome-style "successful trace → reusable
 *   pattern" wiring is inert.
 *
 * What this observer does
 * -----------------------
 * 1. Subscribe to activity-api `/ws`, authenticate with METABOB_API_KEY.
 * 2. Normalize lifecycle events from both bus forms
 *    (`execution_completed` and `lifecycle.execution.succeeded`).
 * 3. If shouldWriteback(event) is true, emit ONE concept_create via
 *    the local concept_write resolver naming the just-succeeded template
 *    as an `impulse_activity_pattern`. Idempotent: concept-db's POST
 *    /concepts is upsert-by-content-hash, so re-firing is safe.
 *
 * Concept-usage-record (incrementing ts/tf on cited priors) is handled by
 * the existing concept-usage-backfill template; this observer only handles
 * the concept_create side, where new patterns become first-class learnable
 * units.
 *
 * Three-layer discipline (per development-vessel CLAUDE.md):
 * - This is observer routing only. The decision of which template families
 *   count as substrate-authored success patterns is a literal constant
 *   (WRITEBACK_PREFIXES) for auditability.
 * - The actual write goes through the existing concept_write resolver via
 *   resolveDispatch — no inline HTTP, no LLM, no new shape.
 */

import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import { resolveDispatch } from "../routes/impulses.js";

/** Template-id substrings whose successful execution should emit a concept. */
const WRITEBACK_PREFIXES = [
  "gap-closing:auto-",
  "apply-proposal-as-patch",
  "vessel-mitosis-cutover",
];

/** Dedupe window — repeat broadcasts of the same execution should not double-write. */
const WRITEBACK_DEDUPE_MS = 60_000;
const recentWritebacks = new Map<string, number>();

export interface NormalizedLifecycleEvent {
  type: string;
  activity_template_id?: string;
  execution_id?: string;
  output_shapes?: string[];
}

/** Strip `activity:⟨…⟩` wrapping when present. */
function stripWrapping(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = raw.match(/^activity:⟨(.+)⟩$/);
  return m ? m[1] : raw;
}

/** Pure predicate — exported for tests. */
export function shouldWriteback(event: NormalizedLifecycleEvent): boolean {
  if (event.type !== "lifecycle:execution:succeeded") return false;
  const tid = stripWrapping(event.activity_template_id) ?? "";
  if (!tid) return false;
  return WRITEBACK_PREFIXES.some((p) => tid.includes(p));
}

/** Visible for tests. */
export function _resetWritebackDedupe(): void {
  recentWritebacks.clear();
}

function dedupeFresh(key: string): boolean {
  const last = recentWritebacks.get(key);
  const now = Date.now();
  if (last !== undefined && now - last < WRITEBACK_DEDUPE_MS) return false;
  recentWritebacks.set(key, now);
  if (recentWritebacks.size > 256) {
    const oldest = [...recentWritebacks.entries()].sort((a, b) => a[1] - b[1]);
    for (const [k] of oldest.slice(0, 64)) recentWritebacks.delete(k);
  }
  return true;
}

/** Build the concept_create payload for a successful substrate-authored execution. */
export function buildConceptWritePointer(event: NormalizedLifecycleEvent): {
  type: "concept_write";
  name: string;
  content: string;
  source_type: "impulse_activity_pattern";
} {
  const tid = stripWrapping(event.activity_template_id) ?? "unknown";
  // CITE THE EXECUTION. eb42e0b (substrate-authored, 2026-07-04) removed
  // `(execution ${execId})` from this sentence, leaving the id computed but used only for the
  // dedupe key. A concept minted FROM an execution then carried no way back to it — in a
  // substrate whose citation oracle beta-penalises uncited work. Restored: provenance belongs in
  // the concept itself, because that is what a later reader (or grader) actually sees.
  const execId = event.execution_id ?? "unknown";
  return {
    type: "concept_write",
    name: `autocomplete:${tid}`,
    source_type: "impulse_activity_pattern",
    content:
      `Substrate-authored success pattern: template "${tid}" completed successfully ` +
      `(execution ${execId}). ` +
      `This pattern was emitted by the autocomplete-concept-writer observer when a ` +
      `gap-closing-auto / apply-proposal / mitosis-cutover execution closed cleanly. ` +
      `Output shapes: ${(event.output_shapes ?? []).join(", ") || "(none reported)"}.`,
  };
}

let _stopController: AbortController | null = null;

export function stopAutocompleteConceptWriter(): void {
  _stopController?.abort();
  _stopController = null;
}

export function startAutocompleteConceptWriter(): void {
  if (_stopController) return;
  const controller = new AbortController();
  _stopController = controller;

  function connect(backoffMs: number): void {
    if (controller.signal.aborted) return;
    const wsUrl = METABOB_ENDPOINT.replace(/^http/, "ws") + "/ws";
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error("[autocomplete-concept] WebSocket construction failed:", err);
      reschedule(backoffMs);
      return;
    }

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "authenticate", token: METABOB_API_KEY }));
      console.log(`[autocomplete-concept] connected to ${wsUrl}`);
    });

    ws.addEventListener("message", (ev) => {
      let event: NormalizedLifecycleEvent;
      try {
        const parsed = JSON.parse(String(ev.data)) as Record<string, unknown>;
        if (parsed["type"] === "execution_completed") {
          const d = (parsed["data"] ?? {}) as Record<string, unknown>;
          event = {
            type: "lifecycle:execution:succeeded",
            activity_template_id:
              (d["activity_id"] as string | undefined) ?? (d["variant_id"] as string | undefined),
            execution_id: d["execution_id"] as string | undefined,
            output_shapes: d["output_shapes"] as string[] | undefined,
          };
        } else if (parsed["type"] === "lifecycle.execution.succeeded") {
          const d = (parsed["data"] ?? {}) as Record<string, unknown>;
          event = {
            type: "lifecycle:execution:succeeded",
            activity_template_id:
              (d["templateId"] as string | undefined) ?? (d["activity_template_id"] as string | undefined),
            execution_id: (d["executionId"] as string | undefined) ?? (d["execution_id"] as string | undefined),
            output_shapes:
              (d["outputShapes"] as string[] | undefined) ?? (d["output_shapes"] as string[] | undefined),
          };
        } else {
          event = parsed as unknown as NormalizedLifecycleEvent;
        }
      } catch {
        return;
      }
      if (!shouldWriteback(event)) return;
      const execId = event.execution_id ?? "no-exec";
      const tid = stripWrapping(event.activity_template_id) ?? "no-tid";
      if (!dedupeFresh(`${tid}::${execId}`)) return;
      const pointer = buildConceptWritePointer(event);
      resolveDispatch(pointer)
        .then((r) => {
          const body = (r?.body ?? {}) as Record<string, unknown>;
          const cid = body["concept_id"] ?? body["id"] ?? "(no id)";
          console.log(
            `[autocomplete-concept] concept_create fired: template=${tid} exec=${execId} concept=${cid}`,
          );
        })
        .catch((err: unknown) => {
          console.error(
            "[autocomplete-concept] concept_create failed:",
            err instanceof Error ? err.message : err,
          );
        });
    });

    ws.addEventListener("error", () => {
      // Bun's WebSocket fires error then close; just wait for close.
    });

    ws.addEventListener("close", () => {
      if (!controller.signal.aborted) reschedule(backoffMs);
    });
  }

  function reschedule(backoffMs: number): void {
    const next = Math.min(backoffMs * 2, 30_000);
    setTimeout(() => connect(next), backoffMs);
  }

  connect(1_000);
}
