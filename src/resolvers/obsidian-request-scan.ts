import type { ResolverResult } from "./types.js";
import { readdir } from "node:fs/promises";

/**
 * obsidian_request_scan (2026-06-15) — the EXPLICIT human→substrate channel.
 *
 * The implicit channel (obsidian_behavior_scan over event_observed) lets the
 * substrate learn what the operator DOES. This is the EXPLICIT channel: the
 * operator writes what they WANT, in their own vault, and the substrate picks it
 * up and participates.
 *
 * Contract (deliberately Obsidian-idiomatic + generic):
 *  - The operator writes requests as unchecked tasks in a watched note
 *    (default `Substrate/Inbox.md`): `- [ ] summarize my open notes`.
 *  - Each scan tick reads that note (obsidian:note — a plain read, so it works
 *    regardless of the observer's substrate-write skip), dispatches every
 *    UNPROCESSED request as a goal to goal-host (the same run-goal path the
 *    sidebar uses → the operator_goal_unservable→author→serve loop handles it),
 *    and ACKNOWLEDGES by:
 *      (a) writing/refreshing a status board `Substrate/Now.md` —
 *          "🔄 Working on: <request> (dispatched <id>)" — so the operator is told
 *          we are working on it, in their own tool, asynchronously; and
 *      (b) marking the request line `- [x] … ⟶ dispatched <id>` back in the inbox
 *          so it is not re-dispatched and the operator sees it was received.
 *
 * Everything here is impulses + resolvers: the request line is an input impulse
 * (read via obsidian:note), the dispatch is an activity (goal_execution), the
 * status + processed-marking are output impulses (obsidian:write_note, hard-
 * restricted to Substrate/). Reads + Substrate/-only writes. Non-intrusive.
 */

import { METABOB_ENDPOINT, METABOB_API_KEY, DISCOVERY_ENDPOINT } from "../config.js";
const DEFAULT_OBSIDIAN_ENDPOINT =
  process.env["OBSIDIAN_ENDPOINT"] ??
  process.env["OBSIDIAN_LEARN_ENDPOINT"] ??
  process.env["OBSIDIAN_PLUGIN_ENDPOINT"] ??
  "http://host.docker.internal:27183";

// Module-level discovery cache
let cachedObsidianEndpoint: string | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 60_000;

type DiscoveryResolveResponse = {
  content?: { vessels?: Array<{ endpoint: string; resolve_endpoint?: string }> };
};

export async function resolveObsidianEndpointViaDiscovery(): Promise<string | null> {
  // Returns the BASE endpoint (no trailing slash, no /resolve suffix).
  // Callers append "/resolve" themselves. Never return resolve_endpoint which
  // is a relative path "/resolve" — using it as a base causes double-resolve URLs.
  // Return cached value if still valid
  if (cachedObsidianEndpoint !== null && Date.now() < cacheExpiresAt) {
    return cachedObsidianEndpoint;
  }
  const now = Date.now();
  if (cachedObsidianEndpoint !== null && now < cacheExpiresAt) {
    return cachedObsidianEndpoint;
  }

  try {
    const res = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `ApiKey ${METABOB_API_KEY}`,
      },
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape: "obsidian:note" } }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      console.warn(`[obsidian-request-scan] discovery resolve HTTP ${res.status}, returning null`);
      return null;
    }

    const json = (await res.json()) as DiscoveryResolveResponse;
    const vessels = json.content?.vessels;
    if (!vessels || vessels.length === 0) {
      console.warn(`[obsidian-request-scan] discovery returned no vessels, returning null`);
      return null;
    }
    let firstBase: string | null = null;
    for (const candidate of vessels) {
      const base = String(candidate.endpoint ?? "").replace(/\/+$/, "");
      if (!base) continue;
      if (firstBase === null) firstBase = base;
      try {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          cachedObsidianEndpoint = base;
          cacheExpiresAt = now + CACHE_TTL_MS;
          return base;
        }
      } catch {
        // probe failed, try next candidate
      }
    }
    if (firstBase !== null) {
      cachedObsidianEndpoint = firstBase;
      cacheExpiresAt = now + CACHE_TTL_MS;
      return firstBase;
    }
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[obsidian-request-scan] discovery unreachable (${msg}), returning null`);
    return null;
  }
}

async function resolveObsidianEndpoint(): Promise<string> {
  const discovered = await resolveObsidianEndpointViaDiscovery();
  return discovered ?? DEFAULT_OBSIDIAN_ENDPOINT;
}
const DEFAULT_GOAL_HOST = process.env["GOAL_HOST_ENDPOINT"] ?? "http://127.0.0.1:8210";
const API_KEY = process.env["METABOB_API_KEY"] ?? process.env["DEV_VESSEL_API_KEY"];
// The vault is mounted in the container; used to ENUMERATE the operator's Inbox/
// DIRECTORY (they explicitly asked us to "check Inbox/ and its subdirectories", not
// just the single Substrate/Inbox.md file). Reads/writes still go through the obsidian
// plugin by vault-relative path; fs is used only to list which notes exist.
const VAULT_ROOT = process.env["VAULT_ROOT"] ?? "/vaults/substrate-vault";

/**
 * Attempt to enumerate Substrate/Inbox/ notes via the obsidian plugin HTTP
 * resolve surface. Returns vault-relative paths (e.g. "Substrate/Inbox/Foo.md")
 * or null if the plugin is unreachable / returns no useful results.
 */
async function listInboxViaPlugin(
  obsidianEndpoint: string,
): Promise<string[] | null> {
  try {
    const auth: Record<string, string> = { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) };
    const res = await fetch(`${obsidianEndpoint}/resolve`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ type: "obsidian:search", pointer: { type: "obsidian:search", query: "-", folder: "Substrate/Inbox", limit: 50 } }),
      signal: AbortSignal.timeout(6000),
    });
    const json = (await res.json()) as { success?: boolean; content?: string };
    if (json.success && typeof json.content === "string") {
      const rows = JSON.parse(json.content) as Array<{ path?: string }>;
      const md = rows.map((r) => r.path ?? "").filter((p) => p.endsWith(".md") && p.startsWith("Substrate/Inbox/"));
      if (md.length > 0) return md;
    }
  } catch { /* plugin unreachable */ }
  return null;
}

async function listInboxFiles(inboxPath: string, obsidianEndpoint?: string): Promise<string[]> {
  // 1. Try plugin HTTP enumeration (works for host/remote vaults)
  if (obsidianEndpoint) {
    const pluginPaths = await listInboxViaPlugin(obsidianEndpoint);
    if (pluginPaths !== null && pluginPaths.length > 0) {
      return [inboxPath, ...pluginPaths.filter((p) => p !== inboxPath)];
    }
  }
  // 2. Fall back to local fs readdir under VAULT_ROOT
  try {
    const entries = await readdir(`${VAULT_ROOT}/Substrate/Inbox`);
    const mdFiles = entries.filter((e) => e.endsWith(".md"));
    if (mdFiles.length > 0) {
      return mdFiles.map((e) => `Substrate/Inbox/${e}`);
    }
  } catch {
    // fall through
  }
  // 3. Final fallback: single main inbox file
  return [inboxPath];
}

export interface ObsidianRequestScanPointer {
  type: "obsidian_request_scan";
  obsidianEndpoint?: string;
  goalHostEndpoint?: string;
  /** Watched request note; MUST be under Substrate/ (write_note can mark it processed). */
  inboxPath?: string;
  /** Status board the operator reads. */
  statusPath?: string;
  apiKey?: string;
  maxDispatch?: number;
  timeoutMs?: number;
}

interface ParsedRequest {
  raw: string;
  text: string;
  lineIndex: number;
  file: string;
}

export async function resolveObsidianRequestScan(
  pointer: ObsidianRequestScanPointer,
): Promise<ResolverResult> {
  const obsidian = (pointer.obsidianEndpoint ?? await resolveObsidianEndpoint()).replace(/\/+$/, "");
  const goalHost = (pointer.goalHostEndpoint ?? DEFAULT_GOAL_HOST).replace(/\/+$/, "");
  const inboxPath = pointer.inboxPath ?? "Substrate/Inbox.md";
  const statusPath = pointer.statusPath ?? "Substrate/Now.md";
  const apiKey = pointer.apiKey ?? API_KEY;
  const maxDispatch = pointer.maxDispatch ?? 5;
  const timeoutMs = pointer.timeoutMs ?? 12_000;
  const generatedAt = new Date().toISOString();
  const auth: Record<string, string> = { "Content-Type": "application/json", ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}) };

  if (!apiKey) return { shape: "obsidianRequestScan", body: { error: "missing_api_key" } };

  // 1. Read the operator's inbox — the main note AND every .md under the Substrate/Inbox/
  // directory they asked us to watch. Each note's content is kept per-file so we can mark
  // processed tasks in the RIGHT file. A plain read; observer-skip does not apply.
  const inboxFiles = await listInboxFiles(inboxPath, obsidian);
  const fileLines = new Map<string, string[]>();
  let readAny = false;
  for (const path of inboxFiles) {
    try {
      const res = await fetch(`${obsidian}/resolve`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ type: "obsidian:note", pointer: { type: "obsidian:note", path, includeFrontmatter: true } }),
        signal: AbortSignal.timeout(Math.min(timeoutMs, 8000)),
      });
      const json = (await res.json()) as { success?: boolean; content?: string };
      if (json.success && typeof json.content === "string") {
        fileLines.set(path, json.content.split("\n"));
        if (json.content) readAny = true;
      }
    } catch (err) {
      // The MAIN inbox being unreachable is fatal (channel down); a directory note
      // failing to read is skipped (best-effort).
      if (path === inboxPath && inboxFiles.length === 1) {
        return { shape: "obsidianRequestScan", body: { unreachable: true, stage: "read_inbox", detail: err instanceof Error ? err.message.slice(0, 120) : "err", inbox_path: inboxPath, generated_at: generatedAt } };
      }
    }
  }
  if (!readAny) {
    // No inbox content anywhere — seed the main file so the operator knows the channel exists.
    const seed = `# Substrate Inbox\n\n_Write a request as an unchecked task and I'll pick it up, tell you in [[Now]] that I'm working on it, and deliver the result under Substrate/._\n\n- [ ] (example) summarize my open notes into a briefing\n`;
    await writeNote(obsidian, auth, inboxPath, seed, timeoutMs).catch(() => {});
    return { shape: "obsidianRequestScan", body: { seeded_inbox: true, inbox_path: inboxPath, requests_found: 0, generated_at: generatedAt } };
  }

  // OUTBOX (persistent status board): the operator asked for "a persistent outbox with
  // the current status of everything you are working on and how you solved each item."
  // Now.md is the in-flight board; Outbox.md is the durable record of RESOLVED work
  // (recently closed gaps + freshly minted capabilities). Write it EVERY scan, regardless
  // of whether there are new requests, so it always reflects current status. Best-effort.
  const outboxWrote = await writeOutbox(obsidian, auth, timeoutMs).catch(() => false);

  // 2. Parse UNPROCESSED requests across ALL inbox files: unchecked tasks `- [ ] <text>`.
  const requests: ParsedRequest[] = [];
  for (const [path, lines] of fileLines) {
    lines.forEach((raw, i) => {
      if (raw.includes('⟶')) return;
      const m = raw.match(/^\s*[-*]\s+\[\s\]\s+(.+?)\s*$/);
      if (m) {
        const cap = m[1] ?? "";
        const text = cap.replace(/^\(example\)\s*/i, "").trim();
        if (text && !/^\(example\)/i.test(cap)) requests.push({ raw, text, lineIndex: i, file: path });
      }
    });
  }

  if (requests.length === 0) {
    return { shape: "obsidianRequestScan", body: { requests_found: 0, dispatched: 0, outbox_written: outboxWrote, inbox_path: inboxPath, inbox_files: inboxFiles, generated_at: generatedAt } };
  }

  // 3. Dispatch each request (the run-goal path → author→serve loop) + collect acks.
  const dispatched: Array<{ text: string; dispatchId?: string; status: string; lineIndex: number; file: string }> = [];
  for (const req of requests.slice(0, maxDispatch)) {
    let dispatchId: string | undefined;
    let status = "dispatch_failed";
    try {
      const res = await fetch(`${goalHost}/run-goal`, {
        method: "POST", headers: auth,
        body: JSON.stringify({
          goal: req.text,
          tags: ["dispatcher:obsidian-vessel", "source:inbox"],
          expected_output_shapes: ["obsidian:note"],
          variables: {},
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json = (await res.json()) as { dispatchId?: string; executionId?: string; status?: string };
      dispatchId = json.dispatchId ?? json.executionId;
      status = json.status ?? "dispatched";
    } catch (err) {
      status = err instanceof Error ? err.message.slice(0, 80) : "err";
    }
    dispatched.push({ text: req.text, dispatchId, status, lineIndex: req.lineIndex, file: req.file });
  }

  // 4a. ACK: write the status board the operator reads ("we are working on it").
  const statusLines: string[] = [
    `scan_ts: ${new Date().toISOString()}`,
  ];
  for (const req of dispatched) {
    const what = (req as Record<string, unknown>)["goal"] ?? (req as Record<string, unknown>)["interpreted_as"] ?? (req as Record<string, unknown>)["type"] ?? "unknown";
    const shapes: unknown = (req as Record<string, unknown>)["expected_output_shapes"];
    const rationale: unknown = (req as Record<string, unknown>)["rationale"];
    const shapesStr = Array.isArray(shapes) ? shapes.join(", ") : (typeof shapes === "string" ? shapes : "");
    const rationaleStr = typeof rationale === "string" ? rationale : "";
    statusLines.push(`  request: goal=${String(what)}${shapesStr ? ` expected_output_shapes=[${shapesStr}]` : ""}${rationaleStr ? ` rationale=${rationaleStr}` : ""}`);
  }
  const _statusLinesContinued = [
    "---", "substrate_board: now", `generated_at: ${generatedAt}`, "---", "",
    "# What I'm working on right now", "",
    "_You asked, I'm on it. Results land under `Substrate/` and I mark your [[Inbox]] item done._", "",
  ];
  const seenText = new Set<string>();
  for (const d of dispatched) {
    if (seenText.has(d.text)) continue;
    seenText.add(d.text);
    const icon = d.dispatchId ? "🔄" : "⚠️";
    statusLines.push(`- ${icon} **${d.text}** — ${d.dispatchId ? `working (dispatch \`${d.dispatchId}\`)` : `could not start: ${d.status}`}`);
  }
  statusLines.push("");
  const statusWrote = await writeNote(obsidian, auth, statusPath, statusLines.join("\n"), timeoutMs).catch(() => false);

  // 4b. Mark processed in the RIGHT file so requests are not re-dispatched. Group the
  // dispatched items by their source file and write each back to its own note.
  let filesMarked = 0;
  const byFile = new Map<string, typeof dispatched>();
  for (const d of dispatched) {
    if (!d.dispatchId) continue;
    (byFile.get(d.file) ?? byFile.set(d.file, []).get(d.file)!).push(d);
  }
  for (const [path, items] of byFile) {
    const lines = fileLines.get(path);
    if (!lines) continue;
    const byLine = new Map(items.map((d) => [d.lineIndex, d]));
    const updated = lines.map((raw, i) => {
      const d = byLine.get(i);
      if (d && d.dispatchId) return raw.replace(/\[\s\]/, "[x]") + ` ⟶ dispatched \`${d.dispatchId}\` (see [[Now]])`;
      return raw;
    }).join("\n");
    const ok = await writeNote(obsidian, auth, path, updated, timeoutMs).catch(() => false);
    if (ok) filesMarked++;
  }

  return {
    shape: "obsidianRequestScan",
    body: {
      requests_found: requests.length,
      dispatched: dispatched.filter((d) => d.dispatchId).length,
      requests: dispatched.map((d) => ({ text: d.text, dispatchId: d.dispatchId, status: d.status, file: d.file })),
      status_board_written: statusWrote,
      outbox_written: outboxWrote,
      files_marked: filesMarked,
      inbox_path: inboxPath,
      inbox_files: inboxFiles,
      status_path: statusPath,
      generated_at: generatedAt,
    },
  };
}

async function writeNote(
  obsidian: string,
  auth: Record<string, string>,
  path: string,
  content: string,
  timeoutMs: number,
): Promise<boolean> {
  const res = await fetch(`${obsidian}/resolve`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ type: "obsidian:write_note", pointer: { type: "obsidian:write_note", path, content } }),
    signal: AbortSignal.timeout(Math.min(timeoutMs, 8000)),
  });
  const json = (await res.json()) as { content?: string; success?: boolean };
  try { return JSON.parse(json.content ?? "{}").wrote === true; } catch { return json.success === true; }
}

// Write the persistent OUTBOX — a durable, human-readable record of what the substrate
// has RESOLVED and how, so the operator can see status without reading git/CLI. Sources
// (best-effort, own localhost surfaces): recently CLOSED gaps (dev-vessel gap store =
// "what I fixed" + resolution) and freshly MINTED capabilities (activity-api = "what I
// expressed"). Failures are swallowed; the outbox is non-critical.
async function writeOutbox(
  obsidian: string,
  auth: Record<string, string>,
  timeoutMs: number,
): Promise<boolean> {
  const DEV = process.env["DEV_VESSEL_SELF_ENDPOINT"] ?? "http://127.0.0.1:8090";
  const ACT = process.env["ACTIVITY_API_ENDPOINT"] ?? "http://127.0.0.1:8080";
  const t = Math.min(timeoutMs, 10_000);
  const now = new Date().toISOString();

  // Recently closed gaps = resolved work.
  let closed: Array<{ id?: string; category?: string; summary?: string }> = [];
  try {
    const r = await fetch(`${DEV}/v2/impulses/resolve`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ impulse: { pointer: { type: "substrateGap", status: "closed", limit: 20 } } }),
      signal: AbortSignal.timeout(t),
    });
    const j = (await r.json()) as { body?: { gaps?: Array<Record<string, unknown>> } };
    // Filter housekeeping/cleanup closures (selftests, false-positive gap closes) — the
    // operator wants GENUINE resolved work, not internal bookkeeping noise.
    const NOISE = /selftest|false[- ]positive|^probe-|test-only|no[- ]op/i;
    closed = (j.body?.gaps ?? [])
      .filter((g) => !NOISE.test(String(g.summary ?? "")) && !NOISE.test(String(g.id ?? "")))
      .slice(0, 12)
      .map((g) => ({ id: String(g.id ?? ""), category: String(g.category ?? ""), summary: String(g.summary ?? "").slice(0, 140) }));
  } catch { /* best-effort */ }

  // Capabilities expressed = orphaned resolvers now invoked by a minted bridge. A closed
  // orphaned_capability gap reliably means author_producer minted a runnable bridge for
  // that shape, so derive it from the closed set (the templates endpoint caps at 100 rows
  // and doesn't reliably surface the auto-bridges). ACT kept for future use.
  void ACT;
  const minted: string[] = (closed || [])
    .filter((g) => (g.category ?? "") === "orphaned_capability")
    .map((g) => String(g.id ?? "").replace(/^orphaned-capability-/, ""))
    .filter(Boolean)
    .slice(0, 10);

  const lines = [
    "---", "substrate_board: outbox", `generated_at: ${now}`, "---", "",
    "# Outbox — what I've resolved", "",
    "_Durable record of completed work. In-flight items are in [[Now]]; open requests you write go in [[Inbox]] or `Substrate/Inbox/`._", "",
    "## Recently resolved", "",
  ];
  if (closed.length === 0) lines.push("_(nothing closed yet in the recent window)_", "");
  for (const g of closed) lines.push(`- **${g.summary || g.id}** — resolved (${g.category})`);
  lines.push("", "## Capabilities I expressed", "");
  if (minted.length === 0) lines.push("_(none in the recent window)_", "");
  for (const m of minted) lines.push(`- \`${m}\``);
  lines.push("");

  return writeNote(obsidian, auth, "Substrate/Outbox.md", lines.join("\n"), timeoutMs).catch(() => false);
}
