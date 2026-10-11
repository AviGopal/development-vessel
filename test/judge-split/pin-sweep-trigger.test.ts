// BEHAVIOUR PIN: whether a tick runs the pending-land sweep (judge split, extraction `sweepIfCloneHeadsMoved`).
// Every tick computes a fingerprint of the vessel clones' HEADs. It sweeps when the fingerprint is unreadable (null)
// or differs from the one recorded after the last sweep. A sweep that left a landing awaiting its vessel's restart
// records no fingerprint, so the next tick sweeps again although no HEAD moved. Otherwise the tick does not sweep.
//
// Driven through resolveGapToFeature (a targeted pointer at an id the store does not hold, so the tick ends at
// select); a sweep is observed by its one tally line "[gap-sweep] checked=N closed=N {...}". The clone root is a
// fresh directory per test with a uniquely named clone, so the fingerprint differs from any earlier state of the
// process. Written against the tree before the extraction; it must hold after it.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginPin, endPin, restoreHarness, seed, stored, execRoute, git, tick, RUN, SCRATCH, type Row } from "./harness.js";

const { resolveGapToFeature } = await import("../../src/resolvers/gap-to-feature.js");

const savedRoot = process.env["VESSELS_CLONE_ROOT"];
let root = "";
let n = 0;
beforeEach(() => {
  beginPin();
  root = mkdtempSync(join(tmpdir(), "judge-pin-clones-"));
  process.env["VESSELS_CLONE_ROOT"] = root;
});
afterEach(() => {
  process.env["VESSELS_CLONE_ROOT"] = savedRoot;
  expect(endPin()).toEqual({ fetch: [], fs: [], exec: [] });
});
afterAll(() => restoreHarness());

/** One clone under the test's root, with one commit; returns its dir. */
function makeClone(name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  git(dir, "init", "-q", "-b", "dev");
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture: first");
  return dir;
}
function commit(dir: string, msg: string): string {
  writeFileSync(join(dir, "src", "a.ts"), `export const a = "${msg} ${++n}";\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
}
/** One tick; returns how many sweeps it ran (tally lines). */
async function sweepsInTick(): Promise<{ sweeps: number; lines: string[]; body: Row }> {
  const { result, lines } = await tick(() => resolveGapToFeature({ type: "gap_to_feature", gap_id: `pin-sweep-absent-${RUN}` } as never));
  return { sweeps: lines.filter((l) => /^\[gap-sweep\] checked=\d+ closed=\d+ /.test(l)).length, lines, body: result.body as Row };
}

describe("the sweep runs only when the clone HEADs moved, the fingerprint is unreadable, or a landing awaits a restart", () => {
  it("[PIN] fresh clone set: tick 1 sweeps, tick 2 does not; a new commit makes tick 3 sweep; tick 4 does not", async () => {
    const dir = makeClone(`pin-sweep-${RUN}-a`);
    const t1 = await sweepsInTick();
    expect(t1.sweeps).toBe(1);
    expect(t1.body.error).toBe("no matching open gap");
    expect((await sweepsInTick()).sweeps).toBe(0);
    commit(dir, "fixture: second");
    expect((await sweepsInTick()).sweeps).toBe(1);
    expect((await sweepsInTick()).sweeps).toBe(0);
  });

  it("[PIN] a second clone appearing moves the fingerprint: the next tick sweeps once", async () => {
    makeClone(`pin-sweep-${RUN}-b1`);
    expect((await sweepsInTick()).sweeps).toBe(1);
    expect((await sweepsInTick()).sweeps).toBe(0);
    makeClone(`pin-sweep-${RUN}-b2`);
    expect((await sweepsInTick()).sweeps).toBe(1);
    expect((await sweepsInTick()).sweeps).toBe(0);
  });

  it("[PIN] an unreadable clone root (missing directory) is a null fingerprint: every tick sweeps", async () => {
    process.env["VESSELS_CLONE_ROOT"] = join(root, "does-not-exist");
    expect((await sweepsInTick()).sweeps).toBe(1);
    expect((await sweepsInTick()).sweeps).toBe(1);
    expect((await sweepsInTick()).sweeps).toBe(1);
  });

  it("[PIN] a clone whose HEAD cannot be read (no commit yet) is a null fingerprint: every tick sweeps", async () => {
    const dir = join(root, `pin-sweep-${RUN}-unborn`);
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "dev");
    expect((await sweepsInTick()).sweeps).toBe(1);
    expect((await sweepsInTick()).sweeps).toBe(1);
  });

  describe("a landing that reads absent but is not yet running here (its vessel is not active) awaits a restart", () => {
    const VES = `pin-sweep-${RUN}-ves`;
    const SITE = `repos/${VES}/src/a.ts`;
    function seedAwaitingRestart(id: string, sha: string): void {
      // Class-1 check: the literal is gone from the runtime file, so the sweep's verdict is 'absent'.
      mkdirSync(join(SCRATCH, "runtime", VES, "src"), { recursive: true });
      writeFileSync(join(SCRATCH, "runtime", VES, "src", "a.ts"), "export const fixed = true;\n");
      seed({ id, classification_metadata: { falsifier: "class1", edit_site: SITE, hardcoded_url: `http://pin-literal-${RUN}`, pending_outcome_verification: sha } });
    }
    const inactive = () => execRoute("systemctl (vessel inactive)", (c) => c.includes("systemctl"), (c) => ({ exitCode: c.includes("is-active") ? 3 : 0, stdout: c.includes("is-active") ? "inactive\n" : "" }));

    it("[PIN] the tick after such a sweep sweeps again with no HEAD moved, and the gap stays open", async () => {
      const dir = makeClone(VES);
      const sha = commit(dir, "fix: the landing");
      const id = `pin-sweep-awaiting-${RUN}`;
      seedAwaitingRestart(id, sha);
      inactive();
      const t1 = await sweepsInTick();
      expect(t1.sweeps).toBe(1);
      expect(t1.lines.some((l) => l.includes(`[gap-sweep] gap ${id} reads absent but landed ${sha.slice(0, 12)} is not served here on this node`))).toBe(true);
      expect(t1.lines.find((l) => l.startsWith("[gap-sweep] checked="))).toContain('"awaiting_restart":1');
      expect((await sweepsInTick()).sweeps).toBe(1);
      expect((await sweepsInTick()).sweeps).toBe(1);
      expect(stored(id)!.status).toBe("open");
    });

    it("[CONTROL] the same clone with no landing awaiting a restart: the second tick does not sweep", async () => {
      const dir = makeClone(`${VES}-ctl`);
      commit(dir, "fix: unrelated");
      inactive();
      expect((await sweepsInTick()).sweeps).toBe(1);
      expect((await sweepsInTick()).sweeps).toBe(0);
    });
  });
});
