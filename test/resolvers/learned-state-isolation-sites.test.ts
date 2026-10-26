// EVERY DV TEST CHILD AND IN-PROCESS RUN RESOLVES LEARNED STATE UNDER ITS TEMP ROOT (2026-10-17; user stop-leak ruling).
// Two routes kept writing node1's LIVE learned state from tests after isolatedChildEnv landed for two children:
//   route 2: other children spawned with an env built from scratch (independent-landing-verdict's sweep child wrote
//            ilv-control / ilv-errors into the live gap-class-posteriors.json; the pending-land sweeps and the rest
//            the same way);
//   route 3: in-process files set WORKSPACE_ROOT only, so the real credit modules resolved GAP_CLASS_POSTERIOR_PATH &
//            co. to their /workspace defaults (child-gap-inherits-parent-check's cc-ctl-* classes).
// isolatedChildEnv covers route 2; isolateLearnedStateInProcess covers route 3. This file pins both, behaviourally
// against the REAL learning-credit module, and pins the wiring of every site, plus a class detector: any test file
// that sets WORKSPACE_ROOT and imports a learned-state writer must call the in-process helper.
// MUST-FAIL on the parent (9299ef08): isolateLearnedStateInProcess does not exist and none of these sites use it.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import * as iso from "./isolated-gap-store-run";

const REPO = join(import.meta.dir, "..", "..");
const SRC = (p: string) => readFileSync(join(REPO, p), "utf8");
const HELPER = join(import.meta.dir, "isolated-gap-store-run.ts");
const LC = join(REPO, "src", "judge", "learning-credit.js");

/** Run `code` in a bun child whose env is exactly `env`; returns the TABLES= line's JSON. */
function child(code: string, env: Record<string, string>, cwd: string): { tables: Record<string, string> | null; err: string } {
  const p = Bun.spawnSync([process.execPath, "-e", code], { env, cwd, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const out = new TextDecoder().decode(p.stdout);
  const m = /TABLES=(\{.*\})/.exec(out);
  return { tables: m ? (JSON.parse(m[1]!) as Record<string, string>) : null, err: (out + new TextDecoder().decode(p.stderr)).slice(-1500) };
}
const PRINT_TABLES = `const lc = await import(${JSON.stringify(LC)}); console.log("TABLES=" + JSON.stringify(Object.fromEntries(["class_posteriors", "close_oracle", "detector_credit", "priority_weights"].map((t) => [t, lc.tablePath(t)]))));`;
const under = (p: string, root: string) => resolve(p).startsWith(resolve(root) + "/");

describe("route 3: an in-process run resolves learned state under its temp root", () => {
  it("[MUST-FAIL] the in-process helper exists", () => {
    expect(typeof (iso as Record<string, unknown>)["isolateLearnedStateInProcess"]).toBe("function");
  });

  it("[MUST-FAIL] after isolateLearnedStateInProcess(root), the REAL learning-credit tables resolve under root (env started with no redirects)", () => {
    const root = mkdtempSync(join(tmpdir(), "iso-inproc-"));
    try {
      // The child starts the way an in-process test file did on route 3: WORKSPACE_ROOT only, no learned-state redirect.
      const code = `const h = await import(${JSON.stringify(HELPER)}); if (typeof h.isolateLearnedStateInProcess !== "function") { console.log("TABLES={}"); process.exit(0); } h.isolateLearnedStateInProcess(${JSON.stringify(root)}); ${PRINT_TABLES}`;
      const r = child(code, { HOME: root, PATH: process.env["PATH"] ?? "", WORKSPACE_ROOT: root }, root);
      expect(r.tables, r.err).not.toBeNull();
      expect(Object.keys(r.tables!).length, "helper absent: no table resolved").toBe(4);
      for (const [t, p] of Object.entries(r.tables!)) {
        expect(p.startsWith("/workspace"), `${t}=${p}`).toBe(false);
        expect(under(p, root), `${t}=${p}`).toBe(true);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 90_000);

  it("[CONTROL] without the helper the same child resolves the LIVE default (the route-3 leak is real at this address)", () => {
    const root = mkdtempSync(join(tmpdir(), "iso-inproc-ctl-"));
    try {
      const r = child(PRINT_TABLES, { HOME: root, PATH: process.env["PATH"] ?? "", WORKSPACE_ROOT: root }, root);
      expect(r.tables, r.err).not.toBeNull();
      expect(r.tables!["class_posteriors"]).toBe("/workspace/gap-class-posteriors.json");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 90_000);

  it("[CONTROL] a root outside tmpdir is REFUSED and process.env is left as it was", () => {
    const fn = (iso as Record<string, unknown>)["isolateLearnedStateInProcess"] as ((r: string) => unknown) | undefined;
    expect(typeof fn).toBe("function");
    const before = JSON.stringify(process.env);
    expect(() => fn!("/workspace")).toThrow(/refused/);
    expect(JSON.stringify(process.env)).toBe(before);
  });

  it("[MUST-FAIL] a scrubbed-env redirect already under tmpdir is kept, not replaced", () => {
    const root = mkdtempSync(join(tmpdir(), "iso-inproc-keep-"));
    try {
      const kept = join(root, "gcp.json");
      const code = `const h = await import(${JSON.stringify(HELPER)}); if (typeof h.isolateLearnedStateInProcess === "function") h.isolateLearnedStateInProcess(${JSON.stringify(join(root, "other"))}); ${PRINT_TABLES}`;
      const r = child(code, { HOME: root, PATH: process.env["PATH"] ?? "", WORKSPACE_ROOT: root, GAP_CLASS_POSTERIOR_PATH: kept }, root);
      expect(r.tables, r.err).not.toBeNull();
      expect(r.tables!["class_posteriors"]).toBe(kept);
      expect(under(r.tables!["detector_credit"]!, join(root, "other")), r.tables!["detector_credit"]).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 90_000);
});

describe("route 2: the env independent-landing-verdict's sweep child now gets", () => {
  it("resolves the REAL learning-credit tables under its root (its own calibration extras kept)", () => {
    const root = mkdtempSync(join(tmpdir(), "iso-ilv-"));
    try {
      const env = iso.isolatedChildEnv(root, {
        HOME: root, PATH: process.env["PATH"] ?? "", VESSELS_CLONE_ROOT: join(root, "clones"),
        EXPECTATION_CALIB_PATH: join(root, "calib.json"), CLOSE_ORACLE_CALIB_PATH: join(root, "close-oracle-calibration.json"),
        NODE_ENV: "test", TZ: "UTC",
      });
      const r = child(PRINT_TABLES, env, root);
      expect(r.tables, r.err).not.toBeNull();
      for (const [t, p] of Object.entries(r.tables!)) expect(under(p, root), `${t}=${p}`).toBe(true);
      expect(r.tables!["close_oracle"]).toBe(join(root, "close-oracle-calibration.json"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 90_000);
});

// Every spawn site whose child runs src code with an env built from scratch (route 2), as fixed here.
const CHILD_SITES: Array<[string, string]> = [
  ["test/resolvers/independent-landing-verdict.test.ts", "const env: Record<string, string> = isolatedChildEnv(ROOT, {"],
  ["test/judge-split/arming-only-landing.test.ts", "const env: Record<string, string> = isolatedChildEnv(ROOT, {"],
  ["test/resolvers/pending-sweep-held-slots.test.ts", "const env: Record<string, string> = isolatedChildEnv(ROOT, {"],
  ["test/resolvers/pending-sweep-non-discriminating-check.test.ts", "const env: Record<string, string> = isolatedChildEnv(ROOT, {"],
  ["test/resolvers/composer-interruption-sweep-owned-set.test.ts", "env: isolatedChildEnv(join(ROOT, \"ws\"), {"],
  ["test/resolvers/gap-event-publish-isolation.test.ts", "env: isolatedChildEnv(join(ROOT, \"child\"), { ACTIVITY_API_ENDPOINT: LISTENER }),"],
  ["test/resolvers/llm-completion-dispatch-transport-hop.test.ts", "env: isolatedChildEnv(mkdtempSync(join(tmpdir(), \"llm-hop-\")), {"],
  ["test/resolvers/vessel-mitosis-evaluate-child-env.test.ts", "const env = isolatedChildEnv(parentWs, { ...credentialFixture(home), WORKSPACE_ROOT: parentWs, MITOSIS_RUNTIME_DIR: root });"],
  ["test/resolvers/vessel-mitosis-evaluate-child-env.test.ts", "const env = isolatedChildEnv(parentWs, { ...credentialFixture(home), WORKSPACE_ROOT: parentWs });"],
];

describe("[WIRING] every fixed site uses the isolation", () => {
  for (const [file, needle] of CHILD_SITES) {
    it(`[MUST-FAIL] child site ${file}`, () => { expect(SRC(file)).toContain(needle); });
  }
  it("[MUST-FAIL] child-gap-inherits-parent-check isolates before src loads", () => {
    const s = SRC("test/resolvers/child-gap-inherits-parent-check.test.ts");
    const at = s.indexOf("isolateLearnedStateInProcess(ROOT);");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(s.indexOf('await import("../../src/'));
  });
  it("[MUST-FAIL] src/resolvers/substrate-gap.test.ts (cannot import test/) points the learned tables under its suite root", () => {
    const s = SRC("src/resolvers/substrate-gap.test.ts");
    for (const n of ["GAP_CLASS_POSTERIOR_PATH", "CLOSE_ORACLE_CALIB_PATH", "DETECTOR_CLOSURE_LEDGER_PATH", "EXPECTATION_CALIB_PATH"]) expect(s).toContain(`["${n}", `);
    expect(s.indexOf("process.env[name] = join(suiteRoot, file);")).toBeLessThan(s.indexOf("await import(`./substrate-gap.js"));
    expect(s.indexOf("process.env[name] = join(suiteRoot, file);")).toBeGreaterThan(-1);
  });
});

// The class detector (G1): a test file that sets WORKSPACE_ROOT in-process and imports a learned-state writer must call
// the in-process helper. `.cases.ts` files run only under runCasesIsolated (isolatedChildEnv), so they are exempt.
// The src/ branch requires the match to sit at the start of a relative import specifier (optionally after an
// opening quote/paren, or one or more "../"/"./" hops), not anywhere a fixture or assertion string happens to
// spell the same path: gap-check-supply-site-edit-site-wins.test.ts writes a fixture file literally named
// src/resolvers/substrate-gap.ts and asserts checkSupplySite()'s return value, which contains
// "…/src/resolvers/substrate-gap.ts" — neither is an import, and the old bare-substring match falsely flagged
// that file as an unisolated learned-state writer.
// NOT A WIDENING (qa, 2026-10-25): the offender SET is identical at the fix's parent (8692a8ff) and its tip
// except for that one false positive — {gap-check-supply-site-edit-site-wins.test.ts} -> {}. Scanned drops 133 ->
// 129 because 3 files lose their ONLY match (the same false-positive shape, a fixture/assertion string, not an
// import) while they were never offenders: scope-change-pin.test.ts:16 and pool-record-pin-policy.test.ts:12 both
// read `isolateLearnedStateInProcess(process.env["WORKSPACE_ROOT"]!);`, and self-fact-trust-completion.test.ts:19
// reads `isolateLearnedStateInProcess(ROOT);` — all three already call the helper. A genuine offender (a real
// relative import, e.g. `from "../../src/resolvers/substrate-gap.js"`, with no isolateLearnedStateInProcess call)
// still matches WRITER and is still flagged: only the position moved (must start an import specifier), not the
// set of real imports the regex recognises.
const WRITER =/(?:^|["'`(]|\.\.\/|\.\/)(?:\.\.\/|\.\/)*src\/(?:resolvers\/(?:substrate-gap|gap-to-feature|feature-compose|auto-revert)|judge\/(?:gap-attempt-credit|learning-credit|gap-landing-verdict|gap-admission|gap-policy))|close-oracle|expectation-calib|detector-closure/;
const SETS_WS = /process\.env(\["WORKSPACE_ROOT"\]|\.WORKSPACE_ROOT) *(=|\?\?=|\|\|=)[^=]/;
function testFiles(d: string, out: string[] = []): string[] {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) { if (n !== "node_modules" && n !== "fixtures") testFiles(p, out); continue; }
    if (/\.ts$/.test(n) && !/\.cases\.ts$/.test(n)) out.push(p);
  }
  return out;
}

describe("[DETECTOR] no in-process test file drives a learned-state writer with WORKSPACE_ROOT alone", () => {
  it("[MUST-FAIL] every WORKSPACE_ROOT-setting file that imports a writer calls isolateLearnedStateInProcess", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const f of testFiles(join(REPO, "test"))) {
      const s = readFileSync(f, "utf8");
      if (!SETS_WS.test(s) || !WRITER.test(s)) continue;
      if (f === join(import.meta.dir, "learned-state-isolation-sites.test.ts")) continue;
      scanned++;
      if (!s.includes("isolateLearnedStateInProcess(")) offenders.push(relative(REPO, f));
    }
    expect(scanned).toBeGreaterThan(40); // positive control: the detector saw the population it guards
    expect(offenders).toEqual([]);
  });
});
