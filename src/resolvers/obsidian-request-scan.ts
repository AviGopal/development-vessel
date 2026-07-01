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

const DEFAULT_OBSIDIAN_ENDPOINT =
  process.env["OBSIDIAN_LEARN_ENDPOINT"] ?? process.env["OBSIDIAN_PLUGIN_ENDPOINT"] ?? "http://host.docker.internal:27183";
const DEFAULT_GOAL_HOST = process.env["GOAL_HOST_ENDPOINT"] ?? "http://127.0.0.1:8210";
const API_KEY = process.env["METABOB_API_KEY"] ?? process.env["DEV_VESSEL_API_KEY"];
// The vault is mounted in the container; used to ENUMERATE the operator's Inbox/
// DIRECTORY (they explicitly asked us to "check Inbox/ and its subdirectories", not
// just the single Substrate/Inbox.md file). Reads/writes still go through the obsidian
// plugin by vault-relative path; fs is used only to list which notes exist.
const VAULT_ROOT = process.env["OBSIDIAN_VAULT_ROOT"] ?? "/vaults/substrate-vault";

// Enumerate inbox source notes: the main inbox file + every .md under the operator's
// Substrate/Inbox/ directory (recursively). Returns vault-relative paths. Falls back
// to just the main file if the directory is absent or fs is unreadable.
async function listInboxFiles(inboxPath: string): Promise<string[]> {
  const files = [inboxPath];
  const dirRel = inboxPath.replace(/\.md$/i, ""); // Substrate/Inbox.md -> Substrate/Inbox
  try {
    const entries = await readdir(`${VAULT_ROOT}/${dirRel}`, { recursive: true, withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
      const parent = ((e as { parentPath?: string; path?: string }).parentPath ?? (e as { path?: string }).path ?? `${VAULT_ROOT}/${dirRel}`);
      const rel = `${parent}/${e.name}`.replace(`${VAULT_ROOT}/`, "").replace(/\/+/g, "/");
      if (!files.includes(rel)) files.push(rel);
    }
  } catch { /* directory absent / not fs-accessible → main file only */ }
  return files;
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
  const obsidian = (pointer.obsidianEndpoint ?? DEFAULT_OBSIDIAN_ENDPOINT).replace(/\/+$/, "");
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
  const inboxFiles = await listInboxFiles(inboxPath);
  const fileLines = new Map<string, string[]>();
  let readAny = false;
  for (const path of inboxFiles) {
    try {
      const res = await fetch(`${obsidian}/resolve`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ type: "obsidian:note", pointer: { type: "obsidian:note", path } }),
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

  // 2. Parse UNPROCESSED requests across ALL inbox files: unchecked tasks `- [ ] <text>`.
  const requests: ParsedRequest[] = [];
  for (const [path, lines] of fileLines) {
    lines.forEach((raw, i) => {
      const m = raw.match(/^\s*[-*]\s+\[\s\]\s+(.+?)\s*$/);
      if (m) {
        const cap = m[1] ?? "";
        const text = cap.replace(/^\(example\)\s*/i, "").trim();
        if (text && !/^\(example\)/i.test(cap)) requests.push({ raw, text, lineIndex: i, file: path });
      }
    });
  }

  if (requests.length === 0) {
    return { shape: "obsidianRequestScan", body: { requests_found: 0, dispatched: 0, inbox_path: inboxPath, inbox_files: inboxFiles, generated_at: generatedAt } };
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
  const statusLines = [
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
