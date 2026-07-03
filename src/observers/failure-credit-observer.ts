// failure-credit-observer v0: the missing FAILURE half of the two-sided concept posterior.
// credit_primed_concepts runs only at the drafter's SUCCESS terminal, so outcome=failure
// rows never flow organically. This observer watches for failed draft-gap-closing
// executions, extracts the concept ids the run actually primed (from the trace's
// prime_substrate_concepts task), and credits each with outcome=failure using the real
// execution id as trace_id. NO fallback crediting: if ids cannot be extracted, the miss
// is durably recorded instead (never blanket-credit — that was the original defect).

const METABOB_ENDPOINT = process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
const CONCEPT_DB_BASE = process.env["CONCEPT_DB_ENDPOINT"] ?? "http://127.0.0.1:8260";
const API_KEY = process.env["METABOB_API_KEY"] ?? "";

const DEDUPE_MS = 60_000;
const recent = new Map<string, number>();

function fresh(key: string): boolean {
  const last = recent.get(key);
  const now = Date.now();
  if (last !== undefined && now - last < DEDUPE_MS) return false;
  recent.set(key, now);
  if (recent.size > 256) { const oldest = [...recent.entries()].sort((a, b) => a[1] - b[1]); for (const [k] of oldest.slice(0, 64)) recent.delete(k); }
  return true;
}

async function creditFailure(executionId: string): Promise<void> {
  const headers: Record<string, string> = API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {};
  let ids: string[] = [];
  try {
    const res = await fetch(`${METABOB_ENDPOINT}/v2/activities/execution-traces/${encodeURIComponent(executionId)}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const trace = (await res.json()) as { tasks?: Array<Record<string, unknown>> };
      const primeTask = (trace.tasks ?? []).find((t) => String(t["id"] ?? t["task_id"] ?? "").includes("prime_substrate_concepts"));
      if (primeTask) {
        const blob = JSON.stringify(primeTask);
        ids = [...new Set([...blob.matchAll(/concept_[A-Za-z0-9_-]{8,}/g)].map((m) => m[0]))];
      }
    }
  } catch { /* extraction is best-effort; miss recorded below */ }
  if (ids.length === 0) {
    try {
      const { appendFile, mkdir } = await import("node:fs/promises");
      await mkdir("/workspace/observations", { recursive: true });
      await appendFile("/workspace/observations/failure-credit-misses.jsonl", JSON.stringify({ at: new Date().toISOString(), execution_id: executionId, reason: "no primed concept ids extractable from trace" }) + "\n");
    } catch { /* durable record is best-effort */ }
    return;
  }
  for (const id of ids.slice(0, 20)) {
    try {
      await fetch(`${CONCEPT_DB_BASE}/concepts/${encodeURIComponent(id)}/usage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}) },
        body: JSON.stringify({ outcome: "failure", trace_id: executionId }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* per-id best-effort */ }
  }
}

let _stop: AbortController | null = null;

export function stopFailureCreditObserver(): void {
  _stop?.abort();
  _stop = null;
}

export function startFailureCreditObserver(): void {
  if (_stop) return;
  const controller = new AbortController();
  _stop = controller;
  function connect(backoffMs: number): void {
    if (controller.signal.aborted) return;
    const wsUrl = METABOB_ENDPOINT.replace(/^http/, "ws") + "/ws";
    let ws: WebSocket;
    try { ws = new WebSocket(wsUrl); } catch { setTimeout(() => connect(Math.min(backoffMs * 2, 30_000)), backoffMs); return; }
    ws.addEventListener("open", () => { try { ws.send(JSON.stringify({ type: "authenticate", token: API_KEY })); } catch { /* auth best-effort */ } });
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { type?: string; activity_template_id?: string; execution_id?: string };
        if (msg.type !== "lifecycle:execution:failed" && msg.type !== "execution.failed") return;
        const tid = String(msg.activity_template_id ?? "");
        if (!tid.includes("draft-gap-closing")) return;
        const execId = String(msg.execution_id ?? "");
        if (!execId || !fresh(execId)) return;
        void creditFailure(execId);
      } catch { /* never throw into the WS loop */ }
    });
    ws.addEventListener("close", () => { if (!controller.signal.aborted) setTimeout(() => connect(Math.min(backoffMs * 2, 30_000)), backoffMs); });
    ws.addEventListener("error", () => { try { ws.close(); } catch { /* already closing */ } });
  }
  connect(1000);
}
