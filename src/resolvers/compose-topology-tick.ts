import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

/**
 * compose_topology_tick — boredom-driven topology exploration via activity composition.
 *
 * WHY (2026-06-19, operator: "orchestration via activity composition + the boredom loop,
 * not a clock"): the substrate's topology is a near-pure star (organic capability
 * composition ≈ 0; ~31/41 nodes are degree-1 pendants), and its native generative
 * frontier is deadlocked until headroom = λ₂·(1−star_ratio) ≥ 0.35. This resolver is the
 * boredom-dispatchable form of the compose-teacher bootstrap: each invocation it finds a
 * reliably-succeeding chainable pair of REAL capabilities (preferring LEAF×LEAF strict
 * chains, which cross-link pendants and raise λ₂), authors a composite that chains them,
 * and dispatches it via goal-host so an organic edge forms. Driven by the boredom loop,
 * exploration rate scales with sample throughput (idle-triggered, ×3 concurrent) rather
 * than a fixed clock; composites can recursively compose further. Retire once headroom
 * crosses 0.35 and the native generative-frontier-gap-tick takes over. Bounded: one
 * composite per tick; caps distinct composites to avoid registry bloat.
 *
 * Env: METABOB_* from config; SURREAL_* + GOAL_HOST_VESSEL_ENDPOINT from process.env
 * (the dev-vessel unit's EnvironmentFile=/etc/substrate/env exports them).
 */
export interface ComposeTopologyTickPointer {
  type: "compose_topology_tick";
  max_composites?: number;
}

const NS = process.env.SURREALDB_NAMESPACE || "activity-system";
const DB = process.env.SURREALDB_DATABASE || "learning_loop";
const SQL_URL = (process.env.SURREALDB_URL || "http://127.0.0.1:8000").replace(/\/$/, "") + "/sql";
const SUSER = process.env.SURREALDB_USERNAME || "root";
const SPASS = process.env.SURREAL_PASS || process.env.SURREALDB_PASSWORD || "";
const GOAL_HOST = (process.env.GOAL_HOST_VESSEL_ENDPOINT || "http://127.0.0.1:8210").replace(/\/$/, "");
const sqlAuth = "Basic " + Buffer.from(`${SUSER}:${SPASS}`).toString("base64");

const HUB = ["validator-dispatch", "slot-binding"];
const isHub = (s: string) => HUB.some((h) => (s || "").includes(h));
// Exclude synthetic probes and the teaching machinery itself (ticks/composites) from
// LEAF candidates so we cross-link real capabilities and avoid recursive self-composition.
const isMeta = (s: string) => /probe|-tick\b|:.*-tick|compose-|compose_topology/.test(s || "");
const plainName = (id: string) => (id || "").replace(/^activity:⟨/, "").replace(/⟩$/, "");

async function sql(q: string): Promise<any[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(SQL_URL, {
        method: "POST",
        headers: { Accept: "application/json", "Surreal-NS": NS, "Surreal-DB": DB, Authorization: sqlAuth, "Content-Type": "text/plain" },
        body: q,
      });
      const text = await r.text();
      if (!text.trim()) throw new Error("empty body");
      const j = JSON.parse(text);
      const last = j[j.length - 1];
      if (last && last.status && last.status !== "OK") throw new Error("sql err");
      return j.map((s: any) => s.result);
    } catch (e) {
      if (attempt === 4) throw e;
      await new Promise((res) => setTimeout(res, 250 * (attempt + 1)));
    }
  }
  return [];
}

export async function resolveComposeTopologyTick(
  pointer: ComposeTopologyTickPointer,
): Promise<ResolverResult> {
  const MAX = pointer.max_composites ?? 40;
  const auth = { Authorization: `ApiKey ${METABOB_API_KEY}`, "Content-Type": "application/json" };

  // Real (non-hub) activities + their shapes.
  const [acts] = await sql(`SELECT id, input_shapes, output_shapes FROM activity WHERE proposed != true LIMIT 3000;`);
  const real = (acts || []).filter((a: any) => a.id && !isHub(a.id));

  // Reliably-succeeding (≥1 success / 24h).
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const [succRows] = await sql(`SELECT activity_id, count() AS ok FROM activity_execution_traces WHERE executed_at >= type::datetime("${since}") AND success = true GROUP BY activity_id;`);
  const succeeds = new Set<string>((succRows || []).filter((r: any) => (r.ok ?? 0) > 0).map((r: any) => r.activity_id));
  const reliable = real.filter((a: any) => succeeds.has(a.id));

  // Chainable pairs: strict (output∈input) + relaxed (producer emits something; chains via
  // environment state). Prefer leaf×leaf strict (cross-links pendants → raises λ₂).
  type Pair = { producer: string; consumer: string; shape: string; strict: boolean };
  const strict: Pair[] = [], relaxed: Pair[] = [];
  for (const p of reliable) {
    for (const c of reliable) {
      if (c.id === p.id) continue;
      const shared = (p.output_shapes || []).find((s: string) => (c.input_shapes || []).includes(s));
      if (shared) strict.push({ producer: p.id, consumer: c.id, shape: shared, strict: true });
      else if ((p.output_shapes || []).length) relaxed.push({ producer: p.id, consumer: c.id, shape: (p.output_shapes || [])[0], strict: false });
    }
  }
  const pairs = [...strict, ...relaxed];

  // Existing composites (so we don't re-author) — any non-meta activity dispatching others.
  const [existing] = await sql(`SELECT id, tasks FROM activity WHERE proposed != true LIMIT 3000;`);
  const composedTargets = new Set<string>();
  const compositeIds = new Set<string>();
  for (const a of existing || []) {
    const dispatched = (a.tasks || []).filter((t: any) => t.resolver === "activity" && t.config?.templateId).map((t: any) => t.config.templateId);
    if (dispatched.length && !/probe/.test(a.id)) { compositeIds.add(a.id); composedTargets.add(dispatched.sort().join("|")); }
  }

  // CONNECTIVITY-JUSTIFIED selection (operator 2026-06-19: "add cells below the gap only
  // if the expected/demonstrated connectivity increase justifies the growth"). Fetch the
  // current composition-graph degree of each node. Expected Δλ₂ heuristic:
  //   - CROSS-LINK (both endpoints already composed, low-degree) raises λ₂ — builds a mesh
  //     among the composed core → expected POSITIVE. Best.
  //   - BOOTSTRAP (a not-yet-composed leaf, degree 0) adds it to the composed set; a single
  //     such add is pendant-ish (slightly λ₂-negative) but is the necessary seed that later
  //     cross-links raise. Allowed, but demoted.
  //   - HUB endpoint (degree > HUB_DEG): composing it again makes a bigger star → expected
  //     NEGATIVE → excluded outright (never make a hub hubbier).
  const HUB_DEG = 8;
  const deg = new Map<string, number>();
  // GENUINE subgraph adjacency (lifecycle hooks excluded) — the real capability topology.
  const gAdj = new Map<string, Set<string>>();
  try {
    const [edgeRows] = await sql(`SELECT parent_activity_id, child_activity_id FROM activity_composition_graph LIMIT 3000;`);
    for (const e of edgeRows || []) {
      const a = e.parent_activity_id, b = e.child_activity_id;
      if (!a || !b || a === b) continue;
      deg.set(a, (deg.get(a) ?? 0) + 1); deg.set(b, (deg.get(b) ?? 0) + 1);
      if (!isHub(a) && !isHub(b)) {
        if (!gAdj.has(a)) gAdj.set(a, new Set()); if (!gAdj.has(b)) gAdj.set(b, new Set());
        gAdj.get(a)!.add(b); gAdj.get(b)!.add(a);
      }
    }
  } catch { /* graph read failed — fall back to leaf/strict ranking only */ }
  // Genuine connected components (BFS) → component id per node. Bridging two DIFFERENT
  // components is the highest-value λ₂ move: it merges them, taking λ₂ from 0 (disconnected)
  // to positive. (Check-in 2026-06-19: the genuine graph is 2 components → λ₂=0 → headroom 0.)
  const compOf = new Map<string, number>();
  let ncomp = 0;
  for (const node of gAdj.keys()) {
    if (compOf.has(node)) continue;
    ncomp++; const stack = [node]; compOf.set(node, ncomp);
    while (stack.length) { const u = stack.pop()!; for (const v of gAdj.get(u) ?? []) if (!compOf.has(v)) { compOf.set(v, ncomp); stack.push(v); } }
  }
  const d = (id: string) => deg.get(id) ?? 0;
  const inGenuine = (id: string) => gAdj.has(id);
  const isGraphHub = (id: string) => d(id) > HUB_DEG;
  // BRIDGE: both endpoints already in the genuine graph, in DIFFERENT components → merges
  // them. The single highest-value connectivity move while the graph is fragmented.
  const bridge = (p: Pair) => inGenuine(p.producer) && inGenuine(p.consumer) && compOf.get(p.producer) !== compOf.get(p.consumer);
  const crossLink = (p: Pair) => d(p.producer) >= 1 && d(p.consumer) >= 1 && !isGraphHub(p.producer) && !isGraphHub(p.consumer);
  const uncomposed = (p: Pair) => !composedTargets.has([p.producer, p.consumer].sort().join("|"));
  const noHub = (p: Pair) => !isGraphHub(p.producer) && !isGraphHub(p.consumer); // never grow a hub
  const leafPair = (p: Pair) => isMeta(p.producer) === false && isMeta(p.consumer) === false;
  // rank: BRIDGE (merge components) first, then cross-link (mesh), then leaf×leaf, then strict.
  const rank = (p: Pair) => (bridge(p) ? 0 : 8) + (crossLink(p) ? 0 : 4) + (leafPair(p) ? 0 : 2) + (p.strict ? 0 : 1);
  const underCap = compositeIds.size < MAX;
  const candidates = underCap ? pairs.filter((p) => uncomposed(p) && noHub(p)).sort((a, b) => rank(a) - rank(b)) : [];
  const fresh = candidates[0];
  const expected_lambda2 = fresh
    ? (bridge(fresh) ? "JUMP (bridge components)" : crossLink(fresh) ? "positive (cross-link)" : "bootstrap (seed)")
    : null;

  async function dispatch(targetTemplateId: string, goal: string): Promise<any> {
    try {
      const r = await fetch(`${GOAL_HOST}/run-goal`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `ApiKey ${METABOB_API_KEY}` },
        body: JSON.stringify({ goal, targetTemplateId }),
      });
      return r.ok ? await r.json() : { status: "dispatch_failed", http: r.status };
    } catch (e) { return { status: "dispatch_error", error: String(e).slice(0, 120) }; }
  }

  let action: string, composite: string, result: any;
  if (fresh) {
    composite = `compose-${plainName(fresh.producer)}-to-${plainName(fresh.consumer)}`.slice(0, 80);
    const body = {
      id: composite,
      name: `Compose ${plainName(fresh.producer)} → ${plainName(fresh.consumer)} (organic)`,
      description: `Substrate-authored composite (boredom-driven): chain ${fresh.producer} → ${fresh.consumer} via ${fresh.shape}. Produces an organic non-hub composition edge as a side-effect of real work; cross-links capabilities to raise the spectral gap.`,
      tags: ["meta", "composition", "organic.edge", "substrate.authored"],
      input_shapes: [],
      output_shapes: [fresh.shape],
      proposed: false,
      tasks: [
        { id: "dispatch_producer", description: `Run ${fresh.producer}.`, resolver: "activity", config: { reason: "compose step 1", templateId: fresh.producer } },
        { id: "dispatch_consumer", description: `Run ${fresh.consumer}.`, resolver: "activity", config: { reason: "compose step 2", templateId: fresh.consumer } },
      ],
    };
    const reg = await fetch(`${METABOB_ENDPOINT}/v2/activities/templates`, { method: "POST", headers: auth, body: JSON.stringify(body) });
    if (reg.ok) { action = "authored_and_dispatched"; result = await dispatch(`activity:⟨${composite}⟩`, body.description); }
    else { action = "author_failed"; result = { status: reg.status, detail: (await reg.text()).slice(0, 160) }; }
  } else if (compositeIds.size) {
    const ids = [...compositeIds].sort();
    composite = ids[Math.floor(Date.now() / 60000) % ids.length]!;
    action = "reinforced_existing";
    result = await dispatch(composite, `Reinforce composition ${composite}`);
  } else {
    composite = "(none)"; action = "no_pair"; result = { status: "noop" };
  }

  // Latest spectral signal (best-effort) for the becoming.
  let star_ratio: number | null = null, headroom: number | null = null;
  try {
    const sg = (await Bun.file("/workspace/metrics/spectral-gap.jsonl").text()).trim().split("\n").filter(Boolean);
    const last = JSON.parse(sg[sg.length - 1]!);
    star_ratio = last.star_ratio ?? null;
    if (typeof last.fiedler_lambda2 === "number" && typeof last.star_ratio === "number") headroom = Math.round(last.fiedler_lambda2 * (1 - last.star_ratio) * 1e4) / 1e4;
  } catch { /* not ready */ }

  const report = {
    generated_at: new Date().toISOString(),
    action, composite, execution_id: result?.executionId ?? null, outcome: result?.status ?? null,
    expected_lambda2, graph_nodes: deg.size, genuine_components: ncomp,
    chainable_pairs_available: pairs.length, existing_composites: compositeIds.size, under_cap: underCap,
    star_ratio, headroom, unlock_at: 0.35,
  };
  return { shape: "compositionTeachReport", body: report };
}
