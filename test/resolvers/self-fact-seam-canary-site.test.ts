// A typed_seam_sites ROW PLANTS ITS OWN CANARY (canary_site). The instrument's must-fail control plants one site in a
// scratch repo and expects the row's own pattern to count exactly 1 there. The planted line was fixed to the
// discovery-lookup line, so a row counting any other site class never matched it: its canary was never reported and
// the row could only ever read unobserved. A row now supplies the line to plant; without one the old line is planted.
//   MUST-FAIL: a row with its own site_pattern and canary_site observes its planted canary (and still counts its sites).
//   CONTROL:   the discovery row (no canary_site) plants and finds the old line, unchanged.
//   CONTROL:   the same custom row WITHOUT canary_site finds no canary (the old line is planted, which it cannot match).
// Fixture words from a 5-word draw (2026-10-29T23:49:00Z: certainty material confetti petroleum extras).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateSelfFactRow, scratchSiteCount, type SelfFactResult, type SelfFactRow } from "../../src/resolvers/self-fact-reconcile.js";
import { useUngatedRowsSource } from "../helpers/ungated-rows-source.js";
useUngatedRowsSource();

const EXC = [":(exclude,glob)**/*.test.ts", ":(exclude,glob)**/*.spec.ts", ":(exclude,glob)**/test/**", ":(exclude,glob)**/__tests__/**"];
// A site of another class: a context entry that inherits whatever the caller's store holds.
const PATTERN = "enterCertaintyContext\\(certaintyContext\\.getStore\\(\\)";
const LINE = (n: string) => `  certaintyContext.enterWith(enterCertaintyContext(certaintyContext.getStore(), "${n}"));\n`;
const CUSTOM: SelfFactRow = {
  id: "certainty_context_entries",
  instrument: "typed_seam_sites",
  profiles: ["standalone", "hub"],
  edit_site: "repos/material-vessel/src/index.ts",
  must_fail: "a scratch repo holding one planted context entry must count exactly 1",
  site_pattern: PATTERN,
  pathspecs: [":(glob)src/**/*.ts", ...EXC],
  max: 2,
  canary_site: "  certaintyContext.run(enterCertaintyContext(certaintyContext.getStore(), \"confetti\"), body);",
};
const DISCOVERY: SelfFactRow = {
  id: "discovery_lookups_on_typed_seam",
  instrument: "typed_seam_sites",
  profiles: ["standalone", "hub"],
  edit_site: "repos/development-vessel/src/config.ts",
  must_fail: "a scratch repo with one planted site must count exactly 1",
  site_pattern: "type:[[:space:]]*['\"]vesselCapability['\"]",
  pathspecs: [":(glob)src/**/*.ts", ...EXC],
  max: 9,
};
const canaries = (r: SelfFactResult | null) => (r?.divergences ?? []).filter((d) => d.canary);
const real = (r: SelfFactResult | null) => (r?.divergences ?? []).filter((d) => !d.canary);

let root = "";
const envBefore = { ...process.env };
function repo(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), c); }
  for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", "fixture"], ["update-ref", "refs/remotes/origin/dev", "HEAD"]]) {
    const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  }
}
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "seam-canary-site-"));
  const clones = join(root, "vessels");
  // Three real entries in source, one in a test file (excluded): the row counts 3, above its ceiling of 2.
  repo(join(clones, "material-vessel"), { "src/index.ts": LINE("petroleum") + LINE("extras") + LINE("material"), "src/index.test.ts": LINE("test") });
  repo(join(root, "super"), { "README.md": "fixture\n" });
  process.env["MITOSIS_PUSH_CLONE_DIR"] = clones;
  process.env["SUPER_REPO_ROOT"] = join(root, "super");
  process.env["PROFILE_EFFECTIVE"] = "standalone";
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const k of ["MITOSIS_PUSH_CLONE_DIR", "SUPER_REPO_ROOT", "PROFILE_EFFECTIVE"]) { if (envBefore[k] === undefined) delete process.env[k]; else process.env[k] = envBefore[k]; }
});

describe("typed_seam_sites: a row plants its own canary_site", () => {
  it("[MUST-FAIL] a row with its own site_pattern and canary_site observes its planted canary, and counts its sites", async () => {
    expect(scratchSiteCount(PATTERN, CUSTOM.pathspecs!, CUSTOM.canary_site)).toBe(1);
    const r = await evaluateSelfFactRow(CUSTOM);
    expect(r?.source_read).toBe(true);
    expect(canaries(r).map((d) => d.key)).toEqual(["certainty_context_entries-canary"]);
    expect(r?.note).toMatch(/^3 site\(s\), ceiling 2/);
    expect(real(r).map((d) => d.key)).toContain("over-ceiling");
  });

  it("[CONTROL] the discovery row, which names no canary_site, plants and finds the old line, unchanged", async () => {
    expect(scratchSiteCount(DISCOVERY.site_pattern!, DISCOVERY.pathspecs!)).toBe(1);
    expect(canaries(await evaluateSelfFactRow(DISCOVERY)).length).toBe(1);
  });

  it("[CONTROL] the same custom row WITHOUT canary_site plants the old line and so observes no canary of its own", async () => {
    const { canary_site: _c, ...bare } = CUSTOM;
    expect(scratchSiteCount(PATTERN, CUSTOM.pathspecs!)).toBe(0);
    expect(canaries(await evaluateSelfFactRow(bare as SelfFactRow))).toEqual([]);
  });
});
