/**
 * Passthrough resolvers for interactor* and uiFeedback writes.
 *
 * Same architectural pattern as ui-write-passthrough: stateful-ui-vessel
 * owns the durable in-memory pool. Dev-vessel advertises the *_write shapes
 * so substrate-side activities can dispatch through the normal discovery
 * contract and so the lint three-place rule is satisfied.
 *
 * On write, this resolver:
 *   1. Appends a JSONL log line under WORKSPACE_ROOT/interactor-log/<shape>.jsonl
 *      (so the gap-consumer can tail the file and aggregate signals over
 *      time without depending on a live HTTP fetch).
 *   2. Returns { ok:true, id, category }.
 *
 * The canonical originating path today is operator → stateful-ui-vessel HTTP
 * → dev-vessel /v2/impulses/resolve. The vessel records locally first; this
 * resolver acks. The substrate-side gap-consumer (when it learns to read the
 * log files) closes the loop.
 */

import { mkdir, appendFile } from "fs/promises";
import { join, dirname } from "path";
import type { ResolverResult } from "./types.js";

type Any = Record<string, unknown>;

export type InteractorWriteShape =
  | "uiFeedback_write"
  | "interactorEvent_write"
  | "interactorAssertion_write"
  | "interactorDismiss_write"
  | "interactorAttachment_write";

const DEFAULT_WORKSPACE_ROOT = "/workspace";

function logPathFor(shape: InteractorWriteShape): string {
  const root = process.env["WORKSPACE_ROOT"] ?? DEFAULT_WORKSPACE_ROOT;
  return join(root, "interactor-log", `${shape}.jsonl`);
}

export async function resolveInteractorWrite(
  pointer: { type: InteractorWriteShape } & Any,
): Promise<ResolverResult> {
  const shape = pointer.type;

  // uiFeedback IS OPERATOR-ORIGIN: HOLD IT TO ITS CONTRACT (2026-08-29).
  //
  // uiFeedback_write was reachable as a generic FLOOR SATISFIER, so a goal-walk with no
  // better path "reached" by writing its payload here. boredom's own code documents the
  // behaviour: "it reached the floor emitting `uiFeedback_write` — writing more feedback
  // rather than changing the panel" (repos/boredom-vessel/src/goal-generation.ts:304).
  //
  // Measured 2026-08-28: WORKSPACE_ROOT/interactor-log/uiFeedback_write.jsonl held 48
  // records, 2.9MB, and ZERO carried panel_id. Every one was goal-walk payload — dispatch
  // text under a `goal` key, orphaned_capability_scan report bodies under a `dispatch_id`.
  // The durable operator-feedback corpus contained no operator feedback at all.
  //
  // Two harms, and the second is the one that compounds. (1) Corpus pollution: any consumer
  // treating this log as an operator-verdict corpus reads dispatch text as human feedback —
  // and as of 421052c it IS a live read surface, since solicitation_outcome_scan matches
  // human answers here by panel_id. (2) FALSE REACH: a walk that satisfies itself by writing
  // to a feedback channel books a reach for doing nothing, which is the beta-pump class.
  //
  // panel_id is not decoration; it is the whole contract. Feedback is feedback ON something,
  // and stateful-ui-vessel's POST /api/feedback requires panel_id before it will emit this
  // shape at all. A uiFeedback_write without one did not come from the operator surface.
  // Refusing is what makes the shape non-satisfying for a generic walk: the walk must now
  // find a path that actually changes something.
  //
  // Scoped to uiFeedback_write ONLY. The other interactor_* shapes are unconstrained
  // append-only observation channels and are deliberately left alone.
  if (shape === "uiFeedback_write") {
    const panelId = pointer.panel_id;
    if (typeof panelId !== "string" || panelId.trim().length === 0) {
      console.warn(
        `[interactor-passthrough] REFUSED uiFeedback_write with no panel_id — feedback is feedback ON a panel, ` +
        `and stateful-ui requires panel_id before emitting this shape. Keys offered: ` +
        `${JSON.stringify(Object.keys(pointer).filter((k) => k !== "type").slice(0, 12))}. ` +
        `This is the floor-satisfier path: a walk reaching by writing to the operator-feedback channel.`,
      );
      return {
        shape: "structuredError",
        body: {
          resolver: "interactor_write",
          detail:
            "uiFeedback_write requires a non-empty panel_id: it records an operator's response to a specific " +
            "panel. A write without one is not operator feedback, and this shape is not a general-purpose sink " +
            "for goal payloads — emitting it does not satisfy a goal.",
          offered_keys: Object.keys(pointer).filter((k) => k !== "type").slice(0, 12),
        },
      };
    }
  }

  const id = typeof pointer.id === "string"
    ? pointer.id
    : `${shape}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const visibility = pointer.visibility === "operator_only" ? "operator_only" : "public";

  const record = {
    id,
    shape,
    visibility,
    received_at: new Date().toISOString(),
    pointer,
  };

  try {
    const path = logPathFor(shape);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(record) + "\n", "utf-8");
  } catch (err) {
    // Soft-fail — the durable record lives in stateful-ui-vessel's in-memory
    // store. The log is an aggregation aid, not the source of truth.
    return {
      shape,
      body: { ok: true, id, visibility, logged: false, log_error: err instanceof Error ? err.message : String(err) },
    };
  }

  return {
    shape,
    body: { ok: true, id, visibility, logged: true },
  };
}
