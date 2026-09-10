// env-gate-scan: the five conditions a finding must satisfy, and the four it must not.
//
// WHY THIS FILE EXISTS. This resolver was the last uncovered target reported by the
// effect-coverage check after the reader was fixed, so changes to it landed reviewed but
// never executed.
//
// What makes it worth pinning is that it is almost entirely exclusion rules. A finding is
// raised only when an env read is non-secret, has no inline default, names a variable that
// is not set anywhere, and sits within four lines of a guard. Any one of those loosening
// turns this scanner into a noise generator, and any one tightening silently empties it —
// and an empty scanner reads exactly like a clean substrate. Nothing else in the repo
// holds those rules in place.
//
// Fixtures are written to a temp directory and every case passes dry_run so the scan
// emits nothing. No network, no writes outside the temp tree.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveEnvGateScan } from "../../src/resolvers/env-gate-scan";

let root = "";
let envFile = "";
let unitsDir = "";

/** A read followed by a guard on the next line — the shape a finding requires. */
function gated(read: string): string {
  return [`const v = ${read};`, "if (!v) {", "  return null;", "}"].join("\n");
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "envgate-"));
  const src = path.join(root, "probe-vessel", "src");
  fs.mkdirSync(src, { recursive: true });

  fs.writeFileSync(path.join(src, "unset-gated.ts"), gated("process.env.FEATURE_ENABLED"));
  fs.writeFileSync(path.join(src, "set-gated.ts"), gated("process.env.CONFIGURED_ONE"));
  fs.writeFileSync(path.join(src, "secret-gated.ts"), gated("process.env.SOME_API_KEY"));
  fs.writeFileSync(path.join(src, "defaulted.ts"), gated('process.env.HAS_DEFAULT ?? "x"'));
  fs.writeFileSync(path.join(src, "unguarded.ts"), "const v = process.env.NO_GUARD_HERE;\nconsole.log(v);\n");
  // Must be skipped by the walker even though it contains a qualifying read.
  fs.writeFileSync(path.join(src, "ignored.test.ts"), gated("process.env.INSIDE_A_TEST"));
  const nm = path.join(src, "node_modules", "dep");
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(nm, "vendored.ts"), gated("process.env.INSIDE_NODE_MODULES"));

  envFile = path.join(root, "env");
  fs.writeFileSync(envFile, "CONFIGURED_ONE=1\nUNRELATED=2\n");
  unitsDir = path.join(root, "units");
  fs.mkdirSync(unitsDir, { recursive: true });
  fs.writeFileSync(path.join(unitsDir, "a.service"), "[Service]\nEnvironment=FROM_A_UNIT=1\n");
  fs.writeFileSync(path.join(unitsDir, "notaunit.txt"), "Environment=IGNORED_NON_UNIT=1\n");
});

afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

async function names(): Promise<string[]> {
  const r = await resolveEnvGateScan({ rootDir: root, envFile, unitsDir, dry_run: true } as never);
  const body = r.body as { findings?: { env_name: string }[] };
  return (body.findings ?? []).map((f) => f.env_name).sort();
}

describe("what it flags", () => {
  test("an unset, non-secret, guarded read with no inline default", async () => {
    expect(await names()).toContain("FEATURE_ENABLED");
  });
});

describe("what it must not flag", () => {
  test("a variable set in the env file", async () => {
    expect(await names()).not.toContain("CONFIGURED_ONE");
  });

  test("a secret-shaped name, even when unset and guarded", async () => {
    // Secrets are legitimately env-only; flagging them would bury the real findings.
    expect(await names()).not.toContain("SOME_API_KEY");
  });

  test("a read carrying its own inline default", async () => {
    // With a fallback the capability is not gated off, merely configurable.
    expect(await names()).not.toContain("HAS_DEFAULT");
  });

  test("a read with no guard within the window", async () => {
    expect(await names()).not.toContain("NO_GUARD_HERE");
  });

  test("a read inside a .test.ts file", async () => {
    expect(await names()).not.toContain("INSIDE_A_TEST");
  });

  test("a read inside node_modules", async () => {
    expect(await names()).not.toContain("INSIDE_NODE_MODULES");
  });
});

describe("where it learns that a variable is set", () => {
  test("a unit file's Environment= line counts as set, so it is not flagged", async () => {
    const src = path.join(root, "probe-vessel", "src");
    fs.writeFileSync(path.join(src, "unit-provided.ts"), gated("process.env.FROM_A_UNIT"));
    try {
      expect(await names()).not.toContain("FROM_A_UNIT");
    } finally {
      fs.rmSync(path.join(src, "unit-provided.ts"), { force: true });
    }
  });

  test("a non-.service file in the units directory does not count as set", async () => {
    const src = path.join(root, "probe-vessel", "src");
    fs.writeFileSync(path.join(src, "nonunit.ts"), gated("process.env.IGNORED_NON_UNIT"));
    try {
      // Only .service files are read; a stray .txt must not silently suppress a finding.
      expect(await names()).toContain("IGNORED_NON_UNIT");
    } finally {
      fs.rmSync(path.join(src, "nonunit.ts"), { force: true });
    }
  });
});

describe("absent inputs", () => {
  test("a missing env file and units directory yield no crash and still scan", async () => {
    const r = await resolveEnvGateScan({
      rootDir: root,
      envFile: path.join(root, "does-not-exist"),
      unitsDir: path.join(root, "no-units"),
      dry_run: true,
    } as never);
    const body = r.body as { findings?: { env_name: string }[] };
    // CONFIGURED_ONE is only known-set via the env file; without it, it must surface.
    expect((body.findings ?? []).map((f) => f.env_name)).toContain("CONFIGURED_ONE");
  });
});
