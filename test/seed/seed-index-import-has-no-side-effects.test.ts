/**
 * IMPORTING THE SEED REGISTRY MUST DO NOTHING BUT DEFINE IT.
 *
 * src/seed/index.ts is imported by the CLI seeder, by resolvers the server loads
 * (template-input-lint-scan), and by this test suite — which pull-sync's landing gate runs AS
 * ROOT INSIDE THE CONTAINER, where 127.0.0.1:8080 is the live trace store. It used to run
 * `systemctl --user restart development-vessel-seed.service` at module import, so every
 * import (every test run, every resolver load) shelled out to systemd. Delivering seeds is a
 * startup action of the vessel SERVER (scheduleSeedDelivery, called from
 * startDiscoveryRegistration), never an import-time effect.
 *
 * Measured in a fresh child process so the import graph is cold (bun shares one module
 * registry across test files, and other suites import the registry first):
 *   - a `systemctl` shim first on PATH records any attempt to run it;
 *   - globalThis.fetch is wrapped before the import and counts every call (answering 503
 *     itself, so nothing leaves the process);
 *   - every configured endpoint points at a local recorder, as defence in depth against any
 *     channel other than fetch.
 * The child waits long enough for any deferred (microtask / setTimeout) side effect to fire.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SEED_INDEX = join(import.meta.dir, "../../src/seed/index.ts");

let dir = "";
let recorderHits = 0;
let recorder: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "seed-import-"));
  const shimDir = join(dir, "bin");
  Bun.spawnSync(["mkdir", "-p", shimDir]);
  const shim = join(shimDir, "systemctl");
  writeFileSync(shim, `#!/bin/sh\necho "$@" >> "${join(dir, "systemctl-called")}"\n`);
  chmodSync(shim, 0o755);
  writeFileSync(
    join(dir, "child.ts"),
    [
      "let calls = 0;",
      "globalThis.fetch = (async () => { calls++; return new Response('', { status: 503 }); }) as unknown as typeof fetch;",
      `await import(${JSON.stringify(SEED_INDEX)});`,
      "await new Promise((r) => setTimeout(r, 1500));",
      "console.log(`FETCH_CALLS=${calls}`);",
    ].join("\n"),
  );
  recorder = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      recorderHits++;
      return new Response("", { status: 503 });
    },
  });
});

afterAll(() => {
  recorder?.stop(true);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("src/seed/index.ts import", () => {
  it("runs no child process and makes no network call", async () => {
    const at = `http://127.0.0.1:${recorder!.port}`;
    const proc = Bun.spawn([process.execPath, join(dir, "child.ts")], {
      cwd: join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: `${join(dir, "bin")}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
        HOME: process.env["HOME"] ?? dir,
        METABOB_ENDPOINT: at,
        DISCOVERY_ENDPOINT: at,
        GOAL_HOST_VESSEL_ENDPOINT: at,
        CONCEPT_DB_ENDPOINT: at,
        METABOB_API_KEY: "test-key",
      },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
    expect(existsSync(join(dir, "systemctl-called"))).toBe(false);
    expect(stdout).toContain("FETCH_CALLS=0");
    expect(recorderHits).toBe(0);
  }, 20_000);
});
