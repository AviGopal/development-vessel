/**
 * code_locality — substrate-authored resolver (Seam ③).
 * Output shape: code_locality_result
 */

import type { ResolverResult } from "./types.js";

export interface CodeLocalityPointer {
  type: "code_locality";
  [key: string]: unknown;
}

export async function resolveCodeLocality(pointer: CodeLocalityPointer): Promise<ResolverResult> {
  // TODO: implement. Stub returns an empty, well-formed result.
  return { shape: "code_locality_result", body: { authored: true, pointer_type: pointer.type } };
}
