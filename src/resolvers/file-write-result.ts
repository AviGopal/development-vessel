import type { ResolverResult } from "./types.js";

export async function fileWriteResult(pointer: unknown): Promise<ResolverResult> {
  const phrase = "the quick brown fox jumps";
  const words = phrase.split(/\s+/).length;
  const path = "/tmp/audit_count.txt";
  const payload = JSON.stringify({ count: words });
  const res = await fetch(`file://${path}`, {
    method: "PUT",
    body: payload,
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Failed to write to ${path}: ${res.status}`);
  }
  return {
    shape: "fileWriteResult",
    body: { written: true, path, count: words },
  };
}
