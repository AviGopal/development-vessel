// A STALLED EVENT LOOP NAMES ITSELF (src/lib/loop-stall.ts): a synchronous block long enough to starve /health is
// logged when the loop resumes, with its length and the tick-level activity marker that was running; the marker file
// holds the entry made right before the block, so a vessel killed mid-stall still leaves it.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dir, "..", "..", "src");
const scratch = mkdtempSync(join(tmpdir(), "dv-loop-stall-"));
const realWarn = console.warn;
afterAll(() => { console.warn = realWarn; rmSync(scratch, { recursive: true, force: true }); });

describe("a stalled event loop names the work that was running", () => {
  it("[MUST-FAIL] a 15 s synchronous block after a resolver entry is logged with its length and the resolver's shape (existing seam: resolveDispatch)", async () => {
    // A fresh copy of the route module: three observer test files mock.module "../../src/routes/impulses.js" and never
    // restore it, so in some whole-suite orders the plain specifier is their stub (the caller-credential tests isolate
    // the same way). lib/loop-stall.js stays the one shared instance.
    const { resolveDispatch } = await import(`../../src/routes/impulses.js?${"loop-stall"}`);
    const lines: string[] = [];
    console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      await resolveDispatch({ type: "lift_demo_noop" });
      // Let the monitor take one on-time reading, then hold the loop as a sync child with no timeout would.
      await Bun.sleep(1_200);
      Bun.sleepSync(15_000);
      await Bun.sleep(1_500);
    } finally { console.warn = realWarn; }
    const stall = lines.filter((l) => l.includes("[loop-stall]"));
    expect(stall.length).toBeGreaterThanOrEqual(1);
    const ms = Number(/blocked (\d+)ms/.exec(stall[0])?.[1] ?? 0);
    expect(ms).toBeGreaterThanOrEqual(5_000);
    expect(stall[0]).toContain("last activity: lift_demo_noop");
  }, 30_000);

  it("[MUST-FAIL] with a short threshold, a block inside a tick names that tick as last activity and in flight", async () => {
    const ls = await import("../../src/lib/loop-stall.js");
    ls.stopLoopStallMonitor();
    const lines: string[] = [];
    ls.startLoopStallMonitor({ thresholdMs: 300, intervalMs: 100, log: (l) => lines.push(l) });
    try {
      await Bun.sleep(250);
      const done = ls.noteActivity("example_tick");
      Bun.sleepSync(1_000);
      await Bun.sleep(300);
      done();
    } finally { ls.stopLoopStallMonitor(); }
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(Number(/blocked (\d+)ms/.exec(lines[0])?.[1] ?? 0)).toBeGreaterThanOrEqual(300);
    expect(lines[0]).toContain("last activity: example_tick");
    expect(lines[0]).toMatch(/still in flight: [^;]*example_tick@/);
  });

  it("[CONTROL] no block, no line", async () => {
    const ls = await import("../../src/lib/loop-stall.js");
    ls.stopLoopStallMonitor();
    const lines: string[] = [];
    ls.startLoopStallMonitor({ thresholdMs: 300, intervalMs: 100, log: (l) => lines.push(l) });
    try {
      const done = ls.noteActivity("quiet_tick");
      await Bun.sleep(1_200);
      done();
    } finally { ls.stopLoopStallMonitor(); }
    expect(lines).toEqual([]);
  });

  it("[CONTROL] the marker file holds the label set right before the block", async () => {
    const ls = await import("../../src/lib/loop-stall.js");
    const file = join(scratch, "dv-activity");
    ls.setActivityMarkerFile(file);
    try {
      ls.noteActivity("earlier_tick")();
      const done = ls.noteActivity("blocking_tick");
      Bun.sleepSync(200);
      // What a post-mortem reads if the process is killed here, mid-stall.
      const line = readFileSync(file, "utf8");
      done();
      expect(line).toContain(" blocking_tick");
      expect(line).not.toContain("earlier_tick");
      expect(line.trim().split("\n").length).toBe(1);
    } finally { ls.setActivityMarkerFile(null); }
  });

  it("[CONTROL] only the vessel's entrypoint configures the marker file (a test or CLI process writes no live state)", () => {
    const callers: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (n.endsWith(".ts") && /setActivityMarkerFile\(/.test(readFileSync(p, "utf8")) && !p.endsWith(join("lib", "loop-stall.ts"))) callers.push(p.slice(SRC_DIR.length + 1));
      }
    };
    walk(SRC_DIR);
    expect(callers).toEqual(["index.ts"]);
    expect(readFileSync(join(SRC_DIR, "index.ts"), "utf8")).toContain("setActivityMarkerFile(`${VOLUME_ROOT}/.dv-activity`)");
  });
});
