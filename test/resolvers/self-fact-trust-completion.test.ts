// A self-fact run must say, in a line that can fail, whether every trust-root pin row this node needs judged was
// judged. "Applicable" is counted independently of the row filter: every pool_record_pin row in this node's profile
// whose shape this node HOLDS. If fewer were judged (dropped by a filter, or read unobserved), the run files
// `<node>-unjudged`: the 2026-10-04 node1 outage (both pins dropped, logged as a profile skip) is this class.
// Also pinned here: the unpinned canary is liveness-only and says so, and no key material leaves the identity read.
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `self-fact-trust-completion-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(ROOT, { recursive: true });
process.env["WORKSPACE_ROOT"] = ROOT;

// A volume-held identity key for this test process, so thisNode() is the key digest (SUBSTRATE_NAME unset).
const { privateKey } = generateKeyPairSync("ed25519");
const KEY_PATH = join(ROOT, "keys", "development-vessel.ed25519.pem");
mkdirSync(join(ROOT, "keys"), { recursive: true });
const PEM = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
writeFileSync(KEY_PATH, PEM, { mode: 0o600 });
const RAW_PUB = (createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
const FULL_DIGEST = createHash("sha256").update(RAW_PUB).digest("hex");

const saved = { name: process.env["SUBSTRATE_NAME"], key: process.env["VESSEL_IDENTITY_KEY_PATH"], sup: process.env["SUPER_REPO_ROOT"] };
beforeAll(() => { delete process.env["SUBSTRATE_NAME"]; process.env["VESSEL_IDENTITY_KEY_PATH"] = KEY_PATH; });
afterAll(() => {
  for (const [k, v] of [["SUBSTRATE_NAME", saved.name], ["VESSEL_IDENTITY_KEY_PATH", saved.key], ["SUPER_REPO_ROOT", saved.sup]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

const sfr = await import("../../src/resolvers/self-fact-reconcile.js");
const { resolveSelfFactReconcile, evaluateSelfFactRow, __setPoolPinDepsForTests, thisNode } = sfr;
afterEach(() => __setPoolPinDepsForTests(null));

const N1 = "http://host.containers.internal:18100";
const PATHS = ["scripts/substrate/", "repos/development-vessel/src/resolvers/self-fact-reconcile.ts"];
const me = () => thisNode();
const scopeRow = (pin: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: "autonomy_scope_pinned", instrument: "pool_record_pin", profiles: ["*"], edit_site: "repos/development-vessel/src/resolvers/gap-to-feature.ts",
  must_fail: "a planted excluded path must be reported", pool_shape: "autonomyScope", expected_by_node: pin, ...extra,
});
const heldScope = { id: "autonomy-scope", updated_at: "2026-10-05T00:00:00Z", body: { excluded_paths: PATHS } };

let n = 0;
async function run(rows: unknown[], held: Record<string, unknown> | null) {
  __setPoolPinDepsForTests({ readNewest: async (shape) => (shape === "autonomyScope" ? held : null), readChanges: async () => [] });
  const repo = join(ROOT, `super-${n++}`);
  mkdirSync(join(repo, "scripts", "substrate"), { recursive: true });
  writeFileSync(join(repo, "scripts", "substrate", "self-facts.json"), JSON.stringify({ rows }));
  const g = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g(["init", "-q"]); g(["add", "."]); g(["commit", "-qm", "rows"]); g(["update-ref", "refs/remotes/origin/dev", "HEAD"]);
  process.env["SUPER_REPO_ROOT"] = repo;
  const logs: string[] = [];
  const spies = (["log", "warn", "error", "info"] as const).map((m) => spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }));
  try {
    const body = (await resolveSelfFactReconcile({ type: "self_fact_reconcile", file_gaps: false })).body as { divergences: Array<{ key: string; fact: string }>; rows_checked: string[] };
    return { body, logs };
  } finally {
    for (const s of spies) s.mockRestore();
  }
}
const completion = (logs: string[]) => logs.filter((l) => l.includes("trust_rows_applicable="));

describe("trust-root completion: applicable vs judged, in a line that can fail", () => {
  it("MUST-FAIL: a held shape whose pin row reads unobserved is counted unjudged, logged m>n, and filed <node>-unjudged", async () => {
    // List form with no body_field: the instrument cannot judge it (unread), though this node holds the shape.
    const { body, logs } = await run([scopeRow({ [me()]: [N1] })], heldScope);
    expect(completion(logs)).toEqual([`[self-fact] completion: thisNode=${me()} trust_rows_applicable=1 judged=0`]);
    expect(body.divergences.map((d) => d.key)).toContain(`${me()}-unjudged`);
  });

  it("MUST-FAIL: a held shape whose row a filter drops (row lists only other nodes but pins this one) is unjudged", async () => {
    // Pinned for this node, yet `nodes` omits it: the scope filter drops the row, so nothing judged the held record.
    const { body, logs } = await run([scopeRow({ [me()]: { excluded_paths: PATHS } }, { nodes: ["other-node"] })], heldScope);
    expect(completion(logs)).toEqual([`[self-fact] completion: thisNode=${me()} trust_rows_applicable=1 judged=0`]);
    expect(body.divergences.map((d) => d.key)).toContain(`${me()}-unjudged`);
  });

  it("control: every applicable row judged ⇒ m == n and no -unjudged", async () => {
    const { body, logs } = await run([scopeRow({ [me()]: { excluded_paths: PATHS } })], heldScope);
    expect(completion(logs)).toEqual([`[self-fact] completion: thisNode=${me()} trust_rows_applicable=1 judged=1`]);
    expect(body.divergences.map((d) => d.key)).not.toContain(`${me()}-unjudged`);
  });

  it("control: a node holding none of the pinned shapes has 0 applicable and no -unjudged", async () => {
    const { body, logs } = await run([scopeRow({ "other-node": { excluded_paths: PATHS } }, { nodes: ["other-node"] })], null);
    expect(completion(logs)).toEqual([`[self-fact] completion: thisNode=${me()} trust_rows_applicable=0 judged=0`]);
    expect(body.divergences.map((d) => d.key)).not.toContain(`${me()}-unjudged`);
  });
});

describe("the -unjudged gap's own predicate (its evidence_resolve) can read present and resolved", () => {
  async function predicate(rows: unknown[]) {
    __setPoolPinDepsForTests({ readNewest: async (shape) => (shape === "autonomyScope" ? heldScope : null), readChanges: async () => [] });
    const repo = join(ROOT, `super-pred-${n++}`);
    mkdirSync(join(repo, "scripts", "substrate"), { recursive: true });
    writeFileSync(join(repo, "scripts", "substrate", "self-facts.json"), JSON.stringify({ rows }));
    const g = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    g(["init", "-q"]); g(["add", "."]); g(["commit", "-qm", "rows"]); g(["update-ref", "refs/remotes/origin/dev", "HEAD"]);
    process.env["SUPER_REPO_ROOT"] = repo;
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      return (await resolveSelfFactReconcile({ type: "self_fact_reconcile", facts: ["trust_root_completion"], key: `${me()}-unjudged`, plant_canary: false, file_gaps: false })).body as { divergence_count: number | null };
    } finally { spy.mockRestore(); }
  }
  it("present: a dropped held row ⇒ divergence_count 1; resolved: the row judged ⇒ 0", async () => {
    expect((await predicate([scopeRow({ [me()]: { excluded_paths: PATHS } }, { nodes: ["other-node"] })])).divergence_count).toBe(1);
    expect((await predicate([scopeRow({ [me()]: { excluded_paths: PATHS } })])).divergence_count).toBe(0);
  });
});

describe("the unpinned canary is liveness-only and says so", () => {
  it("MUST-FAIL: its detail labels it a liveness-only control", async () => {
    __setPoolPinDepsForTests({ readNewest: async () => heldScope });
    const r = await evaluateSelfFactRow(scopeRow({ "other-node": { excluded_paths: PATHS } }) as never);
    const c = (r?.divergences ?? []).filter((d) => d.canary);
    expect(c.length).toBe(1);
    expect(c[0]!.detail).toContain("liveness-only");
  });
});

describe("no key material leaves the identity read", () => {
  it("thisNode() is key-<12 hex>, and no log line, report body or workspace file carries the key, its public half or its full digest", async () => {
    expect(me()).toMatch(/^key-[0-9a-f]{12}$/);
    expect(me()).toBe(`key-${FULL_DIGEST.slice(0, 12)}`);
    const before = new Set(walk(ROOT));
    const { body, logs } = await run([scopeRow({ "other-node": { excluded_paths: PATHS } })], heldScope);
    const pkcs8 = (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).toString("base64");
    const secretForms = [PEM.split("\n")[1]!, pkcs8, RAW_PUB.toString("base64"), RAW_PUB.toString("hex"), FULL_DIGEST, "PRIVATE KEY"];
    const surfaces = [...logs, JSON.stringify(body)];
    // Files written under the workspace during the run (anything but the key itself).
    for (const f of walk(ROOT)) if (!before.has(f) && f !== KEY_PATH && statSync(f).size < 5_000_000) surfaces.push(readFileSync(f, "utf8"));
    for (const s of secretForms) expect(surfaces.filter((t) => t.includes(s))).toEqual([]);
  });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== ".git") out.push(...walk(p)); } else out.push(p);
  }
  return out;
}
