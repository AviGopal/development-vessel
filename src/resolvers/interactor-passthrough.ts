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
