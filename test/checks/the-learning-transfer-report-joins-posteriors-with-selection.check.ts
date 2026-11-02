// REALIGNMENT section 7 step 8 (futures from history), exit:
//   "Spearman(posterior mean, selection share) >= 0.3 over competing arms with n >= 20".
// learning-transfer-report already joins variant_performance_metrics with
// thompson_selection_log, but it never computes selection share or Spearman rho
// over competing arms. Nothing can read the exit today.
//
// No network is used. globalThis.fetch is replaced in-process with a fake that
// answers the report's SurrealDB /sql batch from synthetic rows.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as mod from "../../src/resolvers/learning-transfer-report";

const N_ARMS = 24;

interface Arm {
  activity_id: string;
  alpha: number;
  beta: number;
  posterior_mean: number;
  success_rate: number;
  total_executions: number;
  selections: number;
}

// The selection share rank is i, with selections = 20 + 5*i, so every arm has n >= 20.
// The posterior-mean rank is posteriorRank(i).
function buildArms(posteriorRank: (i: number) => number): Arm[] {
  const arms: Arm[] = [];
  for (let i = 0; i < N_ARMS; i++) {
    const p = posteriorRank(i);
    const alpha = 10 + 3 * p;
    const beta = 100 - alpha;
    const selections = 20 + 5 * i;
    arms.push({
      activity_id: `activity:arm_${i}`,
      alpha,
      beta,
      posterior_mean: alpha / (alpha + beta),
      success_rate: alpha / (alpha + beta),
      total_executions: selections,
      selections,
    });
  }
  return arms;
}

// Planted permutation: p(i) = 11*i mod 24. Spearman rho of this against i is -10/1150 (about -0.009).
const shuffledArms = buildArms((i) => (11 * i) % N_ARMS);
const monotoneArms = buildArms((i) => i);

function rowsFor(stmt: string, arms: Arm[]): Array<Record<string, unknown>> {
  const s = stmt.toLowerCase();
  if (s.includes("thompson_selection_log")) {
    if (s.includes("group all")) {
      const total = arms.reduce((acc, a) => acc + a.selections, 0);
      return [{ count: total, n: total }];
    }
    return arms.map((a) => ({ activity_id: a.activity_id, n: a.selections, count: a.selections, selections: a.selections }));
  }
  if (s.includes("total_executions = 0")) {
    return s.includes("count()") ? [{ count: 0 }] : [];
  }
  if (s.includes("variant_performance_metrics")) {
    if (s.includes("count()") && s.includes("group all")) return [{ count: arms.length }];
    return arms.map((a) => ({
      activity_id: a.activity_id,
      alpha: a.alpha,
      beta: a.beta,
      posterior_mean: a.posterior_mean,
      success_rate: a.success_rate,
      total_executions: a.total_executions,
    }));
  }
  if (s.includes("count()") && s.includes("group all")) return [{ count: 0 }];
  return [];
}

function fakeSurreal(arms: Arm[]): typeof fetch {
  const impl = async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === "string" ? init.body : "";
    const stmts = body.split(";").map((x) => x.trim()).filter((x) => x.length > 0);
    const results = stmts.map((st) => ({ status: "OK", result: rowsFor(st, arms) }));
    return new Response(JSON.stringify(results), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return impl as unknown as typeof fetch;
}

function findRho(v: unknown, depth: number): number | undefined {
  if (depth > 8 || v === null || typeof v !== "object") return undefined;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (/rho|spearman/i.test(k) && typeof val === "number") return val;
  }
  for (const val of Object.values(v as Record<string, unknown>)) {
    const r = findRho(val, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

const realFetch = globalThis.fetch;

describe("learning-transfer-report joins posteriors with selection share", () => {
  beforeEach(() => {
    process.env["SURREALDB_URL"] = "http://surreal.invalid";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("shuffled posteriors (planted permutation) report rho ~ 0 and the exit reads NOT MET", async () => {
    globalThis.fetch = fakeSurreal(shuffledArms);
    const res = await mod.resolveLearningTransferReport({ type: "learning_transfer_report" });
    expect(res.shape).toBe("learningTransferReport");
    const body: unknown = res.body;
    const rho = findRho(body, 0);
    // Red today: the report computes no Spearman rho over competing arms.
    expect(typeof rho).toBe("number");
    expect(Math.abs(rho ?? 99)).toBeLessThan(0.15);
    expect(JSON.stringify(body)).toContain("NOT MET");
  });

  test("control: monotone synthetic arms (n >= 20) keep counter integrity: no violations", () => {
    const sel = new Map<string, number>();
    for (const a of monotoneArms) sel.set(a.activity_id.replace(/^activity:/, ""), a.selections);
    const out = mod.counterIntegrity(monotoneArms, sel, { minExecutions: 20 });
    expect(out.checked).toBe(N_ARMS);
    expect(out.violations.length).toBe(0);
    expect(out.worst_ratio).toBe(1);
  });
});
