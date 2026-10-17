// A spoke that cannot read the gap-store holder logs the holder's OWN answer (timeout, refusal or HTTP status), so its
// journal says why (gap a-spoke-cannot-read-the-gap-store-holder-so-its-gap-writes-are-refused-and-composes-fail-closed-
// and-the-rate-doubles-daily: ~1,000 "holder could not be read" lines/day on compose2, no reason in any). No behaviour
// change: the write is still refused the same way. MUST-FAIL on the parent: the log line carries no reason.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { redactAuthTokens } = await import("../../src/resolvers/substrate-gap.js");

const SRC = readFileSync(join(import.meta.dir, "..", "..", "src", "resolvers", "substrate-gap.ts"), "utf8");

describe("the holder-read refusal names the holder's answer", () => {
  it("[MUST-FAIL] the NOT forwarded log line includes the holder's response body", () => {
    const line = SRC.split("\n").find((l) => l.includes("NOT forwarded ${id}: the gap-store holder could not be read")) ?? "";
    expect(line).toContain("(holder said: ${redactAuthTokens(JSON.stringify(read?.body ?? null)).slice(0, 200)})");
  });
  it("[CONTROL] the refusal itself is unchanged: still a structuredError carrying the holder body in its detail", () => {
    expect(SRC).toContain("detail: `gap ${id}: not forwarded — the gap-store holder could not be read (${JSON.stringify(read?.body ?? null).slice(0, 200)}), so the write gates cannot be applied`,");
  });
  it("[MUST-FAIL] a credential echoed in the holder's body never reaches the log: ApiKey/Bearer tokens are masked", () => {
    const body = JSON.stringify({ error: "unauthorized", echoed: "Authorization: ApiKey sk-live-abc.DEF_123", also: "Bearer eyJhbGciOi.x.y" });
    const out = redactAuthTokens(body);
    expect(out).not.toContain("sk-live-abc.DEF_123");
    expect(out).not.toContain("eyJhbGciOi.x.y");
    expect(out).toContain("ApiKey [redacted]");
    expect(out).toContain("Bearer [redacted]");
  });
  it("[CONTROL] a body with no credential is unchanged", () => {
    const body = JSON.stringify({ detail: "gap store at http://x/v2/impulses/resolve unreachable: The operation timed out." });
    expect(redactAuthTokens(body)).toBe(body);
  });
});
