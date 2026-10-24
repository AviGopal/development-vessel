// UNDER THE TEST PRELOAD, NO TEST READS A SECRET PATH (test/preload.ts; cutover-fs-guard.ts installSecretReadGuard).
//
// The node gate runs the whole suite inside the live container. self-fact-reconcile's volumeNodeId() reads the vessel's
// identity key when VESSEL_IDENTITY_KEY_PATH is unset, so a test reaching it there opened the live key.
// MUST-FAIL: with VESSEL_IDENTITY_KEY_PATH unset, volumeNodeId() returns null and the guard recorded a BLOCKED read of
//   the default key path: the key is never opened. A plain read of the fleet env file is blocked the same way.
//   Both run ONLY once the guard is proven installed: without the preload this file fails at that precondition and
//   never touches either path (red at the parent, which has no preload).
// CONTROL: with VESSEL_IDENTITY_KEY_PATH naming a key under the tmpdir, volumeNodeId() reads it and names the node by
//   it; nothing is recorded. A read outside the secret roots passes.
import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as fsGuard from "./cutover-fs-guard.js";
import { volumeNodeId } from "../../src/resolvers/self-fact-reconcile.js";

const G = fsGuard as unknown as Partial<typeof fsGuard>;
const guardInstalled = () => (G.secretReadGuard?.() ?? null) !== null;
const take = () => G.takeSecretReadViolations?.() ?? [];
const saved = process.env["VESSEL_IDENTITY_KEY_PATH"];
afterEach(() => {
  if (saved === undefined) delete process.env["VESSEL_IDENTITY_KEY_PATH"];
  else process.env["VESSEL_IDENTITY_KEY_PATH"] = saved;
});

describe("test preload: blocked secret reads", () => {
  it("MUST-FAIL: volumeNodeId() with the key path unset never opens the key (blocked, recorded, null)", () => {
    expect(guardInstalled()).toBe(true);
    if (!guardInstalled()) return;
    delete process.env["VESSEL_IDENTITY_KEY_PATH"];
    const id = volumeNodeId();
    const recorded = take();
    expect({ id, blockedKeyRead: recorded.some((r) => /\/workspace\/keys\//.test(r)) }).toEqual({ id: null, blockedKeyRead: true });
  });

  it("MUST-FAIL: a read of the fleet env file throws EACCES and is recorded", () => {
    expect(guardInstalled()).toBe(true);
    if (!guardInstalled()) return;
    let code = "read";
    try { readFileSync("/etc/substrate/env", "utf8"); } catch (e) { code = String((e as NodeJS.ErrnoException).code); }
    expect({ code, recorded: take().length }).toEqual({ code: "EACCES", recorded: 1 });
  });

  it("CONTROL: a key under the tmpdir is read and names the node; a non-secret read passes; nothing recorded", () => {
    const dir = join(tmpdir(), `secret-read-control-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      const key = join(dir, "test.ed25519.pem");
      writeFileSync(key, generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }) as string);
      process.env["VESSEL_IDENTITY_KEY_PATH"] = key;
      expect(volumeNodeId()).toMatch(/^key-[0-9a-f]{12}$/);
      expect(readFileSync(key, "utf8")).toContain("PRIVATE KEY");
      expect(take()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
