// READ ≠ WRITE: THE LIVE-TREE WRITE HOLD DOES NOT NARROW WHAT THE DRAFTER MAY READ (C-window-1, part D).
//
// The operator hold pwt-live-tree-writes exists because patch_with_tools edited the RUNNING /vessels tree. Its purpose is
// writes. Its only effect on reading was indirect: for a stuck gap the escalation path (pwt) was the one way to see more
// of the file, and the hold skipped it. C-window-1 moves read-widening into the composer's own grounding (whole edit-site
// file, typecheck-lesson windows, repair re-grounding), which reads the tree grounding already reads (REPO_ROOT) and never
// consults the hold.
//
// Expected:
//   - with the hold in force (record absent ⇒ held, the fail-closed default), patch_with_tools on a live tree is REFUSED
//     at entry exactly as before: stage live_tree_writes_held, target bytes unchanged, no tool call;
//   - in that same held state, the composer's grounding reads of that tree return everything (whole file, sources);
//   - none of the grounding read functions references the hold (it governs writes only).
//
// Every fixture lives in this file's own mkdtemp sandbox; fetch is replaced by a guard that fails on any call.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePatchWithTools } from "../../src/resolvers/patch-with-tools.js";
import { __setPoolFileForTests } from "../../src/resolvers/pool-impulse.js";

const fc = (await import("../../src/resolvers/feature-compose.js")) as Record<string, any>;
const re = (await import("../../src/resolvers/retry-evidence.js")) as Record<string, any>;
const holdMod: Record<string, unknown> = await import("../../src/lib/operator-hold.js").catch(() => ({}));
const setZones = (z: unknown): void => { (holdMod.__setLiveTreeZonesForTests as ((z: unknown) => void) | undefined)?.(z); };
const has = (name: string, from: Record<string, any>): boolean => typeof from[name] === "function";

const SUB = "src/resolvers/existing.ts";
const BODY = Array.from({ length: 600 }, (_, i) => `export const v${i} = ${i}; // ${"y".repeat(30)}`).join("\n");
const originalFetch = globalThis.fetch;
let base: string, live: string, ws: string, fetchCalls: number;
const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "cwin-rw-")));
  live = join(base, "live-vessels");
  ws = join(base, "ws");
  mkdirSync(join(live, "demo-vessel", "src", "resolvers"), { recursive: true });
  writeFileSync(join(live, "demo-vessel", SUB), BODY);
  mkdirSync(ws, { recursive: true });
  mkdirSync(join(base, "pool"), { recursive: true });
  __setPoolFileForTests(join(base, "pool", "standing.json"));
  setZones({ supers: [], clones: join(base, "no-clones"), runtime: live, compose: join(base, "compose") });
  fetchCalls = 0;
  globalThis.fetch = (async () => { fetchCalls++; throw new Error("network guard: no call expected"); }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  __setPoolFileForTests(null);
  setZones(null);
  try { rmSync(base, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("the write hold still blocks writes; grounding reads do not depend on it", () => {
  it("held: patch_with_tools on the live tree is refused at entry, the target untouched, no tool call", async () => {
    const before = sha(join(live, "demo-vessel", SUB));
    const r = await resolvePatchWithTools({ type: "patch_with_tools", proposal_text: "x", target_file: `repos/demo-vessel/${SUB}`, vessels_root: live, workspace_root: ws, max_attempts: 1, max_iterations: 1 } as never);
    const b = r.body as Record<string, unknown>;
    expect(r.shape).toBe("structuredError");
    expect(b.stage).toBe("live_tree_writes_held");
    expect(b.verdict).toBe("REFUSED");
    expect(sha(join(live, "demo-vessel", SUB))).toBe(before);
    expect(fetchCalls).toBe(0);
  });

  it("in the same held state, the composer's grounding reads the whole file and the vessel's sources", () => {
    expect(has("targetGrounding", fc)).toBe(true);
    expect(has("readVesselSourcesAt", fc)).toBe(true);
    const content = readFileSync(join(live, "demo-vessel", SUB), "utf8");
    expect(content.length).toBeGreaterThan(6000);
    const g = fc.targetGrounding(`repos/demo-vessel/${SUB}`, content, 6000, [], "", { start: 400, end: 410 }, { path: `repos/demo-vessel/${SUB}`, max_whole_chars: 49_152 });
    expect(g.entry.mode).toBe("whole");
    expect(g.sliced.slice).toBe(content);
    const srcs = fc.readVesselSourcesAt(join(live, "demo-vessel")) as Array<{ path: string; content: string }>;
    expect(srcs.map((s) => s.path)).toEqual([SUB]);
    expect(srcs[0]!.content).toBe(content);
    expect(fetchCalls).toBe(0);
  });

  it("no grounding read function references the hold", () => {
    expect(has("targetGrounding", fc)).toBe(true);
    const fcSrc = readFileSync(join(import.meta.dir, "../../src/resolvers/feature-compose.ts"), "utf8");
    const reSrc = readFileSync(join(import.meta.dir, "../../src/resolvers/retry-evidence.ts"), "utf8");
    const body = (src: string, sig: string, end: string): string => { const a = src.indexOf(sig); expect(a).toBeGreaterThan(0); return src.slice(a, src.indexOf(end, a)); };
    const reads = [
      body(fcSrc, "export function targetGrounding(", "\n}\n"),
      body(fcSrc, "function readGroundedText(", "\n}\n"),
      body(fcSrc, "export function readVesselSourcesAt(", "\n}\n"),
      body(reSrc, "export function tcLessonGroundingBlock(", "\n}\n"),
      body(reSrc, "export function symbolWidenBlock(", "\n}\n"),
    ];
    for (const r of reads) expect(/readOperatorHold|LIVE_TREE_HOLD|pwt-live-tree-writes/.test(r)).toBe(false);
    // The write gate itself is where it was: patch_with_tools reads the hold first.
    const pwt = readFileSync(join(import.meta.dir, "../../src/resolvers/patch-with-tools.ts"), "utf8");
    expect(pwt).toContain("readOperatorHold(LIVE_TREE_HOLD_ID, { scope: LIVE_TREE_HOLD_SCOPE })");
    expect(has("readComposeGroundingPolicy", re)).toBe(true);
  });
});
