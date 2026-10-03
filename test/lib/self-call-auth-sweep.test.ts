// CLASS CHECK: no HTTP self-call under src/ sends a write without Authorization.
//
// The resolve route refuses every `*_write` and mutating primitive that does not carry an ApiKey
// (src/lib/caller-credential.ts isWritePointerType), and this vessel calls its own route from its rhythms,
// detectors and gap filing. A self-call without the header is refused 401 and, being best-effort, swallowed:
// on a live node the rhythm conductor's settlements were refused for exactly this reason and nothing said so.
// This sweep runs in the vessel's own suite, so every landing is checked for the class, not only the one
// instance that was noticed. How a site is found is documented in ./self-call-sweep.ts.
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepSrc, sweepFile, describeSite } from "./self-call-sweep.js";

describe("self-call auth sweep", () => {
  const sites = sweepSrc();

  it("every self-call that can write carries an Authorization header", () => {
    const offenders = sites.filter((s) => !s.authed).map(describeSite);
    expect(offenders).toEqual([]);
  });

  // POSITIVE CONTROLS: an AST walk that silently matches nothing reports zero offenders. These pin that the
  // sweep sees the self-writes the repo is known to make, and judges a known-good one as authed.
  it("classifies the repo's self-writes (a walker that sees nothing cannot pass)", () => {
    expect(sites.length).toBeGreaterThanOrEqual(40);
    const known = (file: string): boolean => sites.some((s) => s.file === file && s.writes.includes("substrateGap_write") && s.authed);
    expect(known("resolvers/solicitation-outcome-scan.ts")).toBe(true); // inline conditional spread
    expect(known("resolvers/capability-gap-audit.ts")).toBe(true); // headers["Authorization"] = … in a wrapper
    expect(known("resolvers/ui-legibility-scan.ts")).toBe(true); // a selfAuth headers variable
    expect(sites.some((s) => s.file === "resolvers/rhythm-conductor-tick.ts" && s.writes.includes("poolImpulse_write"))).toBe(true);
  });

  it("flags an unauthenticated self-write and passes an authenticated one (fixture)", () => {
    const dir = mkdtempSync(join(tmpdir(), "self-sweep-"));
    const path = join(dir, "fixture.ts");
    writeFileSync(
      path,
      [
        `const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";`,
        `const OTHER = "http://127.0.0.1:8080/v2/impulses/resolve";`,
        `async function post(url: string, init: RequestInit) { return fetch(url, { ...init, signal: AbortSignal.timeout(1) }); }`,
        `export async function bare(p: { url?: string }) {`,
        `  await post(p.url ?? DEFAULT_DEV_VESSEL_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ impulse: { type: "poolImpulse_write" } }) });`,
        `}`,
        `export async function authed() {`,
        `  const h: Record<string, string> = {};`,
        `  if (process.env.K) { h["Authorization"] = "ApiKey " + process.env.K; }`,
        `  await fetch(DEFAULT_DEV_VESSEL_URL, { method: "POST", headers: h, body: JSON.stringify({ impulse: { pointer: { type: "fs_write" } } }) });`,
        `}`,
        `export async function notSelf() {`,
        `  await fetch(OTHER, { method: "POST", body: JSON.stringify({ impulse: { type: "substrateGap_write" } }) });`,
        `}`,
        `export async function dynamic(t: string) {`,
        `  await fetch(DEFAULT_DEV_VESSEL_URL, { method: "POST", body: JSON.stringify({ impulse: { type: t } }) });`,
        `}`,
        `export async function read() {`,
        `  await fetch(DEFAULT_DEV_VESSEL_URL, { method: "POST", body: JSON.stringify({ impulse: { type: "substrateGap" } }) });`,
        `}`,
      ].join("\n"),
    );
    const got = sweepFile(path).map((s) => ({ line: s.line, writes: s.writes, authed: s.authed }));
    expect(got).toEqual([
      { line: 5, writes: ["poolImpulse_write"], authed: false },
      { line: 10, writes: ["fs_write"], authed: true },
      { line: 16, writes: ["<dynamic:t>"], authed: false },
    ]);
  });
});
