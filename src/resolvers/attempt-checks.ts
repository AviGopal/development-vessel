import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendRecord, ledgerDir } from "./attempt-ledger.js";
import { resolveSystemdUnitHealthObserver } from "./systemd-unit-health-observer.js";
import { resolveGateSelfProbe } from "./gate-self-probe.js";
import { ResolverResult } from "./types.js";

export type Verdict = "pass" | "fail" | "unknown" | "timeout" | "not_applicable";

export interface CheckResult {
  id: string;
  verdict: Verdict;
  detail?: string;
  definition_version: string;
}

async function getFileSha256Prefix(filePath: string): Promise<string> {
  try {
    const content = await fs.promises.readFile(filePath, "utf8");
    const hash = createHash("sha256");
    hash.update(content);
    return hash.digest("hex").substring(0, 12);
  } catch (error) {
    return "unknown";
  }
}

export function baselineCheckSet(): string[] {
  const policyPath = path.join(ledgerDir(), "policy", "baselineCheckSet.json");
  try {
    const content = fs.readFileSync(policyPath, "utf8");
    const parsed = JSON.parse(content);
    if (parsed && Array.isArray(parsed.checks)) {
      return parsed.checks as string[];
    }
  } catch (error) {
    // console.warn(`Failed to read or parse baselineCheckSet.json: ${error}`);
  }
  return ["systemd_units", "gate_self_probe", "ledger_canary"];
}

export function invariantSelect(opts: { touched_files?: string[]; gap_check_ids?: string[] }): { checks: string[]; baseline: string[] } {
  const baseline = baselineCheckSet();
  const gapChecks = opts.gap_check_ids || [];
  const combinedChecks = Array.from(new Set([...baseline, ...gapChecks]));
  return { checks: combinedChecks, baseline };
}

export async function evaluateChecks(ids: string[], perCheckTimeoutMs = 60000): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const id of ids) {
    let checkPromise: Promise<CheckResult[]>;
    let definition_version = "unknown";

    switch (id) {
      case "systemd_units":
        definition_version = await getFileSha256Prefix("/vessels/development-vessel/src/resolvers/systemd-unit-health-observer.ts");
        checkPromise = resolveSystemdUnitHealthObserver({ type: "systemd_unit_health_observer", emit_gap: false } as never).then((res: ResolverResult) => {
          const shape = (res as any).shape;
          const body: any = (res as any).body || {};
          if (shape === "systemdUnitHealth") {
            if (!Array.isArray(body.units)) {
              return [{ id: "systemd_units", verdict: "unknown", detail: "Invalid response structure", definition_version }];
            }
            return body.units.map((unit: any) => {
              let verdict: Verdict = "unknown";
              if (unit.active_state === "active" || (unit.is_oneshot && unit.result === "success")) {
                verdict = "pass";
              } else if (unit.active_state === "failed" || (unit.result && unit.result !== "success")) {
                verdict = "fail";
              }
              return { id: `unit:${unit.unit}`, verdict, detail: unit.state, definition_version };
            });
          } else if (shape === "structuredError") {
            return [{ id: "systemd_units", verdict: "unknown", detail: body?.message, definition_version }];
          }
          return [{ id: "systemd_units", verdict: "unknown", detail: "Unexpected resolver shape", definition_version }];
        });
        break;
      case "gate_self_probe":
        definition_version = await getFileSha256Prefix("/vessels/development-vessel/src/resolvers/gate-self-probe.ts");
        checkPromise = resolveGateSelfProbe({ type: "gate_self_probe", emit_gap: false } as never).then((res: ResolverResult) => {
          const shape = (res as any).shape;
          const body: any = (res as any).body || {};
          if (shape === "gateSelfProbe" || shape === "gateSelfProbeReport") {
            if (!Array.isArray(body.outcomes)) {
              return [{ id: "gate_self_probe", verdict: "unknown", detail: "Invalid response structure", definition_version }];
            }
            return body.outcomes.map((outcome: any) => ({
              id: `gate:${outcome.rule}`,
              verdict: outcome.ok ? "pass" : "fail",
              detail: outcome.message,
              definition_version,
            }));
          } else if (shape === "structuredError") {
            return [{ id: "gate_self_probe", verdict: "unknown", detail: body?.message, definition_version }];
          }
          return [{ id: "gate_self_probe", verdict: "unknown", detail: "Unexpected resolver shape", definition_version }];
        });
        break;
      case "ledger_canary":
        definition_version = await getFileSha256Prefix("/vessels/development-vessel/src/resolvers/attempt-checks.ts");
        checkPromise = (async () => {
          const canaryPath = process.env.LEDGER_CANARY_PATH ?? "/vessels/development-vessel/src/fixtures/attempt-ledger-canary.json";
          try {
            const content = await fs.promises.readFile(canaryPath, "utf8");
            const data = JSON.parse(content);
            if (data.canary === "intact") {
              return [{ id: "ledger_canary", verdict: "pass", definition_version }];
            } else {
              return [{ id: "ledger_canary", verdict: "fail", detail: "Canary file content mismatch", definition_version }];
            }
          } catch (e) {
            return [{ id: "ledger_canary", verdict: "unknown", detail: (e as Error).message, definition_version }];
          }
        })();
        break;
      default:
        checkPromise = Promise.resolve([{ id, verdict: "not_applicable", definition_version: "unknown" }]);
        break;
    }

    try {
      const timeout = new Promise<CheckResult[]>((_, reject) => setTimeout(() => reject(new Error("timeout")), perCheckTimeoutMs));
      const checkResults = await Promise.race([checkPromise, timeout]);
      results.push(...checkResults);
    } catch (e: any) {
      if (e.message === "timeout") {
        results.push({ id, verdict: "timeout", definition_version });
      } else {
        results.push({ id, verdict: "unknown", detail: e.message, definition_version });
      }
    }
  }
  return results;
}

export async function takeSnapshot(opts: { checks: string[]; context: string; repos?: string[] }): Promise<{ snapshot_id: string; at: string; results: CheckResult[]; artifacts: Record<string, string> }> {
  const snapshot_id = `snap-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`;
  const at = new Date().toISOString();
  const results = await evaluateChecks(opts.checks);
  const artifacts: Record<string, string> = {};

  // Add runtime artifact for development-vessel
  artifacts["runtime:development-vessel"] = await getFileSha256Prefix("/vessels/development-vessel/src/index.ts");

  if (opts.repos) {
    for (const repoPath of opts.repos) {
      try {
        const sha = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
        artifacts[`repo:${repoPath}`] = sha;
      } catch (e) {
        artifacts[`repo:${repoPath}`] = "unknown";
      }
    }
  }

  const snapshot = { snapshot_id, at, results, artifacts };
  await appendRecord("stateSnapshot", snapshot_id, snapshot);
  return snapshot;
}

export async function resolveAttemptSnapshot(pointer: { type: "attempt_snapshot"; checks?: string[]; context?: string }): Promise<ResolverResult> {
  const { checks: explicitChecks } = invariantSelect({ gap_check_ids: pointer.checks });
  const context = pointer.context ?? "manual";

  const snapshot = await takeSnapshot({
    checks: explicitChecks,
    context: context,
    repos: ["/vessels/development-vessel"],
  });

  return { shape: "stateSnapshot", body: snapshot };
}