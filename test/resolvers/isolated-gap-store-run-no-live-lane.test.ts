// A TEST HARNESS MUST NEVER TRIGGER THE LIVE LANE.
//
// isolated-gap-store-run spawns a child `bun test` whose gap writes go through substrate-gap. Unless the child
// env carries SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER=1, those writes can spawn the real
// `systemctl start gap-compose.service` — and the post-land suite runs inside a live container. The child env is
// built from an allowlist, so the flag must be set there explicitly and unconditionally.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("isolated gap-store harness never triggers the live lane", () => {
  test("the child env sets SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER=1 unconditionally", () => {
    const src = readFileSync(join(import.meta.dir, "isolated-gap-store-run.ts"), "utf8");
    const envLine = src.split("\n").find((l) => /const env\b.*=\s*\{/.test(l)) ?? "";
    expect(envLine).toContain('SUBSTRATE_GAP_SKIP_COMPOSE_TRIGGER: "1"');
  });
});
