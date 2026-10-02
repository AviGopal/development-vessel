// development-vessel's fs_write / fs_edit apply the fleet's write containment
// (write-containment.ts, a byte-identical copy of packages/write-containment).
//
// A guard must live with every producer of a shape (see fs-write.ts): fs_write
// and fs_edit are advertised here AND by local-tools-vessel, and routing is by
// shape, so a walk can land on either. On 10-01 a walk tried this vessel first
// (refused only because its path missed every workspace root) and then
// local-tools, which wrote the live super-repo clone. The lane itself never
// calls these two resolvers — feature_compose, patch_with_tools and perf-canary
// write through local-tools — so here every caller is external and a write into
// the live clone or a vessel tree needs the lane's grant like anywhere else.
import { containWrite, WRITE_GRANT_FIELD } from "./write-containment.js";

export { WRITE_GRANT_FIELD };

/** Throws (the resolver's existing error channel) when the write is not contained. */
export function assertWriteContained(absPath: string, raw: string, grant: unknown): void {
  const v = containWrite(absPath, { env: process.env, raw, grant });
  if (!v.ok) {
    console.error(`[development-vessel] ${v.reason} (requested ${JSON.stringify(raw)})`);
    throw new Error(v.reason);
  }
}
