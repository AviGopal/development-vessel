import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 28b3e8a (autonomous) changed the sweep's gap write to resolveSubstrateGapWrite(gapWritePayload). On a node with
// GAP_STORE_ENDPOINT set the RAW pointer is forwarded before coerceFlatGapPointer runs, and the store refuses it
// ("pointer.type is required"), so every composer-interruption gap was silently lost (2026-09-30). The write must
// carry the typed envelope.
describe("composer-interruption-sweep writes its gap as a typed substrateGap_write", () => {
  const src = readFileSync(join(import.meta.dir, "../../src/resolvers/composer-interruption-sweep.ts"), "utf8");

  test("the gap write passes { type: \"substrateGap_write\", gap: gapWritePayload }", () => {
    expect(src).toMatch(/resolveSubstrateGapWrite\(\s*\{\s*type:\s*"substrateGap_write",\s*gap:\s*gapWritePayload\s*\}\s*\)/);
  });

  test("no call passes the flat payload as the pointer", () => {
    expect(src).not.toMatch(/resolveSubstrateGapWrite\(\s*gapWritePayload\s*\)/);
  });
});
