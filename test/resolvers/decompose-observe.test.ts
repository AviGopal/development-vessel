// Runs ./decompose-observe.cases.ts in its own process with its own temp gap store (see isolated-gap-store-run.ts). The
// cases drive the real store through the gapDecomposition dispatch and assert the store file is byte-identical across an
// observe dispatch, but in one `bun test` process the store root is frozen by the first importer and the policy, birth
// and vocabulary seams are shared with every earlier file: all four cases failed in the full suite and passed alone.
// Each case keeps its name: the child's describe is stripped and declared again here, so the full name is unchanged.
import { describe, expect, it } from "bun:test";
import { runCasesIsolated } from "./isolated-gap-store-run";

const DESCRIBE = "an observe decomposition writes nothing and reports what it would write";
const rows = runCasesIsolated("./test/resolvers/decompose-observe.cases.ts");
describe(DESCRIBE, () => {
  for (const r of rows) it(r.name.startsWith(`${DESCRIBE} > `) ? r.name.slice(DESCRIBE.length + 3) : r.name, () => { if (!r.ok) console.error(r.detail); expect(r.ok).toBe(true); });
});
