/**
 * feature_compose (2026-06-21) — the seed FEATURE composer.
 *
 * The substrate has two SURGICAL patchers (apply_proposal_as_patch,
 * patch_with_tools) and no FEATURE composer — so feature-sized self-improvement
 * proposals get drafted and then refused as non_surgical, and the operator fills
 * the gap by hand. This closes that gap WITHIN the framing: it composes the
 * existing surgical atoms (local-tools-vessel fs_write/fs_edit + code_verify_
 * typecheck) into a multi-file, multi-vessel change.
 *
 * Why it converges where patch_with_tools stalls: patch_with_tools is agentic
 * PER TURN (the LLM decides one tool call at a time and burns its turn budget
 * grazing the file). feature_compose PLANS ONCE (a single LLM call produces the
 * full ordered op list) then EXECUTES DETERMINISTICALLY — no per-step LLM
 * indecision. Verification (typecheck per touched vessel) gates the verdict;
 * UNFAVORABLE rolls the tree back so a bad plan never lands.
 *
 * Flow: decompose(spec) -> [ops] -> apply each (fs_write/fs_edit) -> verify
 * (typecheck each touched vessel) -> verdict FAVORABLE|UNFAVORABLE ->
 * rollback-on-fail. Landing (commit/push) is a SEPARATE downstream cutover step
 * — this resolver stages + reports, matching the mitosis-evaluate/cutover split.
 */
import { METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

const DISCOVERY_ENDPOINT = process.env.DISCOVERY_ENDPOINT ?? "http://127.0.0.1:8100";
// In-container authoring targets the WRITABLE runtime (/vessels), like the
// surgical patchers (patch_with_tools/apply_proposal_as_patch use vessels_root
// "/vessels"). The host repo bind-mount is READ-ONLY from the container; a
// host-side poller bridges /vessels changes to git. Paths are repos/<vessel>/...
// in the plan and mapped to ${RUNTIME_ROOT}/<vessel>/... here.
const RUNTIME_ROOT = process.env.MITOSIS_RUNTIME_DIR ?? "/vessels";
const REPO_ROOT = RUNTIME_ROOT;
const PER_CALL_TIMEOUT_MS = 90_000;

export interface FeatureComposePointer {
  type: "feature_compose";
  /** Free-text feature specification (what to build + concrete file/behaviour detail). */
  spec: string;
  /** Optional explicit vessel dirs to typecheck (relative to repo root, e.g. "repos/activity-api"). */
  verify_vessels?: string[];
  model?: string;
  /** If true: plan only, do not apply. */
  dry_run?: boolean;
  /** If true: keep edits on UNFAVORABLE instead of rolling back (for debugging). */
  keep_on_fail?: boolean;
  /** Hard cap on ops in a single plan (default 24). */
  max_ops?: number;
}

interface PlanOp {
  kind: "create_file" | "edit";
  path: string;            // repo-relative, e.g. "repos/<vessel>/src/index.ts"
  content?: string;        // for create_file
  old_string?: string;     // for edit
  new_string?: string;     // for edit
  rationale?: string;
}

type Json = Record<string, unknown>;

async function llmCall(endpoint: string, prompt: string, model: string): Promise<string> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
    body: JSON.stringify({ type: "llm_completion", prompt, model, max_tokens: 8000 }),
    signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`llm fetch ${res.status}`);
  const j = (await res.json()) as { content?: string; data?: string; error?: string };
  if (j.error) throw new Error(`llm error: ${j.error}`);
  return (j.content ?? j.data ?? "").trim();
}

async function discover(shape: string): Promise<string | null> {
  try {
    const r = await fetch(`${DISCOVERY_ENDPOINT}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape } }),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { content?: { vessels?: Array<{ endpoint: string; resolve_endpoint?: string; health_score?: number }> } };
    const vs = (data.content?.vessels ?? []).sort((a, b) => (b.health_score ?? 0) - (a.health_score ?? 0));
    const best = vs[0];
    if (!best) return null;
    const ep = best.resolve_endpoint ?? "/resolve";
    return ep.startsWith("http") ? ep : `${best.endpoint.replace(/\/$/, "")}${ep.startsWith("/") ? ep : `/${ep}`}`;
  } catch { return null; }
}

async function callTool(endpoint: string, tool: string, args: Json): Promise<{ ok: boolean; body: Json }> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
      body: JSON.stringify({ impulse: { pointer: { type: tool, ...args } } }),
      signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as Json;
    const errored =
      !res.ok || typeof body?.error === "string" || (body as { shape?: string })?.shape === "structuredError" || body?.success === false;
    return { ok: !errored, body };
  } catch (err) { return { ok: false, body: { error: (err as Error).message } }; }
}

function parseJsonObject(raw: string): Json | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, escape = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]!;
    if (escape) { escape = false; continue; }
    if (inStr) { if (ch === "\\") escape = true; else if (ch === "\"") inStr = false; continue; }
    if (ch === "\"") { inStr = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

function vesselDirOf(repoRelPath: string): string | null {
  const m = repoRelPath.match(/^repos\/([^/]+)\//);
  return m ? `repos/${m[1]}` : null;
}

function decomposePrompt(spec: string, maxOps: number): string {
  return `You are a senior engineer decomposing a feature specification into a CONCRETE, ORDERED plan of file operations. Output is executed deterministically — there is no follow-up turn, so the plan must be COMPLETE and CORRECT.

Repo root contains vessels at repos/<vessel>/. Each vessel is a Bun + TypeScript project with its own tsconfig.json. Edits must compile (\`bun run typecheck\`).

FEATURE SPEC:
${spec}

Emit ONE JSON object, no markdown fences, with this exact schema:
{
  "summary": "<one line>",
  "touched_vessels": ["repos/<vessel>", ...],   // dirs to typecheck after applying
  "ops": [
    // create a NET-NEW file (full contents):
    { "kind": "create_file", "path": "repos/<vessel>/<subpath>", "content": "<FULL file contents>", "rationale": "<why>" },
    // edit an EXISTING file (exact-substring replace; old_string MUST be a verbatim unique substring of the current file):
    { "kind": "edit", "path": "repos/<vessel>/<subpath>", "old_string": "<verbatim current text>", "new_string": "<replacement>", "rationale": "<why>" }
  ]
}

RULES:
- At most ${maxOps} ops. Order them so dependencies come first (create files before editing references to them).
- create_file content must be COMPLETE and typecheck-clean on its own. Prefer ZERO external npm imports for net-new vessels (use Bun built-ins: Bun.serve, fetch, process.env) so no dependency install is needed. Include a tsconfig.json and package.json for any net-new vessel.
- edit old_string must be copied VERBATIM and be UNIQUE in the target file; keep it minimal but unambiguous. Preserve everything you are not changing.
- Do NOT invent file paths that must already exist without being sure; for edits, target real files named in the spec.
- No prose outside the JSON.`;
}

export async function resolveFeatureCompose(pointer: FeatureComposePointer): Promise<ResolverResult> {
  const model = pointer.model ?? "anthropic/claude-sonnet-4-6";
  const maxOps = pointer.max_ops ?? 24;
  const dryRun = pointer.dry_run ?? false;

  const llmEndpoint = await discover("llm_completion") ?? await discover("llmCompletion");
  const toolsEndpoint = await discover("shellResult");
  if (!llmEndpoint || !toolsEndpoint) {
    return { shape: "featureComposeReport", body: { ok: false, error: `endpoint discovery failed (llm=${!!llmEndpoint}, tools=${!!toolsEndpoint})` } };
  }

  // 1. DECOMPOSE (single planning call).
  let planRaw: string;
  try {
    planRaw = await llmCall(llmEndpoint, decomposePrompt(pointer.spec, maxOps), model);
  } catch (e) {
    return { shape: "featureComposeReport", body: { ok: false, stage: "decompose", error: (e as Error).message } };
  }
  const plan = parseJsonObject(planRaw);
  const ops = (plan?.ops as PlanOp[] | undefined) ?? [];
  if (!plan || !Array.isArray(ops) || ops.length === 0) {
    return { shape: "featureComposeReport", body: { ok: false, stage: "decompose", error: "plan had no ops", plan_raw: planRaw.slice(0, 1200) } };
  }
  if (ops.length > maxOps) ops.length = maxOps;

  const touched = new Set<string>((plan.touched_vessels as string[] | undefined) ?? []);
  for (const op of ops) { const d = vesselDirOf(op.path); if (d) touched.add(d); }

  const planView = ops.map((o) => ({ kind: o.kind, path: o.path, rationale: o.rationale }));
  if (dryRun) {
    return { shape: "featureComposeReport", body: { ok: true, stage: "plan", summary: plan.summary, touched_vessels: [...touched], ops: planView, op_count: ops.length } };
  }

  // 2. APPLY deterministically. Track created/edited for rollback.
  const created: string[] = [];
  const edited: string[] = [];
  const applied: Array<{ path: string; kind: string; ok: boolean; repaired?: boolean; detail?: string }> = [];
  let applyFailed = false;
  for (const op of ops) {
    const abs = `${REPO_ROOT}/${op.path.replace(/^repos\//, "")}`;
    if (op.kind === "create_file") {
      // local-tools fs_write does not create parent dirs — mkdir -p first so
      // net-new vessel files (in a not-yet-existing dir) land.
      const dir = abs.slice(0, abs.lastIndexOf("/"));
      await callTool(toolsEndpoint, "shell", { command: `mkdir -p ${JSON.stringify(dir)}`, cwd: REPO_ROOT });
      const r = await callTool(toolsEndpoint, "fs_write", { path: abs, content: op.content ?? "" });
      applied.push({ path: op.path, kind: op.kind, ok: r.ok, detail: r.ok ? undefined : JSON.stringify(r.body).slice(0, 200) });
      if (r.ok) created.push(abs); else { applyFailed = true; break; }
    } else {
      let r = await callTool(toolsEndpoint, "fs_edit", { path: abs, old_string: op.old_string ?? "", new_string: op.new_string ?? "" });
      let repaired = false;
      if (!r.ok) {
        // Blind-edit repair: plan-once decomposition can guess an old_string that
        // does not match the LIVE file (it planned without reading it). Read the
        // real content and re-derive a verbatim old_string for the intended
        // change, then retry once. This grounds edits in reality.
        const cat = await callTool(toolsEndpoint, "shell", { command: `cat ${JSON.stringify(abs)}`, cwd: REPO_ROOT });
        const live = String((cat.body as { stdout?: unknown })?.stdout ?? "");
        if (live) {
          try {
            const fix = parseJsonObject(await llmCall(
              llmEndpoint,
              `Current full content of ${op.path}:\n\n${live}\n\nMake this change: ${op.rationale ?? ""}\nIntended replacement behaviour:\n${op.new_string ?? ""}\n\nEmit ONE JSON object {"old_string":"<verbatim UNIQUE substring copied from the content above>","new_string":"<replacement>"}. old_string MUST appear verbatim in the content above. No prose, no fences.`,
              model,
            ));
            if (fix?.old_string) {
              r = await callTool(toolsEndpoint, "fs_edit", { path: abs, old_string: String(fix.old_string), new_string: String(fix.new_string ?? op.new_string ?? "") });
              repaired = r.ok;
            }
          } catch { /* repair failed; r stays not-ok */ }
        }
      }
      applied.push({ path: op.path, kind: op.kind, ok: r.ok, repaired, detail: r.ok ? undefined : JSON.stringify(r.body).slice(0, 200) });
      if (r.ok) { if (!edited.includes(abs)) edited.push(abs); } else { applyFailed = true; break; }
    }
  }

  // 3. VERIFY: typecheck each touched vessel.
  const verify: Array<{ vessel: string; errors: number | string; ok: boolean }> = [];
  if (!applyFailed) {
    for (const v of touched) {
      const r = await callTool(toolsEndpoint, "code_verify_typecheck", { cwd: `${REPO_ROOT}/${v.replace(/^repos\//, "")}` });
      const errCount = (r.body?.error_count ?? r.body?.errors ?? (r.body?.exitCode === 0 ? 0 : "nonzero")) as number | string;
      const ok = r.ok && (errCount === 0 || r.body?.exitCode === 0);
      verify.push({ vessel: v, errors: errCount, ok });
    }
  }

  const verdict = !applyFailed && verify.every((v) => v.ok) && verify.length > 0 ? "FAVORABLE" : "UNFAVORABLE";

  // 4. ROLLBACK on UNFAVORABLE (restore edited, delete created) unless asked to keep.
  let rolled_back = false;
  if (verdict === "UNFAVORABLE" && !pointer.keep_on_fail) {
    for (const v of touched) {
      await callTool(toolsEndpoint, "shell", { command: `git checkout -- . 2>/dev/null || true`, cwd: `${REPO_ROOT}/${v.replace(/^repos\//, "")}` });
    }
    for (const f of created) {
      await callTool(toolsEndpoint, "shell", { command: `rm -f ${JSON.stringify(f)}`, cwd: REPO_ROOT });
    }
    rolled_back = true;
  }

  return {
    shape: "featureComposeReport",
    body: {
      ok: verdict === "FAVORABLE",
      verdict,
      summary: plan.summary,
      touched_vessels: [...touched],
      op_count: ops.length,
      applied,
      apply_failed: applyFailed,
      verify,
      rolled_back,
      created_files: created.map((f) => f.replace(`${REPO_ROOT}/`, "")),
      edited_files: edited.map((f) => f.replace(`${REPO_ROOT}/`, "")),
      next: verdict === "FAVORABLE"
        ? "staged + typecheck-clean; dispatch a cutover (commit/push) to land"
        : "rolled back; inspect applied[].detail and verify[] then refine the spec",
    },
  };
}
