import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const POLICY_PATH =
  process.env["DOC_FIX_POLICY_PATH"] ?? "/workspace/doc-fix-policy.json";

interface DocFixPolicyPointer {
  type: "docFixPolicy";
}

interface DocFixPolicyWritePointer {
  type: "docFixPolicy_write";
  autoland: boolean;
  set_by?: string;
  reason?: string;
}

interface DocFixPolicyBody {
  autoland: boolean;
  set_by?: string;
  set_at?: string;
  reason?: string;
}

export function resolveDocFixPolicy(
  _pointer: DocFixPolicyPointer,
): { shape: "docFixPolicy"; body: DocFixPolicyBody } {
  let body: DocFixPolicyBody = { autoland: false };
  try {
    const raw = readFileSync(POLICY_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "autoland" in parsed &&
      typeof (parsed as Record<string, unknown>)["autoland"] === "boolean"
    ) {
      const p = parsed as Record<string, unknown>;
      body = {
        autoland: p["autoland"] as boolean,
        set_by: typeof p["set_by"] === "string" ? p["set_by"] : undefined,
        set_at: typeof p["set_at"] === "string" ? p["set_at"] : undefined,
        reason: typeof p["reason"] === "string" ? p["reason"] : undefined,
      };
    }
  } catch {
    // file absent or unparseable — return safe default
    body = { autoland: false };
  }
  return { shape: "docFixPolicy", body };
}

export function resolveDocFixPolicyWrite(
  pointer: DocFixPolicyWritePointer,
): { shape: "docFixPolicyWriteResult"; body: { ok: true; autoland: boolean } } {
  const { autoland, set_by, reason } = pointer;
  const data: DocFixPolicyBody & { set_at: string } = {
    autoland,
    set_by: set_by ?? "unattributed",
    set_at: new Date().toISOString(),
    reason: reason ?? "",
  };
  const json = JSON.stringify(data, null, 2);
  const tmp = join(tmpdir(), `doc-fix-policy-${Date.now()}.json.tmp`);
  writeFileSync(tmp, json, "utf8");
  renameSync(tmp, POLICY_PATH);
  return { shape: "docFixPolicyWriteResult", body: { ok: true, autoland } };
}
