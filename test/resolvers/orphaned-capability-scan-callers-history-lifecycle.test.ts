// CHECK-FIRST (RED) — orphaned_capability_scan: who counts as a caller, where callers are looked
// for, what history says about a caller that went away, and how an orphan gap lives and dies.
//
// What the scan does today (origin/dev), and why each test below exists:
//
//   * A "caller" is any non-test *.ts file under ${WORKSPACE_ROOT}/repos whose text CONTAINS the
//     shape name (`grep -rl <shape>`). The producer's OWN registration — its discovery list entry,
//     its `case "<shape>":` dispatch label, its pointer interface — contains the name, so every
//     shape with a producer in repos/ has a "caller" and is never orphaned. The rewire branch of
//     the gap (candidate consumers) is therefore dead, and every gap that IS emitted prescribes a
//     mint.                                                                       → tests 1, 2
//   * Nothing outside repos/ is searched, so a real caller under scripts/ or packages/ is
//     invisible and its shape is reported orphaned.                               → test 3
//   * Git history is never read, so a caller that EXISTED and was deleted by a commit (the
//     af61dee mitosis cutover deleted goal-host's only author_composed_capability call) cannot be
//     told apart from a capability nobody ever wanted: the prescription is mint, never
//     restore-or-retire.                                                          → test 1
//   * Any CLOSED orphan gap suppresses its shape forever; a rejection is an untyped status flip;
//     a caller appearing never closes the gap; `foo-bar` and `foo_bar` are two gaps; and every
//     tick re-writes every open orphan gap.                                       → tests 4, 5
//
// HERMETIC. Every input is built in a fresh temp dir and injected through seams the scanner
// already has: WORKSPACE_ROOT (the root its consumer search reads) and the three endpoint fields
// on the pointer (discovery, activity-api, dev-vessel impulses). `fetch` is spied (not replaced
// process-wide) and answered by an in-memory, STATEFUL gap store, so a write in one run is what
// the next run reads. No live service, no /workspace, no DB.
//
// FIELD CONTRACT (the names the fix must write; chosen to mirror gap_lifecycle_scan's existing
// `classification_metadata.closed_reason` / `closed_by` convention):
//   lost caller   cm.orphan_kind = "lost_caller", cm.repair_direction = "restore_or_retire",
//                 cm.lost_caller = { file: "<repo-relative path>", commit: "<full sha>" }
//   fingerprint   cm.fingerprint — a function of (normalised shape, caller set); a closed or
//                 rejected gap suppresses re-emission ONLY while its fingerprint is current.
//   reject        status "rejected", cm.rejected_by (actor), cm.rejected_at (ISO),
//                 cm.rejected_reason, cm.terminal = false
//   close         status "closed", cm.closed_reason = "consumer_appeared",
//                 cm.closed_by = "orphaned_capability_scan", cm.consumer_appeared = "<file>:<line>"
//                 (or a commit sha)
//   gap id        `orphaned-capability-<shape with "-" normalised to "_">`
//   grandfather   a closed/rejected row with NO fingerprint (written before fingerprints existed)
//                 is treated as CURRENT: it is not reopened. The one exception is a row rejected
//                 for `no_live_producer` (cm.unreachable_reason / cm.rejected_reason), whose
//                 condition clears when the producer is live again (non-terminal reject).
//   flap guard    that no_live_producer reopen fires only once the producer has been live for
//                 >= N consecutive scan records (N = pointer.reopen_after_live_records), counted
//                 from the newest record back; one live tick is not enough. The scanner reads
//                 its prior records with a `{ type: "orphanedCapabilityScanRecord" }` resolve to
//                 the dev-vessel impulses URL (answered as { body: { records: [...] } }, newest
//                 last), so each record also carries `live_shapes`.
//                 Lazy backfill of cm.fingerprint onto such rows is optional, keeps their status,
//                 and is capped per tick by pointer.max_backfill.
//   scan record   exactly ONE `orphanedCapabilityScanRecord_write` per emitting tick, posted to
//                 the dev-vessel impulses URL: { record: { detector: "orphaned_capability_scan",
//                 generated_at, live_shapes, orphans: [{ shape, gap_id, fingerprint }] } } — the full current
//                 orphan set, including orphans whose gap write was suppressed. It replaces per-gap
//                 re-writes as the "still detected" signal.
//   expiry        consumed by gap_lifecycle_scan — see
//                 gap-lifecycle-scan-orphan-expiry-scan-record.test.ts
//
// CALL vs REGISTRATION (qa ruling): a CALL — `pointer: { type: "X" }` — counts in ANY file,
// the producer's own vessel included. REGISTRATION syntax (discovery list entries, `case "X":`
// labels, SUPPORTED_SHAPES sets, the pointer interface) never counts.

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveOrphanedCapabilityScan } from "../../src/resolvers/orphaned-capability-scan.js";

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const FIXTURE_DIR = new URL("../fixtures/orphaned-capability-scan/", import.meta.url).pathname;
// The REAL goal-host-vessel src/index.ts on either side of af61dee ("substrate-authored: apply
// unknown-proposal via mitosis cutover"), byte-for-byte from `git show`. Stored as .txt so tsc and
// editors do not compile 7,700 lines of another vessel; written back as src/index.ts at test time.
const GOAL_HOST_BEFORE = readFileSync(join(FIXTURE_DIR, "goal-host-index.before-af61dee.txt"), "utf8");
const GOAL_HOST_AFTER = readFileSync(join(FIXTURE_DIR, "goal-host-index.at-af61dee.txt"), "utf8");
// Provenance: the git blob ids of af61dee^:src/index.ts and af61dee:src/index.ts in goal-host-vessel.
const BLOB_BEFORE = "f87f01afdb5eec5deee09e2c792e6594bdcfa7d6";
const BLOB_AFTER = "ae63df764066ace6c4253f154f963af94963210f";
const UPSTREAM_AF61DEE = "af61deea06fa22168afad9b1e89a0e4ed04771a9";

function gitBlobSha1(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  const h = new Bun.CryptoHasher("sha1");
  h.update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
  return h.digest("hex");
}

// The producer, as development-vessel actually registers author_composed_capability: a discovery
// list entry (config.ts), a dispatch label (routes/impulses.ts), and its own resolver module whose
// pointer interface and error envelope name the shape. NONE of these is a call. (feature-compose.ts
// is deliberately NOT copied: on origin/dev it holds a genuine in-vessel call at :5087.)
const DEV_VESSEL_PRODUCER: Record<string, string> = {
  "repos/development-vessel/src/config.ts":
    `export const RESOLVER_SHAPES = [\n  "residual_shape_discovery",\n  "activate_substrate_script",\n  "author_composed_capability",\n  "feature_compose",\n];\n`,
  "repos/development-vessel/src/routes/impulses.ts":
    `export async function dispatch(p: { type: string }) {\n  switch (p.type) {\n    case "author_composed_capability":\n      return resolveAuthorComposedCapability(p as never);\n  }\n}\ndeclare function resolveAuthorComposedCapability(p: never): unknown;\n`,
  "repos/development-vessel/src/resolvers/author-composed-capability.ts":
    `export interface AuthorComposedCapabilityPointer {\n  type: "author_composed_capability";\n  goal?: string;\n}\nfunction structuredError(detail: string) {\n  return { shape: "structuredError", body: { resolver: "author_composed_capability", error: detail } };\n}\nexport function resolveAuthorComposedCapability(p: AuthorComposedCapabilityPointer) {\n  return p.goal ? { shape: "ok", body: {} } : structuredError("author_composed_capability requires pointer.goal");\n}\n`,
};

// A template corpus that is non-empty (else the scan reports `degraded` and does nothing) and that
// invokes none of the shapes under test.
const TEMPLATES = [{ id: "activity:⟨reads-files⟩", tasks: [{ resolver: "fs_read" }] }];

// ---------------------------------------------------------------------------------------------
// Temp workspace + git
// ---------------------------------------------------------------------------------------------

let ws = "";
let priorRoot: string | undefined;

function put(root: string, rel: string, content: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}): string {
  const r = Bun.spawnSync(
    ["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: ws,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        ...extraEnv,
      },
    },
  );
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout).trim();
}

/** Replay goal-host's src/index.ts across af61dee in a throwaway repo; returns the removal sha. */
function replayAf61dee(root: string, upTo: "before" | "after"): { repo: string; removalSha: string | null } {
  const repo = join(root, "repos/goal-host-vessel");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, ["init", "-q", "-b", "dev"]);
  writeFileSync(join(repo, "src/index.ts"), GOAL_HOST_BEFORE);
  git(repo, ["add", "src/index.ts"]);
  git(repo, ["commit", "-q", "-m", "goal-host: state at af61dee^"], {
    GIT_AUTHOR_DATE: "2026-06-28T00:15:24-07:00",
    GIT_COMMITTER_DATE: "2026-06-28T00:15:24-07:00",
  });
  if (upTo === "before") return { repo, removalSha: null };
  writeFileSync(join(repo, "src/index.ts"), GOAL_HOST_AFTER);
  git(repo, ["add", "src/index.ts"]);
  git(
    repo,
    [
      "commit", "-q", "-m",
      `substrate-authored: apply unknown-proposal via mitosis cutover\n\nUpstream-Commit: ${UPSTREAM_AF61DEE}`,
    ],
    {
      GIT_AUTHOR_NAME: "Substrate Autonomous",
      GIT_AUTHOR_EMAIL: "substrate-autonomous@metabob.com",
      GIT_AUTHOR_DATE: "2026-06-28T20:05:57Z",
      GIT_COMMITTER_DATE: "2026-06-28T20:05:57Z",
    },
  );
  return { repo, removalSha: git(repo, ["rev-parse", "HEAD"]) };
}

// ---------------------------------------------------------------------------------------------
// Stateful gap store + endpoint wiring (fetch spy)
// ---------------------------------------------------------------------------------------------

type Gap = { id: string; status?: string; category?: string; summary?: string; classification_metadata?: Record<string, any> } & Record<string, any>;

class GapStore {
  gaps = new Map<string, Gap>();
  writes: Gap[] = [];
  records: any[] = []; // record writes this run (cleared by resetWrites)
  recordHistory: any[] = []; // every record, seeded or written, newest last — what a read returns
  seedRecord(r: any): void {
    this.recordHistory.push(r);
  }
  seed(g: Gap): void {
    this.gaps.set(g.id, { category: "orphaned_capability", ...g });
  }
  write(g: Gap): void {
    this.writes.push(g);
    const prev = this.gaps.get(g.id) ?? ({ id: g.id } as Gap);
    this.gaps.set(g.id, {
      ...prev,
      ...g,
      classification_metadata: { ...(prev.classification_metadata ?? {}), ...(g.classification_metadata ?? {}) },
    });
  }
  read(q: { status?: string; category?: string }): Gap[] {
    return [...this.gaps.values()].filter(
      (g) => (!q.status || g.status === q.status) && (!q.category || g.category === q.category),
    );
  }
  writesFor(id: string, status?: string): Gap[] {
    return this.writes.filter((w) => w.id === id && (!status || w.status === status));
  }
  resetWrites(): void {
    this.writes = [];
    this.records = [];
  }
}

const DISCOVERY = "http://discovery.fixture.invalid";
const API = "http://activity-api.fixture.invalid";
const DEV = "http://dev-vessel.fixture.invalid/v2/impulses/resolve";

let fetchSpy: ReturnType<typeof spyOn> | null = null;

function wire(opts: { liveShapes: string[]; store: GapStore; templates?: unknown[] }): void {
  const templates = opts.templates ?? TEMPLATES;
  fetchSpy?.mockRestore();
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.startsWith(DISCOVERY) && url.includes("/registry/shapes")) {
      return new Response(JSON.stringify({ shapes: opts.liveShapes }), { status: 200 });
    }
    if (url.startsWith(API) && url.includes("/v2/activities/templates")) {
      const off = Number(new URL(url).searchParams.get("offset") ?? "0");
      return new Response(JSON.stringify({ templates: off === 0 ? templates : [], total: templates.length }), { status: 200 });
    }
    if (url === DEV) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const pointer = body?.impulse?.pointer ?? body?.pointer ?? {};
      if (pointer.type === "substrateGap_write" && pointer.gap?.id) {
        opts.store.write(pointer.gap as Gap);
        return new Response(JSON.stringify({ shape: "substrateGap", body: { ok: true } }), { status: 200 });
      }
      if (pointer.type === "orphanedCapabilityScanRecord_write") {
        opts.store.records.push(pointer.record ?? pointer);
        opts.store.recordHistory.push(pointer.record ?? pointer);
        return new Response(JSON.stringify({ shape: "orphanedCapabilityScanRecord", body: { ok: true } }), { status: 200 });
      }
      if (pointer.type === "orphanedCapabilityScanRecord") {
        return new Response(JSON.stringify({ shape: "orphanedCapabilityScanRecord", body: { records: opts.store.recordHistory } }), { status: 200 });
      }
      if (pointer.type === "substrateGap") {
        return new Response(JSON.stringify({ shape: "substrateGap", body: { gaps: opts.store.read(pointer) } }), { status: 200 });
      }
    }
    return new Response("unrouted fixture request", { status: 404 });
  }) as unknown as typeof fetch);
}

async function scan(extra: Record<string, unknown> = {}): Promise<any> {
  const r = await resolveOrphanedCapabilityScan({
    type: "orphaned_capability_scan",
    discoveryEndpoint: DISCOVERY,
    metabobEndpoint: API,
    devVesselImpulsesUrl: DEV,
    apiKey: "",
    ...extra,
  } as Parameters<typeof resolveOrphanedCapabilityScan>[0]);
  expect(r.shape).toBe("orphanedCapabilityReport");
  return r.body;
}

/** Wiring precondition for every case: the scan saw the registry and the corpus. A red that comes
 * from a mis-routed mock would otherwise look exactly like an intended red. */
function expectWired(body: any, liveCount: number): void {
  expect(body.degraded).toBe(false);
  expect(body.live_shape_count).toBe(liveCount);
}

const FLAP_N = 3;
/** A prior scan-result record as the scanner itself would have written it. */
function scanRecord(liveShapes: string[], minutesAgo: number): Record<string, unknown> {
  return {
    detector: "orphaned_capability_scan",
    generated_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    live_shapes: liveShapes,
    orphans: [],
  };
}

function lineOf(content: string, needle: string): number {
  const i = content.split("\n").findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`fixture lacks ${needle}`);
  return i + 1;
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "ocs-callers-"));
  mkdirSync(join(ws, "repos"), { recursive: true });
  priorRoot = process.env["WORKSPACE_ROOT"];
  process.env["WORKSPACE_ROOT"] = ws;
});

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
  if (priorRoot === undefined) delete process.env["WORKSPACE_ROOT"];
  else process.env["WORKSPACE_ROOT"] = priorRoot;
  rmSync(ws, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------

describe("orphaned-capability-scan: callers, history and lifecycle", () => {
  it("fixture provenance: the goal-host index.ts fixtures are the real af61dee^ / af61dee blobs", () => {
    expect(gitBlobSha1(GOAL_HOST_BEFORE)).toBe(BLOB_BEFORE);
    expect(gitBlobSha1(GOAL_HOST_AFTER)).toBe(BLOB_AFTER);
    // and the caller really is in one and not the other
    expect(GOAL_HOST_BEFORE).toContain('pointer: { type: "author_composed_capability"');
    expect(GOAL_HOST_AFTER).not.toContain("author_composed_capability");
  });

  // ---- 1. lost caller -------------------------------------------------------------------------

  it("control: before af61dee, goal-host's call keeps author_composed_capability off the orphan list", async () => {
    for (const [rel, c] of Object.entries(DEV_VESSEL_PRODUCER)) put(ws, rel, c);
    replayAf61dee(ws, "before");
    const store = new GapStore();
    wire({ liveShapes: ["author_composed_capability", "fs_read"], store });
    const body = await scan();
    expectWired(body, 2);
    expect(body.capability_orphans).not.toContain("author_composed_capability");
    expect(store.writesFor("orphaned-capability-author_composed_capability", "open")).toHaveLength(0);
  });

  it("MUST-FAIL lost caller: after af61dee removes goal-host's only call, the gap names the removing commit and prescribes restore-or-retire, not mint", async () => {
    for (const [rel, c] of Object.entries(DEV_VESSEL_PRODUCER)) put(ws, rel, c);
    const { removalSha } = replayAf61dee(ws, "after");
    expect(removalSha).toMatch(/^[0-9a-f]{40}$/);
    const store = new GapStore();
    wire({ liveShapes: ["author_composed_capability", "fs_read"], store });
    const body = await scan();
    expectWired(body, 2);
    expect(body.orphan_candidate_count).toBe(1); // the template corpus does not invoke it

    // The producer's own registration is not a caller, so the shape IS orphaned ...
    expect(body.capability_orphans).toContain("author_composed_capability");
    const [gap] = store.writesFor("orphaned-capability-author_composed_capability", "open");
    expect(gap).toBeDefined();
    const cm = gap!.classification_metadata ?? {};
    // ... and it is a LOST caller, not a never-had-one: history says who called it and which
    // commit took the call away. (The replay's sha stands in for af61dee — see the commit body.)
    expect(cm.orphan_kind).toBe("lost_caller");
    expect(cm.lost_caller?.commit).toBe(removalSha);
    expect(cm.lost_caller?.file).toBe("repos/goal-host-vessel/src/index.ts");
    expect(cm.repair_direction).toBe("restore_or_retire");
    expect(gap!.summary ?? "").toContain(removalSha!.slice(0, 7));
  });

  // ---- 2. own registration ----------------------------------------------------------------------

  it("own registration is not a caller: a shape mentioned only by its producer's discovery entry and case label IS orphaned", async () => {
    put(ws, "repos/widget-vessel/src/config.ts", `export const SHAPES = [\n  "widget_render",\n  "widget_status",\n];\n`);
    put(ws, "repos/widget-vessel/src/routes/impulses.ts",
      `export function route(t: string) {\n  switch (t) {\n    case "widget_render":\n      return 1;\n  }\n  return 0;\n}\n`);
    put(ws, "repos/widget-vessel/src/shapes.ts", `export const SUPPORTED_SHAPES = new Set<string>(["widget_render", "widget_status"]);\n`);
    const store = new GapStore();
    wire({ liveShapes: ["widget_render", "fs_read"], store });
    const body = await scan({ emit_gaps: false });
    expectWired(body, 2);
    expect(body.orphan_candidate_count).toBe(1);
    expect(body.capability_orphans).toContain("widget_render");
  });

  it("control: a genuine pointer:{type} call in ANOTHER vessel's file is a caller, so the shape is not orphaned", async () => {
    put(ws, "repos/widget-vessel/src/config.ts", `export const SHAPES = [\n  "widget_render",\n];\n`);
    put(ws, "repos/widget-vessel/src/routes/impulses.ts",
      `export function route(t: string) {\n  switch (t) {\n    case "widget_render":\n      return 1;\n  }\n  return 0;\n}\n`);
    put(ws, "repos/dashboard-vessel/src/panel.ts",
      `declare function resolve(i: unknown): Promise<unknown>;\nexport async function draw(id: string) {\n  return resolve({ pointer: { type: "widget_render", id } });\n}\n`);
    const store = new GapStore();
    wire({ liveShapes: ["widget_render", "fs_read"], store });
    const body = await scan({ emit_gaps: false });
    expectWired(body, 2);
    expect(body.capability_orphans).not.toContain("widget_render");
  });

  it("control: a CALL in the producer's OWN vessel counts too — calls count in any file, registration in none", async () => {
    // The shape of development-vessel's feature-compose.ts:5087, which calls author_composed_capability
    // from inside the vessel that registers it.
    put(ws, "repos/widget-vessel/src/config.ts", `export const SHAPES = [\n  "widget_render",\n];\n`);
    put(ws, "repos/widget-vessel/src/routes/impulses.ts",
      `export function route(t: string) {\n  switch (t) {\n    case "widget_render":\n      return 1;\n  }\n  return 0;\n}\n`);
    put(ws, "repos/widget-vessel/src/resolvers/compose.ts",
      `declare function resolve(i: unknown): Promise<unknown>;\nexport async function delegate(goal: string) {\n  return resolve({ pointer: { type: "widget_render", goal } });\n}\n`);
    const store = new GapStore();
    wire({ liveShapes: ["widget_render", "fs_read"], store });
    const body = await scan({ emit_gaps: false });
    expectWired(body, 2);
    expect(body.capability_orphans).not.toContain("widget_render");
  });

  // ---- 3. roots ----------------------------------------------------------------------------------

  it("positive-control root: a known caller under scripts/ or packages/ (outside repos/) is found, so the shape is not orphaned", async () => {
    // Nothing under repos/ mentions either shape — the ONLY callers are outside it.
    put(ws, "scripts/substrate/render-gauges.ts",
      `declare function resolve(i: unknown): Promise<unknown>;\nexport const run = () => resolve({ pointer: { type: "gauge_plot", series: [] } });\n`);
    put(ws, "packages/dial-kit/src/index.ts",
      `declare function resolve(i: unknown): Promise<unknown>;\nexport const dial = () => resolve({ pointer: { type: "dial_plot" } });\n`);
    const store = new GapStore();
    wire({ liveShapes: ["gauge_plot", "dial_plot", "fs_read"], store });
    const body = await scan({ emit_gaps: false });
    expectWired(body, 3);
    expect(body.orphan_candidate_count).toBe(2);
    expect(body.capability_orphans).not.toContain("gauge_plot");
    expect(body.capability_orphans).not.toContain("dial_plot");
  });

  it("control: with no caller anywhere, the same shapes ARE orphaned", async () => {
    const store = new GapStore();
    wire({ liveShapes: ["gauge_plot", "dial_plot", "fs_read"], store });
    const body = await scan({ emit_gaps: false });
    expectWired(body, 3);
    expect(body.capability_orphans).toContain("gauge_plot");
    expect(body.capability_orphans).toContain("dial_plot");
  });

  // ---- 4. lifecycle ------------------------------------------------------------------------------

  it("lifecycle (a): a closed or rejected gap whose fingerprint is stale does NOT suppress a shape that is orphaned again", async () => {
    const store = new GapStore();
    store.seed({ id: "orphaned-capability-zeta_probe", status: "closed", classification_metadata: { shape: "zeta_probe", fingerprint: "stale-fingerprint" } });
    store.seed({ id: "orphaned-capability-eta_probe", status: "rejected", classification_metadata: { shape: "eta_probe", fingerprint: "stale-fingerprint" } });
    wire({ liveShapes: ["zeta_probe", "eta_probe", "fs_read"], store });
    const body = await scan();
    expectWired(body, 3);
    expect(body.capability_orphans).toContain("zeta_probe");
    expect(body.capability_orphans).toContain("eta_probe");
    for (const id of ["orphaned-capability-zeta_probe", "orphaned-capability-eta_probe"]) {
      const [w] = store.writesFor(id, "open");
      expect(w).toBeDefined();
      expect(typeof w!.classification_metadata?.fingerprint).toBe("string");
      expect(w!.classification_metadata?.fingerprint).not.toBe("stale-fingerprint");
    }
  });

  it("lifecycle (a) control: a closed gap whose fingerprint is CURRENT still suppresses re-emission (the bridge-churn guard holds)", async () => {
    const store = new GapStore();
    wire({ liveShapes: ["zeta_probe", "fs_read"], store });
    await scan();
    const id = "orphaned-capability-zeta_probe";
    expect(store.writesFor(id, "open")).toHaveLength(1);
    store.gaps.set(id, { ...store.gaps.get(id)!, status: "closed" }); // closed as of the current fingerprint
    store.resetWrites();
    const body = await scan();
    expectWired(body, 2);
    expect(store.writesFor(id, "open")).toHaveLength(0);
  });

  it("lifecycle (b): retiring an unreachable orphan gap is a TYPED reject — actor, at, reason — and non-terminal", async () => {
    const store = new GapStore();
    store.seed({ id: "orphaned-capability-gone_shape", status: "open", classification_metadata: { shape: "gone_shape" } });
    wire({ liveShapes: ["fs_read", "problem_detection"], store });
    const before = Date.now();
    const body = await scan();
    expectWired(body, 2);
    expect(body.rejected_unreachable).toContain("orphaned-capability-gone_shape");
    const [w] = store.writesFor("orphaned-capability-gone_shape", "rejected");
    expect(w).toBeDefined();
    const cm = w!.classification_metadata ?? {};
    expect(cm.rejected_by).toBe("orphaned_capability_scan");
    expect(typeof cm.rejected_at).toBe("string");
    const at = Date.parse(cm.rejected_at);
    expect(Number.isFinite(at)).toBe(true);
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(cm.rejected_reason).toBe("no_live_producer");
    expect(cm.terminal).toBe(false);
  });

  it("lifecycle (b) control: a rejected gap reopens when its producer is live and the shape is still orphaned", async () => {
    const store = new GapStore();
    // Rejected the way the scan rejects today: unreachable, no live producer. That condition has
    // now cleared — the producer has been live for N consecutive scan records — so this row is
    // NOT grandfathered (see the grandfather and flap-guard tests below).
    store.seed({ id: "orphaned-capability-gone_shape", status: "rejected", classification_metadata: { shape: "gone_shape", unreachable_reason: "no_live_producer" } });
    for (let i = 0; i < FLAP_N; i++) store.seedRecord(scanRecord(["gone_shape", "fs_read"], FLAP_N - i));
    wire({ liveShapes: ["gone_shape", "fs_read"], store });
    const body = await scan({ reopen_after_live_records: FLAP_N });
    expectWired(body, 2);
    expect(store.writesFor("orphaned-capability-gone_shape", "open")).toHaveLength(1);
  });

  it("flap guard: a no_live_producer-rejected gap does NOT reopen when its producer is live in only 1 scan record", async () => {
    const store = new GapStore();
    store.seed({ id: "orphaned-capability-gone_shape", status: "rejected", classification_metadata: { shape: "gone_shape", unreachable_reason: "no_live_producer" } });
    // The producer was dark in every prior record and is live only in this tick.
    for (let i = 0; i < FLAP_N; i++) store.seedRecord(scanRecord(["fs_read"], FLAP_N - i));
    wire({ liveShapes: ["gone_shape", "fs_read"], store });
    const body = await scan({ reopen_after_live_records: FLAP_N });
    expectWired(body, 2);
    expect(body.capability_orphans).toContain("gone_shape"); // still reported ...
    expect(store.writesFor("orphaned-capability-gone_shape", "open")).toHaveLength(0); // ... not reopened
    expect(store.gaps.get("orphaned-capability-gone_shape")!.status).toBe("rejected");
  });

  it("flap guard: it reopens once the producer has been live for N consecutive records", async () => {
    const store = new GapStore();
    store.seed({ id: "orphaned-capability-gone_shape", status: "rejected", classification_metadata: { shape: "gone_shape", unreachable_reason: "no_live_producer" } });
    // dark, then live for N consecutive records (newest last)
    store.seedRecord(scanRecord(["fs_read"], FLAP_N + 1));
    for (let i = 0; i < FLAP_N; i++) store.seedRecord(scanRecord(["gone_shape", "fs_read"], FLAP_N - i));
    wire({ liveShapes: ["gone_shape", "fs_read"], store });
    const body = await scan({ reopen_after_live_records: FLAP_N });
    expectWired(body, 2);
    const [w] = store.writesFor("orphaned-capability-gone_shape", "open");
    expect(w).toBeDefined();
  });

  it("lifecycle (c): a caller appearing closes the open gap with consumer_appeared: <file:line>", async () => {
    const caller =
      `declare function resolve(i: unknown): Promise<unknown>;\n\nexport async function pull() {\n  return resolve({ pointer: { type: "kappa_feed", since: 0 } });\n}\n`;
    put(ws, "repos/reader-vessel/src/pull.ts", caller);
    const callLine = lineOf(caller, 'type: "kappa_feed"');
    const store = new GapStore();
    store.seed({ id: "orphaned-capability-kappa_feed", status: "open", classification_metadata: { shape: "kappa_feed" } });
    wire({ liveShapes: ["kappa_feed", "fs_read"], store });
    const body = await scan();
    expectWired(body, 2);
    expect(body.capability_orphans).not.toContain("kappa_feed");
    const [w] = store.writesFor("orphaned-capability-kappa_feed", "closed");
    expect(w).toBeDefined();
    const cm = w!.classification_metadata ?? {};
    expect(cm.closed_reason).toBe("consumer_appeared");
    expect(cm.closed_by).toBe("orphaned_capability_scan");
    expect(cm.consumer_appeared).toBe(`repos/reader-vessel/src/pull.ts:${callLine}`);
  });

  it("lifecycle (d): hyphen and underscore variants of one shape normalise to ONE gap id", async () => {
    const store = new GapStore();
    wire({ liveShapes: ["foo-bar", "foo_bar", "fs_read"], store });
    const body = await scan();
    expectWired(body, 3);
    const ids = new Set(store.writes.filter((w) => w.status === "open").map((w) => w.id));
    expect([...ids]).toEqual(["orphaned-capability-foo_bar"]);
  });

  // ---- 5. flood guard ----------------------------------------------------------------------------

  it("flood guard: classify-only mode emits nothing (no open, close or reject writes)", async () => {
    put(ws, "repos/reader-vessel/src/pull.ts",
      `declare function resolve(i: unknown): Promise<unknown>;\nexport const p = () => resolve({ pointer: { type: "kappa_feed" } });\n`);
    const store = new GapStore();
    store.seed({ id: "orphaned-capability-kappa_feed", status: "open", classification_metadata: { shape: "kappa_feed" } });
    store.seed({ id: "orphaned-capability-gone_shape", status: "open", classification_metadata: { shape: "gone_shape" } });
    wire({ liveShapes: ["kappa_feed", "problem_detection", "fs_read"], store });
    const body = await scan({ emit_gaps: false });
    expectWired(body, 3);
    expect(body.capability_orphans).toContain("problem_detection");
    expect(body.gaps_emitted).toBe(0);
    expect(store.writes).toHaveLength(0);
    expect(store.records).toHaveLength(0);
  });

  it("flood guard: emit mode is capped per tick and never writes one id twice", async () => {
    const store = new GapStore();
    wire({ liveShapes: ["alpha_cap", "beta_cap", "gamma_cap", "delta_cap", "epsilon_cap", "fs_read"], store });
    const body = await scan({ max_emit: 2 });
    expectWired(body, 6);
    expect(body.capability_orphan_count).toBe(5);
    expect(body.gaps_emitted).toBe(2);
    const open = store.writes.filter((w) => w.status === "open");
    expect(open).toHaveLength(2);
    expect(new Set(open.map((w) => w.id)).size).toBe(2);
  });

  it("MUST-FAIL flood guard: re-running the scan on an unchanged fixture emits 0 new gap writes", async () => {
    const store = new GapStore();
    wire({ liveShapes: ["alpha_cap", "beta_cap", "fs_read"], store });
    const first = await scan();
    expectWired(first, 3);
    expect(first.gaps_emitted).toBe(2);
    expect(store.read({ status: "open" })).toHaveLength(2);

    store.resetWrites();
    const second = await scan(); // nothing changed: same registry, corpus, tree and store
    expectWired(second, 3);
    expect(second.capability_orphan_count).toBe(2); // still orphaned — still reported
    expect(second.gaps_emitted).toBe(0);
    expect(store.writes.filter((w) => w.status === "open")).toHaveLength(0);
  });

  it("grandfathered rows don't reopen, AND a never-gapped lost caller still emits", async () => {
    // Closed/rejected orphan rows written before fingerprints existed carry none. Treating
    // "no fingerprint" as "stale" would reopen the whole legacy corpus in one deploy.
    const legacy = ["legacy_a", "legacy_b", "legacy_c", "legacy_d", "legacy_e"];
    const store = new GapStore();
    legacy.forEach((sh, i) =>
      store.seed({
        id: `orphaned-capability-${sh}`,
        status: i % 2 === 0 ? "closed" : "rejected",
        classification_metadata: { shape: sh, ...(i % 2 === 0 ? { closed_reason: "bridge_minted" } : { rejected_reason: "not_worth_closing" }) },
      }),
    );
    // ... while the af61dee lost caller has never had a gap at all.
    for (const [rel, c] of Object.entries(DEV_VESSEL_PRODUCER)) put(ws, rel, c);
    const { removalSha } = replayAf61dee(ws, "after");
    wire({ liveShapes: [...legacy, "author_composed_capability", "fs_read"], store });
    const MAX_BACKFILL = 2;
    const body = await scan({ max_backfill: MAX_BACKFILL });
    expectWired(body, legacy.length + 2);

    // (i) no reopen wave: every legacy row keeps its status
    for (const sh of legacy) {
      const id = `orphaned-capability-${sh}`;
      expect(store.writesFor(id, "open")).toHaveLength(0);
      expect(store.gaps.get(id)!.status).not.toBe("open");
    }
    // (ii) any lazy fingerprint backfill is capped per tick and never flips status
    const legacyWrites = store.writes.filter((w) => legacy.some((sh) => w.id === `orphaned-capability-${sh}`));
    expect(legacyWrites.length).toBeLessThanOrEqual(MAX_BACKFILL);
    for (const w of legacyWrites) {
      expect(["closed", "rejected", undefined]).toContain(w.status);
      expect(typeof w.classification_metadata?.fingerprint).toBe("string");
    }
    // (iii) the never-gapped lost caller is still emitted, as a lost caller
    const [g] = store.writesFor("orphaned-capability-author_composed_capability", "open");
    expect(g).toBeDefined();
    expect(g!.classification_metadata?.orphan_kind).toBe("lost_caller");
    expect(g!.classification_metadata?.lost_caller?.commit).toBe(removalSha);
  });

  it("MUST-FAIL scan-result record: each emitting tick writes exactly ONE record carrying the full orphan set and fingerprints (not one write per gap)", async () => {
    const store = new GapStore();
    wire({ liveShapes: ["alpha_cap", "beta_cap", "gamma_cap", "fs_read"], store });
    const first = await scan();
    expectWired(first, 4);
    expect(first.capability_orphan_count).toBe(3);
    expect(store.records).toHaveLength(1);
    const rec1 = store.records[0];
    expect(rec1.detector).toBe("orphaned_capability_scan");
    expect(Number.isFinite(Date.parse(rec1.generated_at))).toBe(true);
    expect(rec1.live_shapes).toEqual(expect.arrayContaining(["alpha_cap", "beta_cap", "gamma_cap", "fs_read"]));
    expect((rec1.orphans as any[]).map((o) => o.gap_id).sort()).toEqual([
      "orphaned-capability-alpha_cap", "orphaned-capability-beta_cap", "orphaned-capability-gamma_cap",
    ]);
    for (const o of rec1.orphans as any[]) expect(typeof o.fingerprint).toBe("string");

    // Second, unchanged tick: no gap re-writes (dedup), but the record still says "still detected".
    store.resetWrites();
    const second = await scan();
    expectWired(second, 4);
    expect(store.writes.filter((w) => w.status === "open")).toHaveLength(0);
    expect(store.records).toHaveLength(1);
    expect((store.records[0].orphans as any[]).length).toBe(3);
  });
});
