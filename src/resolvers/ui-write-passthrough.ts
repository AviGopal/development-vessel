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

export async function resolveUiWritePassthrough(
  pointer: UiWritePointer,
): Promise<ResolverResult> {
  const res = await fetch(`${STATEFUL_UI_ENDPOINT}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ impulse: { pointer } }),
  });
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
