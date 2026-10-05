// Which node this is must survive a container recreate. self-facts.json pins trust-root records per node
// (expected_by_node), keyed by thisNode(). It used to fall back to the container hostname when SUBSTRATE_NAME was
// unset, and the hostname changes on every recreate: node1 was recreated on 2026-10-04, its pins (keyed by the old
// hostname) stopped matching, and autonomy_scope_pinned + spend_envelope_pinned silently stopped judging it. The
// identity now comes from the vessel's own Ed25519 identity key, which discovery registration creates once under the
// volume (/workspace/keys) and which a recreate keeps: key-<first 12 hex of sha256(raw public key)>.
import { afterEach, describe, expect, it } from "bun:test";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { thisNode } from "../../src/resolvers/self-fact-reconcile.js";

const DIR = join(tmpdir(), `self-fact-node-identity-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(DIR, { recursive: true });
const saved = { name: process.env["SUBSTRATE_NAME"], key: process.env["VESSEL_IDENTITY_KEY_PATH"] };
afterEach(() => {
  if (saved.name === undefined) delete process.env["SUBSTRATE_NAME"]; else process.env["SUBSTRATE_NAME"] = saved.name;
  if (saved.key === undefined) delete process.env["VESSEL_IDENTITY_KEY_PATH"]; else process.env["VESSEL_IDENTITY_KEY_PATH"] = saved.key;
});

function keyFile(name: string): { path: string; id: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const path = join(DIR, `${name}.ed25519.pem`);
  writeFileSync(path, privateKey.export({ format: "pem", type: "pkcs8" }) as string, { mode: 0o600 });
  // Independent derivation: the raw 32-byte public key is the tail of its SPKI DER.
  const raw = (createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
  return { path, id: `key-${createHash("sha256").update(raw).digest("hex").slice(0, 12)}` };
}

describe("thisNode(): a volume-held identity, not the container hostname", () => {
  it("MUST-FAIL: with no SUBSTRATE_NAME, the node is named by its volume-held identity key, not by hostname()", () => {
    delete process.env["SUBSTRATE_NAME"];
    const k = keyFile("a");
    process.env["VESSEL_IDENTITY_KEY_PATH"] = k.path;
    expect(thisNode()).toBe(k.id);
    expect(thisNode()).not.toBe(hostname());
  });

  it("MUST-FAIL: the same key file gives the same id on every read (a recreate keeps the volume), a different key a different id", () => {
    delete process.env["SUBSTRATE_NAME"];
    const a = keyFile("b1");
    const b = keyFile("b2");
    process.env["VESSEL_IDENTITY_KEY_PATH"] = a.path;
    const first = thisNode();
    expect(thisNode()).toBe(first);
    expect(first).toBe(a.id);
    process.env["VESSEL_IDENTITY_KEY_PATH"] = b.path;
    expect(thisNode()).toBe(b.id);
    expect(b.id).not.toBe(a.id);
  });

  it("an operator-set SUBSTRATE_NAME still names the node (the explicit override other callers already use)", () => {
    process.env["SUBSTRATE_NAME"] = "compose2";
    process.env["VESSEL_IDENTITY_KEY_PATH"] = keyFile("c").path;
    expect(thisNode()).toBe("compose2");
  });

  it("MUST-FAIL: with no readable key the hostname is the last resort, and a key created later is picked up (absence is not cached)", () => {
    delete process.env["SUBSTRATE_NAME"];
    const later = join(DIR, "later.ed25519.pem");
    process.env["VESSEL_IDENTITY_KEY_PATH"] = later;
    expect(thisNode()).toBe(hostname());
    const k = keyFile("later");
    expect(k.path).toBe(later);
    expect(thisNode()).toBe(k.id);
  });
});
