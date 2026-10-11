// THE BOUNDARY IS operator_hold, NOT A PROSE BAN ON EVERY DRAINED GAP (check-first, 2026-10-08).
//
// specFromGap appended an "APPROVAL BOUNDARY ... The drafter MUST emit ZERO ops" clause to the anchor of every
// src-target gap whose metadata did not carry operator_approved === true. The origin gap asked for a filer-settable
// hold; the clause inverted that into deny-by-default prose. Drafters ignored it (they emitted ops on nearly every
// plan) except to forge approval: drafts that added operator_approved to make the clause go away. The boundary
// that removes a gap from autonomous work is operator_hold — deterministic, set by the filer, enforced at admission
// (admitActionableGaps) and at pick (pickMostLandable's skip). No prompt text stands in for it.
//
// Pinned here:
//   - a src-target gap with no operator_approved gets a spec with no approval-boundary clause (must fail at base);
//   - no code in src reads operator_approved (must fail at base; explanatory comments are allowed);
//   - CONTROL: operator_hold still excludes at admission, and the same gap with the hold cleared is admitted and
//     gets a grounded spec; the pick skip still returns true for a held gap.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { specFromGap } from "../../src/resolvers/gap-to-feature.js";
import { admitActionableGaps } from "../../src/judge/gap-admission.js";
import { __resetPolicyReadsForTests } from "../../src/judge/gap-policy.js";
import { openPolicyAnswer } from "./explicit-open-policy.fixture.js";

// HERMETIC VESSEL TREE (same seam as gap-to-feature-admission-compose-eligibility): MITOSIS_RUNTIME_DIR and
// VESSELS_CLONE_ROOT are read at call time, so the edit site exists only in this temp fixture.
const FIXTURE = mkdtempSync(join(tmpdir(), "no-approval-boundary-"));
if (!resolve(FIXTURE).startsWith(resolve(tmpdir()) + sep)) throw new Error(`fixture ${FIXTURE} is not under ${tmpdir()}`);
const SAVED_ENV = { runtime: process.env["MITOSIS_RUNTIME_DIR"], clones: process.env["VESSELS_CLONE_ROOT"] };
process.env["MITOSIS_RUNTIME_DIR"] = join(FIXTURE, "runtime");
process.env["VESSELS_CLONE_ROOT"] = join(FIXTURE, "clones");
mkdirSync(join(FIXTURE, "runtime", "development-vessel", "src", "resolvers"), { recursive: true });
mkdirSync(join(FIXTURE, "clones"), { recursive: true });
const SITE = "repos/development-vessel/src/resolvers/probe.ts";
writeFileSync(
  join(FIXTURE, "runtime", "development-vessel", "src", "resolvers", "probe.ts"),
  Array.from({ length: 60 }, (_, i) => (i === 19 ? "export function probeTarget() { return 1; }" : `export const probeFiller${i + 1} = ${i + 1};`)).join("\n"),
);

const originalFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body?.pointer?.type === "vesselCapability" && body.pointer.shape === "poolImpulse") {
      return Response.json({ content: { shape: "poolImpulse", vessels: [{ vesselId: "pool-fixture", endpoint: "http://pool.fixture", resolve_endpoint: "/v2/impulses/resolve", origin: "local" }], found: true } });
    }
    if (body?.impulse?.type === "poolImpulse") return openPolicyAnswer(body.impulse.shape);
    throw new TypeError("Unable to connect. Is the computer able to access the url?");
  }) as unknown as typeof fetch;
  __resetPolicyReadsForTests();
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  __resetPolicyReadsForTests();
  for (const [k, v] of [["MITOSIS_RUNTIME_DIR", SAVED_ENV.runtime], ["VESSELS_CLONE_ROOT", SAVED_ENV.clones]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(FIXTURE, { recursive: true, force: true });
});

const gap = (id: string, meta: Record<string, unknown>) => ({
  id, category: "systematic_failure", status: "open", summary: `probeTarget returns the wrong value (${id})`,
  classification_metadata: { falsifier: "class2", edit_site: SITE, ...meta },
});
const targets = [{ file: SITE, description: "" }];

describe("specFromGap carries no approval-boundary clause", () => {
  it("a src-target gap without operator_approved gets a grounded spec with no 'APPROVAL BOUNDARY' / 'MUST emit ZERO ops'", () => {
    const spec = specFromGap(gap("no-approval", {}), targets);
    // Positive control: the grounding branch the clause lived in ran (live file read, anchor emitted).
    expect(spec).toContain(`File facts: ${SITE}`);
    expect(spec).toContain("export function probeTarget() { return 1; }");
    expect(spec).not.toContain("APPROVAL BOUNDARY");
    expect(spec).not.toContain("MUST emit ZERO ops");
    expect(spec).not.toContain("operator_approved");
  });
});

describe("no code in src reads operator_approved", () => {
  const SRC = join(import.meta.dir, "..", "..", "src");
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith(".ts") ? [p] : [];
  });

  it("every occurrence of operator_approved in src is inside a comment", () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(50); // the walk saw the tree, not an empty dir
    const offenders: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        const at = line.indexOf("operator_approved");
        if (at < 0) return;
        const t = line.trimStart();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
        const comment = line.indexOf("//");
        if (comment >= 0 && comment < at) return;
        offenders.push(`${f.slice(SRC.length + 1)}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe("CONTROL: operator_hold is the boundary", () => {
  it("a held gap is excluded at admission with reason operator_hold", async () => {
    const r = await admitActionableGaps([gap("held", { operator_hold: true, operator_hold_reason: "test hold" })]);
    expect(r.admitted.map((g) => String(g.id))).toEqual([]);
    expect(r.excluded.find((e) => e.id === "held")?.reason).toBe("operator_hold");
  });

  it("the same gap with the hold cleared is admitted and gets a grounded spec", async () => {
    const cleared = gap("held", { operator_hold: false });
    const r = await admitActionableGaps([cleared]);
    expect(r.admitted.map((g) => String(g.id))).toEqual(["held"]);
    const spec = specFromGap(r.admitted[0]!, targets);
    expect(spec).toContain(`File facts: ${SITE}`);
  });

  it("the pick skip still returns true for a held gap (the closed pickSkipPending, gap-to-feature judge split A2)", async () => {
    const { pickSkipPending } = await import("../../src/judge/gap-admission.js");
    expect(pickSkipPending({ id: "held", classification_metadata: { operator_hold: true } }, [], new Map())).toBe(true);
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "judge", "gap-admission.ts"), "utf8");
    const pick = src.slice(src.indexOf("export function pickSkipPending("));
    const predicate = pick.slice(0, pick.indexOf("return verifyGapCondition(g) === 'pending';"));
    expect(predicate).toContain("const operatorHold = ((m as { operator_hold?: unknown }).operator_hold as boolean | undefined) === true;");
    expect(predicate).toContain("if (operatorHold) return true;");
  });
});
