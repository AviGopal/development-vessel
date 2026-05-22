import type { ResolverResult } from "./types.js";

export type NoopPointer = {
  type: "noop";
};

export async function resolveNoop(_pointer: NoopPointer): Promise<ResolverResult> {
  return { shape: "commandResult", body: { success: true, noop: true } };
}
