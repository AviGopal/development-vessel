import type { ResolverResult } from "./types.js";
export interface EmitShapePointer { type: "emit_shape"; shape?: string; rung?: number; content?: unknown; }
/** Test-fixture resolver: emits an impulse of the shape named in pointer.shape.
 *  Lets synthetic activities produce an arbitrary declared output shape so
 *  shape-walk / composition-depth can be exercised end-to-end. */
export async function resolveEmitShape(pointer: EmitShapePointer): Promise<ResolverResult> {
  const shape = typeof pointer?.shape === "string" && pointer.shape ? pointer.shape : null;
  if (!shape) return { shape: "structuredError", body: { error: "emit_shape requires pointer.shape" } };
  return { shape, body: { emitted: shape, rung: pointer.rung ?? null, content: pointer.content ?? null } };
}
