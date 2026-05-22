import type { ResolverResult } from "./types.js";

export type NoopPointer = {
  type: "noop";
};

/** No-op resolver: always returns success without side effects. Used for §S.5 self-application demo. */
export async function resolveNoop(_pointer: NoopPointer): Promise<ResolverResult> {
  return { shape: "commandResult", body: { success: true, noop: true } };
}
