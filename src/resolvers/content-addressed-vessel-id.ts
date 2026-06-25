import { createHash } from "node:crypto";
import type { ResolverResult } from "./types.js";

export interface ContentAddressedVesselIdPointer {
  type: "contentAddressedVesselId";
  /** Vessel public key (string) to derive a content-addressed id from. */
  pubkey: string;
}

// RFC4648 base32 alphabet, lowercase, no padding.
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32NoPad(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | (bytes[i] ?? 0);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >>> bits) & 0x1f]!;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 0x1f]!;
  return out;
}

/**
 * contentAddressedVesselId (2026-06-25) — content-addressed vessel identity, the
 * structural-alignment primitive of SUBSTRATE_AS_NETWORK.md §1 / SUBSTRATE_AS_FLEET.md §2:
 *
 *   vessel_id = base32(multihash(SHA-256, pubkey))
 *
 * Two registrations of the SAME pubkey produce the SAME id regardless of which
 * discovery-vessel saw it first — what makes two substrates' structural lattices
 * comparable, the prerequisite for peer-aware /resolve and cross-substrate merge.
 *
 * PROVENANCE: the substrate filed this capability gap itself (leaf→authoring
 * escalation in goal-host), and feature_compose authored typecheck-clean variants
 * of it autonomously, but could not RELIABLY reach a complete + fully-verified
 * wiring across its 3 files (the documented S1→S2 authoring-quality frontier), so
 * the operator finalized this one. Pure, dependency-free (node:crypto).
 */
export function resolveContentAddressedVesselId(
  pointer: ContentAddressedVesselIdPointer,
): ResolverResult {
  const digest = createHash("sha256").update(pointer.pubkey ?? "").digest();
  // multihash framing: 0x12 (sha2-256 code), 0x20 (32-byte digest length), then digest.
  const multihash = new Uint8Array(2 + digest.length);
  multihash[0] = 0x12;
  multihash[1] = 0x20;
  multihash.set(new Uint8Array(digest), 2);
  return { shape: "contentAddressedVesselId", body: { vessel_id: base32NoPad(multihash) } };
}
