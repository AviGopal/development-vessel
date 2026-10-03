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
import { sweepSrc, sweepFile, describeSite, sweepResolveSrc, sweepResolveFile, describeResolveSite } from "./self-call-sweep.js";

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

// CLASS CHECK: the node key never follows a URL a request's pointer can supply. A site whose URL can start
// with a value read off a request (`pointer.devVesselImpulsesUrl ?? DEFAULT`, `pointer.obsidianEndpoint ??
// DEFAULT`) and whose headers carry the key without the selfAuthHeaders(url, DEFAULT) guard hands the node
// credential to whoever wrote the pointer. How a URL is read is documented in ./self-call-sweep.ts
// (EVERY RESOLVE CALL).
describe("resolve-call sweep: the node key never follows a caller-supplied URL", () => {
  const sites = sweepResolveSrc();
  const keyToCallerUrl = sites.filter((s) => s.authed && s.callerUrl && !s.guarded).map(describeResolveSite);
  console.log(
    `resolve-call sweep: ${sites.length} sites in ${new Set(sites.map((s) => s.file)).size} files; ` +
      `${keyToCallerUrl.length} send a key to a caller-suppliable URL unguarded`,
  );

  it("the node key never follows a caller-supplied URL without the selfAuthHeaders guard", () => {
    expect(keyToCallerUrl).toEqual([]);
  });

  // POSITIVE CONTROLS: a URL reader that sees nothing passes vacuously.
  it("classifies the repo's resolve calls (a reader that sees nothing cannot pass)", () => {
    expect(sites.length).toBeGreaterThanOrEqual(150);
    const inFile = (file: string) => sites.filter((s) => s.file === file);
    // pointer.registry_endpoint ?? SELF_RESOLVE_URL through a fetchJson wrapper, key behind selfAuthHeaders
    expect(inFile("resolvers/rhythm-conductor-tick.ts")).toContainEqual(expect.objectContaining({ authed: true, callerUrl: true, guarded: true }));
    // pointer.devVesselImpulsesUrl ?? "…/v2/impulses/resolve", key attached
    expect(inFile("resolvers/env-gate-scan.ts")).toContainEqual(expect.objectContaining({ authed: true, callerUrl: true }));
  });

  it("flags each side of the predicate (fixture)", () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-sweep-"));
    const path = join(dir, "fixture.ts");
    writeFileSync(
      path,
      [
        `import { selfAuthHeaders } from "./self-auth.js";`,
        `const DISCOVERY = process.env.DISCOVERY_ENDPOINT ?? "http://127.0.0.1:8100";`,
        `const SELF = "http://127.0.0.1:8090/v2/impulses/resolve";`,
        `const KEY = process.env.METABOB_API_KEY ?? "";`,
        `export async function bareRead() { await fetch(\`\${DISCOVERY}/resolve\`, { method: "POST", headers: { "Content-Type": "application/json" } }); }`,
        `export async function authedRead() { await fetch(\`\${DISCOVERY}/resolve\`, { method: "POST", headers: { Authorization: \`ApiKey \${KEY}\` } }); }`,
        `export async function leak(pointer: { url?: string }) {`,
        `  const url = pointer.url ?? SELF;`,
        `  await fetch(url, { method: "POST", headers: { Authorization: \`ApiKey \${KEY}\` } });`,
        `}`,
        `export async function guarded(pointer: { url?: string }) {`,
        `  const url = pointer.url ?? SELF;`,
        `  await fetch(url, { method: "POST", headers: { ...selfAuthHeaders(url, SELF) } });`,
        `}`,
        `export async function notResolve() { await fetch(\`\${DISCOVERY}/health\`); }`,
        `export async function identity(base: string) { await fetch(\`\${base}/v1/auth/resolve\`, { method: "POST" }); }`,
        `async function post(u: string, init: RequestInit) { return fetch(u, init); }`,
        `export async function viaWrapper(input: { endpoint: string }) { await post(input.endpoint + "/resolve", { method: "POST" }); }`,
      ].join("\n"),
    );
    const got = sweepResolveFile(path).map((s) => ({ line: s.line, authed: s.authed, callerUrl: s.callerUrl, guarded: s.guarded }));
    expect(got).toEqual([
      { line: 5, authed: false, callerUrl: false, guarded: false },
      { line: 6, authed: true, callerUrl: false, guarded: false },
      { line: 9, authed: true, callerUrl: true, guarded: false },
      { line: 13, authed: true, callerUrl: true, guarded: true },
      { line: 18, authed: false, callerUrl: true, guarded: false },
    ]);
  });
});
