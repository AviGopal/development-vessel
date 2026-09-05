import * as fs from "node:fs";
import * as path from "node:path";

/**
 * env_gate_scan — detector for env-var-gated capabilities (defect class).
 * Walks vessel source trees for process.env.<NAME> reads where the name is
 * NOT set in the running environment (/etc/substrate/env + unit files) AND
 * the unset branch disables a capability or silently falls back. Emits shape
 * `envGateReport`; files one substrateGap per distinct env var (stable id).
 * Exempt: secret-like names (env is legitimate) and reads with inline
 * defaults (tuning, not gating). Principle: concept_VKtQIcdgJ_7l.
 */

export interface EnvGateScanPointer {
  type: "env_gate_scan";
  rootDir?: string;
  envFile?: string;
  unitsDir?: string;
  emitCap?: number;
  devVesselImpulsesUrl?: string;
  dry_run?: boolean;
}

export interface EnvGateFinding {
  vessel: string;
  env_name: string;
  file: string;
  line: number;
  consequence_guess: string;
}

const SECRET_RE = /KEY|SECRET|TOKEN|PASSWORD/;
const GUARD_RE = /if \(!|return null|return FALLBACK|return;|continue;|=== ['"]false['"]|!== ['"]true['"]|\?\?|\?\?=/;
const ENV_READ_RE = /process\.env(?:\.([A-Z_0-9]+)|\[["']([A-Z_0-9]+)["']\])/;

function collectSetEnvNames(envFile: string, unitsDir: string): Set<string> {
  const names = new Set<string>();
  try {
    for (const l of fs.readFileSync(envFile, "utf8").split("\n")) {
      const m = l.match(/^([A-Z_0-9]+)=/);
      if (m && m[1]) names.add(m[1]);
    }
  } catch { /* env file absent */ }
  try {
    for (const f of fs.readdirSync(unitsDir)) {
      if (!f.endsWith(".service")) continue;
      try {
        for (const m of fs.readFileSync(path.join(unitsDir, f), "utf8").matchAll(/Environment=([A-Z_0-9]+)=/g)) {
          if (m[1]) names.add(m[1]);
        }
      } catch { /* unreadable unit */ }
    }
  } catch { /* units dir absent */ }
  return names;
}

function walkTsFiles(dir: string, out: string[]): void {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walkTsFiles(p, out); }
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
}

export async function resolveEnvGateScan(pointer: EnvGateScanPointer): Promise<{ shape: string; body: unknown }> {
  const rootDir = pointer.rootDir ?? "/workspace/git/vessels";
  const setNames = collectSetEnvNames(pointer.envFile ?? "/etc/substrate/env", pointer.unitsDir ?? "/etc/systemd/system");
  const findings: EnvGateFinding[] = [];
  let vessels: string[] = [];
  try { vessels = fs.readdirSync(rootDir); } catch { /* root absent */ }
  for (const vessel of vessels) {
    const srcDir = path.join(rootDir, vessel, "src");
    if (!fs.existsSync(srcDir)) continue;
    const files: string[] = [];
    walkTsFiles(srcDir, files);
    for (const file of files) {
      let lines: string[] = [];
      try { lines = fs.readFileSync(file, "utf8").split("\n"); } catch { continue; }
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const m = line.match(ENV_READ_RE);
        if (!m) continue;
        const name = m[1] ?? m[2] ?? "";
        if (!name || SECRET_RE.test(name)) continue;
        if (line.includes("??") || line.includes("||")) continue;
        if (setNames.has(name)) continue;
        const windowText = lines.slice(i, i + 4).join("\n");
        if (!GUARD_RE.test(windowText)) continue;
        findings.push({ vessel, env_name: name, file: file.slice(rootDir.length + 1), line: i + 1, consequence_guess: windowText.slice(0, 160) });
      }
    }
  }
  const byVar = new Map<string, EnvGateFinding[]>();
  for (const f of findings) {
    const arr = byVar.get(f.env_name) ?? [];
    arr.push(f);
    byVar.set(f.env_name, arr);
  }
  const emitted: string[] = [];
  if (pointer.dry_run !== true) {
    const emitUrl = pointer.devVesselImpulsesUrl ?? "http://127.0.0.1:8090/v2/impulses/resolve";
    const apiKey = process.env["METABOB_API_KEY"] ?? "";
    const emitCap = pointer.emitCap ?? 3;
    for (const [name, hits] of byVar) {
      if (emitted.length >= emitCap) break;
      const first = hits[0];
      if (!first) continue;
      const gapId = "gap-env-gated-" + name.toLowerCase().replace(/_/g, "-");
      const vesselList = [...new Set(hits.map((h) => h.vessel))].join(", ");
      try {
        const resp = await fetch(emitUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}) },
          body: JSON.stringify({ impulse: { pointer: { type: "substrateGap_write", gap: {
            id: gapId,
            category: "architectural_pattern",
            source: "substrate_detected",
            status: "open",
            detected_at: new Date().toISOString(),
            summary: `env-gated capability: ${name} is read by ${vesselList}, unset in the running environment, and its unset branch disables a capability or silently falls back (${hits.length} site(s), e.g. ${first.file}:${first.line}). Vessel dependencies resolve via discovery; env-gated capability is substrate-invisible configuration.`,
            classification_metadata: { detector: "env_gate_scan", env_name: name, sites: hits.slice(0, 5), cited_principle: "concept_VKtQIcdgJ_7l" },
          } } } }),
          signal: AbortSignal.timeout(10_000),
        });
        if (resp.ok) emitted.push(gapId);
      } catch { /* emission is best-effort */ }
    }
  }
  return {
    shape: "envGateReport",
    body: { findings, distinct_env_vars: [...byVar.keys()], gaps_emitted: emitted, scanned_vessels: vessels.length, dry_run: pointer.dry_run === true },
  };
}
