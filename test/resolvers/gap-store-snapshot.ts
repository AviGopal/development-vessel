// SNAPSHOT AND RESTORE THE GAP STORE a test file actually writes.
//
// substrate-gap.ts captures WORKSPACE_ROOT when it is first imported, and `bun test` shares one module
// registry across every file in the run. So under a multi-file run the store a file writes is whichever
// root the FIRST importer set — usually another suite's temp root, not the ROOT this file created.
// `rmSync(ROOT)` in afterAll then cleans nothing: the rows this file seeded stay in the shared store, and a
// later suite that counts rows (substrate-gap.test.ts: "read filters by status" expects 1 open row) reads
// every foreign row instead. Call this in beforeAll with sg.gapStoreRootForTest() and restore() in
// afterAll, so the store is left exactly as this file found it — whichever root it turns out to be.
//
// restore() first drains the birth evaluations still in flight (pass sg.__settleBirthEvaluationsForTests):
// a birth stamp is a read-modify-write under the gap lock, and one that loaded the store before restore()
// saves it again after, putting this file's rows back into the next suite's store.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function snapshotGapStore(root: string, settle: () => Promise<void>): { restore: () => Promise<void> } {
  const file = join(root, "gaps", "gaps.json");
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  return {
    restore: async () => {
      await settle();
      if (before === null) rmSync(file, { force: true });
      else writeFileSync(file, before);
    },
  };
}
