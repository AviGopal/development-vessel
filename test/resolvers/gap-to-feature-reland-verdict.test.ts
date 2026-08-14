// Per-resolver test for landedCommitVerdict — the re-land-aware Class-3 landed-commit
// evidence helper (§12.6, 2026-08-14). Encodes the bafd83d hole:
//   • no commit references the gap            → null      (no landed evidence)
//   • ONE non-reverted landing                → 'pending' (landed = PROVENANCE, not measurement;
//       a commit is proof a change landed, not proof it did anything — the inert-diff hole)
//   • TWO+ non-reverted landings (a RE-LAND)  → 'present' (referent persisted despite landing)
//   • the only landing was reverted           → null      (no valid landing remains)
// Real git against a tmp fixture clone tree (VESSELS_CLONE_ROOT), no network.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(tmpdir(), `reland-verdict-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const CLONES = join(ROOT, "clones");
process.env.VESSELS_CLONE_ROOT = CLONES;

function git(repo: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
}
function commit(repo: string, file: string, body: string, msg: string): string {
  writeFileSync(join(repo, file), body);
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", msg);
  return git(repo, "rev-parse", "HEAD");
}

const EDIT = "repos/development-vessel/src/resolvers/fs-write.ts";

beforeAll(() => {
  const repo = join(CLONES, "development-vessel");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "commit", "-q", "--allow-empty", "-m", "root");
  // one non-reverted landing
  commit(repo, "a.txt", "a1\n", "substrate-authored: apply gap-single-landing-0001-compose-report via mitosis cutover");
  // TWO non-reverted landings for the same gap = a RE-LAND (the bafd83d/69d680b shape)
  commit(repo, "b.txt", "b1\n", "substrate-authored: apply gap-reland-demo-0002-compose-report via mitosis cutover");
  commit(repo, "b.txt", "b2\n", "substrate-authored: apply gap-reland-demo-0002-compose-report via mitosis cutover");
  // a landing followed by its revert -> no valid landing remains
  const sha = commit(repo, "c.txt", "c1\n", "substrate-authored: apply gap-reverted-land-0003-compose-report via mitosis cutover");
  git(repo, "revert", "--no-edit", sha);
  // a DIFFERENT vessel mentioning a gap must not count when editSite scopes to development-vessel
  const other = join(CLONES, "obsidian-vessel");
  mkdirSync(other, { recursive: true });
  git(other, "init", "-q");
  git(other, "config", "user.email", "t@t");
  git(other, "config", "user.name", "t");
  commit(other, "o.txt", "o1\n", "substrate-authored: apply gap-scoped-elsewhere-0004-compose-report via mitosis cutover");
});
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ } });

describe("landedCommitVerdict — re-land awareness (§12.6)", () => {
  it("returns null when no commit references the gap", async () => {
    const { landedCommitVerdict } = await import("../../src/resolvers/gap-to-feature.js");
    expect(landedCommitVerdict("gap-unmentioned-9999", EDIT)).toBe(null);
  });
  it("returns 'pending' for a single non-reverted landing (provenance, NOT measured resolution)", async () => {
    const { landedCommitVerdict } = await import("../../src/resolvers/gap-to-feature.js");
    // A single landing is proof a change LANDED, not proof it RESOLVED the gap. Returning 'pending'
    // (was 'absent') is what closes the inert-diff hole: the close-oracle abstains instead of
    // closing green on the commit count — only a measurement predicate can yield 'absent'.
    expect(landedCommitVerdict("gap-single-landing-0001", EDIT)).toBe("pending");
  });
  it("returns 'present' for a RE-LAND (>=2 non-reverted commits) — the bafd83d hole", async () => {
    const { landedCommitVerdict } = await import("../../src/resolvers/gap-to-feature.js");
    expect(landedCommitVerdict("gap-reland-demo-0002", EDIT)).toBe("present");
  });
  it("returns null when the only landing was reverted (no valid landing remains)", async () => {
    const { landedCommitVerdict } = await import("../../src/resolvers/gap-to-feature.js");
    expect(landedCommitVerdict("gap-reverted-land-0003", EDIT)).toBe(null);
  });
  it("ignores a commit in a different vessel when editSite scopes to the target vessel", async () => {
    const { landedCommitVerdict } = await import("../../src/resolvers/gap-to-feature.js");
    expect(landedCommitVerdict("gap-scoped-elsewhere-0004", EDIT)).toBe(null);
  });
});
