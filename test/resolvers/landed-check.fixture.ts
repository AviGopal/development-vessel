// LANDED CHECK FIXTURE (test setup, not a test file). The check supply arms a gap only on a check that has LANDED: the
// test file read at the vessel clone's origin/dev (gap-check-supply.ts landedCheckSource), never a work-tree file. A
// tick test that writes its check into a fixture clone lands it with landCheck, which moves refs/remotes/origin/dev
// (the ref the mirror keeps in production) to a commit holding it. No remote is needed; a test that is about the
// landing itself (gap-check-supply-arm-landed.test.ts) uses a bare origin.
//
// Two kinds of fixture clone, kept as they were:
//   - a clone the TEST made a git repo (it commits its site and check, and its gates read HEAD): the files are
//     committed there as the test does, and origin/dev is pointed at that HEAD;
//   - a plain directory (no .git): it gets a repo whose HEAD stays UNBORN. The landed files are committed onto
//     origin/dev only (git fast-import), so everything that read the directory as "not a git clone" (a gate
//     that runs at base_ref HEAD) reads it the same way, and only origin/dev is new.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const MARK = "landed-check-fixture";
/** origin/dev's commit in each plain fixture directory this process landed into (each land builds on the last). */
const tips = new Map<string, string>();

function git(dir: string, args: string[], input?: Uint8Array): string {
  const p = Bun.spawnSync(["git", "-C", dir, "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...ENV }, ...(input !== undefined ? { stdin: input } : {}) });
  if (p.exitCode !== 0) throw new Error(`landed-check fixture: git ${args.join(" ")} failed in ${dir}: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
}

/** Land `rels` (paths relative to `clone`, already written): origin/dev moves to a commit holding them. Few git
 *  processes on purpose: the whole suite runs in one large process, where each spawn is costly. */
export function landCheck(clone: string, ...rels: string[]): void {
  if (!existsSync(join(clone, ".git"))) {
    git(clone, ["init", "-q", "-b", "dev"]);
    writeFileSync(join(clone, ".git", MARK), "");
  }
  if (!existsSync(join(clone, ".git", MARK))) {
    // The test's own repo: commit as it does, and land that HEAD.
    git(clone, ["add", "-f", "--", ...rels]);
    git(clone, ["commit", "-q", "--allow-empty", "-m", `fixture: land ${rels.join(", ")}`]);
    git(clone, ["update-ref", "refs/remotes/origin/dev", "HEAD"]);
    return;
  }
  // A plain fixture directory: one fast-import commit onto origin/dev only; HEAD stays unborn.
  const parent = tips.get(clone) ?? (existsSync(join(clone, ".git", "refs", "remotes", "origin", "dev")) ? git(clone, ["rev-parse", "refs/remotes/origin/dev"]) : "");
  const enc = new TextEncoder();
  const msg = enc.encode(`fixture: land ${rels.join(", ")}\n`);
  const parts: Uint8Array[] = [enc.encode(`commit refs/remotes/origin/dev\nmark :1\ncommitter t <t@t> 0 +0000\ndata ${msg.length}\n`), msg, enc.encode(parent ? `from ${parent}\n` : "")];
  for (const rel of rels) {
    const body = readFileSync(join(clone, rel));
    parts.push(enc.encode(`M 100644 inline ${rel}\ndata ${body.length}\n`), body, enc.encode("\n"));
  }
  parts.push(enc.encode("get-mark :1\n"));
  const stream = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of parts) { stream.set(b, o); o += b.length; }
  const sha = git(clone, ["fast-import", "--quiet", "--force"], stream);
  tips.set(clone, sha);
}
