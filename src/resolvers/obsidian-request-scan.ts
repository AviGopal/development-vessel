import type { ResolverResult } from "./types.js";

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

  // 1. Read the operator's inbox (a plain read; observer-skip does not apply).
  let inbox = "";
  try {
    const res = await fetch(`${obsidian}/resolve`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ type: "obsidian:note", pointer: { type: "obsidian:note", path: inboxPath } }),
      signal: AbortSignal.timeout(Math.min(timeoutMs, 8000)),
    });
    const json = (await res.json()) as { success?: boolean; content?: string };
    if (json.success && typeof json.content === "string") inbox = json.content;
  } catch (err) {
    return { shape: "obsidianRequestScan", body: { unreachable: true, stage: "read_inbox", detail: err instanceof Error ? err.message.slice(0, 120) : "err", inbox_path: inboxPath, generated_at: generatedAt } };
  }
  if (!inbox) {
    // No inbox yet — seed one so the operator knows the channel exists.
    const seed = `# Substrate Inbox\n\n_Write a request as an unchecked task and I'll pick it up, tell you in [[Now]] that I'm working on it, and deliver the result under Substrate/._\n\n- [ ] (example) summarize my open notes into a briefing\n`;
    await writeNote(obsidian, auth, inboxPath, seed, timeoutMs).catch(() => {});
    return { shape: "obsidianRequestScan", body: { seeded_inbox: true, inbox_path: inboxPath, requests_found: 0, generated_at: generatedAt } };
  }

  // 2. Parse UNPROCESSED requests: unchecked tasks `- [ ] <text>`.
  const lines = inbox.split("\n");
  const requests: ParsedRequest[] = [];
  lines.forEach((raw, i) => {
    const m = raw.match(/^\s*[-*]\s+\[\s\]\s+(.+?)\s*$/);
    if (m) {
      const cap = m[1] ?? "";
      const text = cap.replace(/^\(example\)\s*/i, "").trim();
      if (text && !/^\(example\)/i.test(cap)) requests.push({ raw, text, lineIndex: i });
    }
  });

  if (requests.length === 0) {
    return { shape: "obsidianRequestScan", body: { requests_found: 0, dispatched: 0, inbox_path: inboxPath, generated_at: generatedAt } };
  }

  // 3. Dispatch each request (the run-goal path → author→serve loop) + collect acks.
  const dispatched: Array<{ text: string; dispatchId?: string; status: string; lineIndex: number }> = [];
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
    dispatched.push({ text: req.text, dispatchId, status, lineIndex: req.lineIndex });
  }

  // 4a. ACK: write the status board the operator reads ("we are working on it").
  const statusLines = [
    "---", "substrate_board: now", `generated_at: ${generatedAt}`, "---", "",
    "# What I'm working on right now", "",
    "_You asked, I'm on it. Results land under `Substrate/` and I mark your [[Inbox]] item done._", "",
  ];
  for (const d of dispatched) {
    const icon = d.dispatchId ? "🔄" : "⚠️";
    statusLines.push(`- ${icon} **${d.text}** — ${d.dispatchId ? `working (dispatch \`${d.dispatchId}\`)` : `could not start: ${d.status}`}`);
  }
  statusLines.push("");
  const statusWrote = await writeNote(obsidian, auth, statusPath, statusLines.join("\n"), timeoutMs).catch(() => false);

  // 4b. Mark processed in the inbox so requests are not re-dispatched.
  const dispatchedByLine = new Map(dispatched.map((d) => [d.lineIndex, d]));
  const updated = lines.map((raw, i) => {
    const d = dispatchedByLine.get(i);
    if (d && d.dispatchId) return raw.replace(/\[\s\]/, "[x]") + ` ⟶ dispatched \`${d.dispatchId}\` (see [[Now]])`;
    return raw;
  }).join("\n");
  const inboxWrote = await writeNote(obsidian, auth, inboxPath, updated, timeoutMs).catch(() => false);

  return {
    shape: "obsidianRequestScan",
    body: {
      requests_found: requests.length,
      dispatched: dispatched.filter((d) => d.dispatchId).length,
      requests: dispatched.map((d) => ({ text: d.text, dispatchId: d.dispatchId, status: d.status })),
      status_board_written: statusWrote,
      inbox_marked: inboxWrote,
      inbox_path: inboxPath,
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
