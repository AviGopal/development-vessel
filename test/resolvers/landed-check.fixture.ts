// LANDED CHECK FIXTURE (test setup, not a test file). The check supply arms a gap only on a check that has LANDED: the
// test file read at the vessel clone's origin/dev (gap-check-supply.ts landedCheckSource), never a work-tree file. A
// tick test that writes its check into a fixture clone lands it with landCheck, which moves refs/remotes/origin/dev
// (the ref the mirror keeps in production) to a commit holding it. No remote is needed; a test that is about the
// landing itself (gap-check-supply-arm-landed.test.ts) uses a bare origin.
//
// Two kinds of fixture clone, kept as they were:
//   - a clone the TEST made a git repo (it commits its site and check, and its gates read HEAD): the files are
//     committed there as the test does, and origin/dev is pointed at that HEAD;
//   - a plain directory (no .git): it gets a repo whose HEAD stays UNBORN. The landed files are written to
//     origin/dev only, through a private index, so everything that read the directory as "not a git clone" (a gate
//     that runs at base_ref HEAD) reads it the same way, and only origin/dev is new.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const MARK = "landed-check-fixture";

function git(dir: string, args: string[], env: Record<string, string> = {}, input?: string): string {
  const p = Bun.spawnSync(["git", "-C", dir, "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...ENV, ...env }, ...(input !== undefined ? { stdin: new TextEncoder().encode(input) } : {}) });
  if (p.exitCode !== 0) throw new Error(`landed-check fixture: git ${args.join(" ")} failed in ${dir}: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
}

/** Land `rels` (paths relative to `clone`, already written): origin/dev moves to a commit holding them. Returns its sha. */
export function landCheck(clone: string, ...rels: string[]): string {
  if (!existsSync(join(clone, ".git"))) {
    git(clone, ["init", "-q", "-b", "dev"]);
    writeFileSync(join(clone, ".git", MARK), "");
  }
  if (!existsSync(join(clone, ".git", MARK))) {
    // The test's own repo: commit as it does, and land that HEAD.
    git(clone, ["add", "-f", "--", ...rels]);
    git(clone, ["commit", "-q", "--allow-empty", "-m", `fixture: land ${rels.join(", ")}`]);
    const sha = git(clone, ["rev-parse", "HEAD"]);
    git(clone, ["update-ref", "refs/remotes/origin/dev", sha]);
    return sha;
  }
  // A plain fixture directory: origin/dev only, HEAD stays unborn.
  const env = { GIT_INDEX_FILE: join(clone, ".git", `${MARK}.index`) };
  const parent = Bun.spawnSync(["git", "-C", clone, "rev-parse", "--verify", "-q", "refs/remotes/origin/dev"], { stdout: "pipe" });
  const parentSha = parent.exitCode === 0 ? new TextDecoder().decode(parent.stdout).trim() : "";
  if (parentSha) git(clone, ["read-tree", parentSha], env); else git(clone, ["read-tree", "--empty"], env);
  for (const rel of rels) {
    const blob = git(clone, ["hash-object", "-w", "--stdin"], {}, readFileSync(join(clone, rel), "utf-8"));
    git(clone, ["update-index", "--add", "--cacheinfo", `100644,${blob},${rel}`], env);
  }
  const tree = git(clone, ["write-tree"], env);
  const sha = git(clone, ["commit-tree", tree, ...(parentSha ? ["-p", parentSha] : []), "-m", `fixture: land ${rels.join(", ")}`]);
  git(clone, ["update-ref", "refs/remotes/origin/dev", sha]);
  return sha;
}
