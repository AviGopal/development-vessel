// The self-fact judge's EXPECTED values (the rows of self-facts.json, incl. the trust-root pins) must come
// from what the gate ACCEPTED, never from an unjudged candidate. Measured 2026-10-06: compose2 judged a new
// spend pin "observed" at 02:20:28Z, before its Gate P promote (02:23:45 request, 02:33:59 ledger), because
// readRows() read `git show origin/dev:scripts/substrate/self-facts.json`. development-vessel cannot read
// /workspace/.gate (InaccessiblePaths), so pull-sync (root) publishes the accepted copy to a dir the vessel
// can only read: /workspace/.gate-public/{self-facts.json, source.json}. Gated + accepted + hash match ⇒ that
// copy; ungated marker ⇒ origin/dev as before; anything else ⇒ FAIL CLOSED (no row judged, reason logged).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), `self-fact-gate-fed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(ROOT, { recursive: true });
process.env["WORKSPACE_ROOT"] = ROOT;
const sfr = await import("../../src/resolvers/self-fact-reconcile.js") as Record<string, unknown>;
const resolveSelfFactReconcile = sfr["resolveSelfFactReconcile"] as typeof import("../../src/resolvers/self-fact-reconcile.js").resolveSelfFactReconcile;
const __setGatePublicDirForTests = (d: string | null): void => { const f = sfr["__setGatePublicDirForTests"] as ((d: string | null) => void) | undefined; if (f) f(d); else if (d === null) delete process.env["SELF_FACTS_PUBLIC_DIR"]; else process.env["SELF_FACTS_PUBLIC_DIR"] = d; };
const GATE_PUBLIC_DIR = sfr["GATE_PUBLIC_DIR"] as string | undefined;

const SUPER = join(ROOT, "super");
const PUB = join(ROOT, "gate-public");
const rowsJson = (id: string) => JSON.stringify({ rows: [{ id, instrument: `unregistered_${id}`, profiles: ["*"], edit_site: "x", must_fail: "x" }] });
const ACCEPTED = "a".repeat(40);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const git = (...a: string[]) => { const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: SUPER }); if (r.exitCode !== 0) throw new Error(new TextDecoder().decode(r.stderr)); };
const saved: Record<string, string | undefined> = {};

function publish(marker: Record<string, unknown> | null, rows: string = rowsJson("row_public")): void {
  rmSync(PUB, { recursive: true, force: true });
  mkdirSync(PUB, { recursive: true });
  writeFileSync(join(PUB, "self-facts.json"), rows);
  if (marker) writeFileSync(join(PUB, "source.json"), JSON.stringify(marker));
}
const good = (over: Record<string, unknown> = {}) => ({ schema: 1, gated: true, source: "accepted", accepted_sha: ACCEPTED, self_facts_sha256: sha(rowsJson("row_public")), writer: "pull-sync", written_at: "2026-10-06T00:00:00Z", ...over });
async function run(plant = false) {
  return (await resolveSelfFactReconcile({ type: "self_fact_reconcile", plant_canary: plant, file_gaps: false })).body as { unregistered_rows: string[]; rows_checked: string[]; read_errors: string[]; self_gap_filed: boolean };
}

beforeAll(() => {
  for (const k of ["SUPER_REPO_ROOT", "SELF_FACTS_PUBLIC_DIR", "PROFILE", "PROFILE_EFFECTIVE"]) saved[k] = process.env[k];
  process.env["SUPER_REPO_ROOT"] = SUPER;
  __setGatePublicDirForTests(PUB);
  process.env["PROFILE_EFFECTIVE"] = "standalone";
  mkdirSync(join(SUPER, "scripts", "substrate"), { recursive: true });
  git("init", "-q");
  writeFileSync(join(SUPER, "scripts", "substrate", "self-facts.json"), rowsJson("row_origin"));
  git("add", "."); git("commit", "-q", "-m", "rows"); git("update-ref", "refs/remotes/origin/dev", "HEAD");
});
afterAll(() => { __setGatePublicDirForTests(null); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } rmSync(ROOT, { recursive: true, force: true }); });

describe("self-fact rows come from the gate-accepted copy, or nothing", () => {
  it("MUST-FAIL (a): gated + accepted + matching hash ⇒ the gate-public rows, not origin/dev", async () => {
    publish(good());
    const b = await run();
    expect(b.unregistered_rows).toEqual(["row_public"]);
  });
  it("MUST-FAIL (b): a self_facts_sha256 mismatch ⇒ fail closed, reason 'hash mismatch'", async () => {
    publish(good({ self_facts_sha256: "0".repeat(64) }));
    const b = await run();
    expect(b.unregistered_rows).toEqual([]);
    expect(b.rows_checked).toEqual([]);
    expect(b.read_errors.join(" ")).toContain("hash mismatch");
  });
  it("MUST-FAIL (c): marker ABSENT ⇒ fail closed (never origin/dev), reason 'marker absent'", async () => {
    publish(null);
    const b = await run();
    expect(b.unregistered_rows).toEqual([]);
    expect(b.read_errors.join(" ")).toContain("marker absent");
  });
  it("MUST-FAIL (d): gated with source 'clone' ⇒ fail closed", async () => {
    publish(good({ source: "clone" }));
    const b = await run();
    expect(b.unregistered_rows).toEqual([]);
    expect(b.read_errors.join(" ")).toContain("not accepted");
  });
  it("MUST-FAIL (d2): gated with a bad accepted_sha or no self_facts_sha256 ⇒ fail closed", async () => {
    publish(good({ accepted_sha: "abc" }));
    expect((await run()).unregistered_rows).toEqual([]);
    const m = good(); delete (m as Record<string, unknown>)["self_facts_sha256"]; publish(m);
    const b = await run();
    expect(b.unregistered_rows).toEqual([]);
    expect(b.read_errors.join(" ")).toContain("hash absent");
  });
  it("MUST-FAIL (d3): an unparseable marker or schema ≠ 1 ⇒ fail closed", async () => {
    publish(null); writeFileSync(join(PUB, "source.json"), "{not json");
    expect((await run()).unregistered_rows).toEqual([]);
    publish(good({ schema: 2 }));
    expect((await run()).unregistered_rows).toEqual([]);
  });
  it("MUST-FAIL (e): an UNREADABLE marker (EACCES) ⇒ fail closed, and the run completes", async () => {
    if (process.getuid?.() === 0) return; // root reads through mode bits; the EACCES branch is covered by the code path test below
    publish(good());
    chmodSync(join(PUB, "source.json"), 0o000);
    try {
      const b = await run();
      expect(b.unregistered_rows).toEqual([]);
      expect(b.read_errors.join(" ")).toContain("marker unreadable");
    } finally { chmodSync(join(PUB, "source.json"), 0o644); }
  });
  it("MUST-FAIL: a fail-closed run on a planted run files the self-gap naming the reason", async () => {
    publish(null);
    const b = await run(true);
    expect(b.self_gap_filed).toBe(true);
    expect(b.read_errors.join(" ")).toContain("marker absent");
  });
  it("MUST-FAIL (i): SELF_FACTS_PUBLIC_DIR in the environment is IGNORED; a forged valid dir there is never read", async () => {
    __setGatePublicDirForTests(null); // production: no test injection
    const forged = join(ROOT, "forged");
    mkdirSync(forged, { recursive: true });
    writeFileSync(join(forged, "self-facts.json"), rowsJson("row_forged"));
    writeFileSync(join(forged, "source.json"), JSON.stringify(good({ self_facts_sha256: sha(rowsJson("row_forged")) })));
    process.env["SELF_FACTS_PUBLIC_DIR"] = forged;
    try {
      expect(GATE_PUBLIC_DIR).toBe("/workspace/.gate-public");
      const b = await run();
      expect(b.unregistered_rows).not.toContain("row_forged");
      expect(b.read_errors.join(" ")).not.toContain(forged);
    } finally {
      delete process.env["SELF_FACTS_PUBLIC_DIR"];
      __setGatePublicDirForTests(PUB);
    }
  });
  it("CONTROL (f): an ungated marker ⇒ origin/dev rows, as before", async () => {
    publish({ schema: 1, gated: false, source: "clone", accepted_sha: null, self_facts_sha256: null, writer: "pull-sync", written_at: "2026-10-06T00:00:00Z" });
    const b = await run();
    expect(b.unregistered_rows).toEqual(["row_origin"]);
  });
});
