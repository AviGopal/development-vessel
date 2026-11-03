// THE HANDS RULE (user ruling: "Related commits only"): an operator commit to the edit site or the check file inside
// the provenance window is an operator act on the gap ONLY when it names the gap in its message (trailers included) or
// changes lines the system's fix changed in that file. Unknown is never unrelated: a commit whose message or line
// relation was not read still counts.
//
// MUST-FAIL: a read, unrelated operator commit (message names another gap, touchesFix false) used to be an
// edit-site-commit act; it is none now. Controls: a related commit (names the gap; changes the fix's lines) still counts,
// before or after the fix, on the edit site and on the check file, and an unread one counts.
// The line relation itself (fixLineRelations) is read against a real git history in a temp repo.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { operatorActsOf, type GapRow, type SiteCommit } from "../../src/resolvers/operator-acts.js";

const NOW = Date.parse("2030-01-10T00:00:00Z");
const h = (n: number) => new Date(NOW - n * 3600_000).toISOString();
const GID = "the-widget-reader-drops-the-last-field";
const SITE = "src/widget.ts";
const CHECK = "test/checks/the-widget-reader-drops-the-last-field.check.ts";
const row: GapRow = { id: GID, source: "substrate_detected", status: "closed", closed_at: h(20), first_detected_at: h(100),
  classification_metadata: { edit_site: `repos/v/${SITE}`, check_supply: { state: "armed", test_file: CHECK } } };
const op = (over: Partial<SiteCommit>): SiteCommit => ({ sha: "7".repeat(40), author: "An Operator", at: h(60), lane: false, files: [SITE], ...over });
const escActs = (commits: SiteCommit[]) => operatorActsOf(row, {
  byId: new Map([[GID, row]]), filedAt: h(100), untilAt: h(0), editSitePath: SITE, checkPath: CHECK,
  scopeActs: [], siteCommits: commits, checkFirstCommit: undefined, events: [], eventsFromFiling: true, labels: [], labelContext: null,
}).acts.filter((a) => a.addendum === "edit-site-commit");

describe("hands rule: only operator commits related to the gap are acts", () => {
  it("MUST-FAIL: a read operator commit naming another gap and changing none of the fix's lines is not an act", () => {
    expect(escActs([op({ message: "fix(other): close another-gap-entirely\n\nGap-Ids: another-gap-entirely\n", touchesFix: false })])).toEqual([]);
  });
  it("MUST-FAIL: the same unrelated commit after the fix (inside close + 24 h) is not an act either", () => {
    expect(escActs([op({ at: h(30), message: "chore: tidy imports", touchesFix: false })])).toEqual([]);
  });
  it("MUST-FAIL: an unrelated operator commit to the check file is not an act", () => {
    expect(escActs([op({ files: [CHECK], message: "test: reword a title", touchesFix: false })])).toEqual([]);
  });
  it("control: a commit naming the gap in a trailer counts, even when it changes none of the fix's lines", () => {
    expect(escActs([op({ message: `fix(widget): reader\n\nGap-Ids: ${GID}\n`, touchesFix: false })]).length).toBe(1);
  });
  it("control: a commit naming the gap's recommit core counts for the recommit row", () => {
    const rid = `recommit-${GID}`;
    const r2: GapRow = { ...row, id: rid };
    const a = operatorActsOf(r2, { byId: new Map([[rid, r2], [GID, row]]), filedAt: h(100), untilAt: h(0), editSitePath: SITE, checkPath: CHECK, scopeActs: [], siteCommits: [op({ message: `see ${GID}`, touchesFix: false })], events: [], eventsFromFiling: true, labels: [], labelContext: null }).acts.filter((x) => x.addendum === "edit-site-commit");
    expect(a.length).toBe(1);
  });
  it("control: a commit changing the fix's lines counts, before and after the fix", () => {
    expect(escActs([op({ at: h(60), message: "refactor", touchesFix: true })]).length).toBe(1);
    expect(escActs([op({ at: h(30), message: "refactor", touchesFix: true })]).length).toBe(1);
  });
  it("the act says why the commit is related", () => {
    expect(escActs([op({ message: `Gap-Ids: ${GID}`, touchesFix: false })])[0]?.detail).toContain("names the gap");
    expect(escActs([op({ message: "refactor", touchesFix: true })])[0]?.detail).toContain("changes lines the fix changed");
    expect(escActs([op({ message: null })])[0]?.detail).toContain("unread");
  });
  it("control: an unread message or an unread line relation still counts (unknown is never unrelated)", () => {
    expect(escActs([op({ message: null, touchesFix: false })]).length).toBe(1);
    expect(escActs([op({ message: "refactor", touchesFix: null })]).length).toBe(1);
    expect(escActs([op({})]).length).toBe(1);
  });
  it("control: lane commits and commits outside the window are still not acts", () => {
    expect(escActs([op({ lane: true, author: "Substrate Autonomous", touchesFix: true })])).toEqual([]);
    expect(escActs([op({ at: h(110), message: `Gap-Ids: ${GID}` })])).toEqual([]);
  });
});

describe("fixLineRelations reads the line relation from git lineage", () => {
  let repo = "";
  const sh = (args: string[], env: Record<string, string> = {}) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", ...env } }).trim();
  const commit = (name: string, msg: string, t: number) => { sh(["add", "."]); sh(["-c", `user.name=${name}`, "-c", "user.email=t@t", "commit", "-q", "-m", msg], { GIT_AUTHOR_DATE: h(t), GIT_COMMITTER_DATE: h(t) }); return sh(["rev-parse", "HEAD"]); };
  const lines = (xs: string[]) => xs.join("\n") + "\n";
  const S: Record<string, string> = {};
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "hands-rule-"));
    sh(["init", "-q"]);
    mkdirSync(join(repo, "src"), { recursive: true });
    const base = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(repo, SITE), lines(base)); commit("An Operator", "c0", 120);
    // before the fix: one operator commit writes lines 5-6 (which the fix will rewrite), one writes line 30 (untouched)
    const b1 = [...base]; b1[4] = "op five"; b1[5] = "op six"; writeFileSync(join(repo, SITE), lines(b1)); S["beforeRelated"] = commit("An Operator", "op: five and six", 90);
    const b2 = [...b1]; b2[29] = "op thirty"; writeFileSync(join(repo, SITE), lines(b2)); S["beforeUnrelated"] = commit("An Operator", "op: thirty", 85);
    // the fix rewrites lines 5-6 and inserts two lines after line 10
    const f = [...b2]; f[4] = "fix five"; f[5] = "fix six"; f.splice(10, 0, "fix new a", "fix new b"); writeFileSync(join(repo, SITE), lines(f)); S["fix"] = commit("Substrate Autonomous", "fix", 50);
    // after the fix: one operator commit rewrites a line the fix wrote ("fix new a"), one rewrites line 35 (untouched)
    const a1 = [...f]; a1[10] = "op rewrote fix line"; writeFileSync(join(repo, SITE), lines(a1)); S["afterRelated"] = commit("An Operator", "op: rewrite", 40);
    const a2 = [...a1]; a2[36] = "op far away"; writeFileSync(join(repo, SITE), lines(a2)); S["afterUnrelated"] = commit("An Operator", "op: far", 35);
    sh(["update-ref", "refs/remotes/origin/dev", "HEAD"]);
  });
  afterAll(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });
  it("before the fix: related only when the fix rewrites its lines; after: related only when it rewrites the fix's lines", async () => {
    const m = await import("../../src/resolvers/self-fact-reconcile.js") as Record<string, unknown>;
    expect(typeof m["fixLineRelations"]).toBe("function");
    const rel = m["fixLineRelations"] as (dir: string, fix: string, cs: SiteCommit[], paths: string[]) => SiteCommit[];
    const cs = (["beforeRelated", "beforeUnrelated", "afterRelated", "afterUnrelated"] as const).map((k) => op({ sha: S[k]!, message: k }));
    const out = rel(repo, S["fix"]!, cs, [SITE]);
    expect(out.map((c) => [c.message, c.touchesFix])).toEqual([["beforeRelated", true], ["beforeUnrelated", false], ["afterRelated", true], ["afterUnrelated", false]]);
  });
  it("an unreadable fix sha leaves the relation unread (null), never unrelated", async () => {
    const m = await import("../../src/resolvers/self-fact-reconcile.js") as Record<string, unknown>;
    expect(typeof m["fixLineRelations"]).toBe("function");
    const rel = m["fixLineRelations"] as (dir: string, fix: string, cs: SiteCommit[], paths: string[]) => SiteCommit[];
    const out = rel(repo, "0".repeat(40), [op({ sha: S["afterUnrelated"]! })], [SITE]);
    expect(out[0]!.touchesFix).toBeNull();
  });
});
