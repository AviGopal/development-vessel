import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ResolverResult } from "./types.js";

/**
 * host_container_source_drift_observer (round 2, 2026-06-05) — the dominant
 * host-sync rejection cause is `rejected_base_sha`: container-staged base_sha
 * computed from `/vessels/<vessel>/src` doesn't match what host-sync verifies
 * against `repos/<vessel>/src`. Without an impulse the substrate cannot see
 * this drift; it sees only "intent rejected" outcomes after the fact.
 *
 * For each known vessel pair, walks the container src/ tree, hashes each .ts
 * file under it, then compares with the matching host path inside the
 * host-mounted repo. Emits hostContainerSourceDriftState with per-vessel
 * drift counts and a small sample of drifted files.
 */

const HOST_REPO_ROOT =
  process.env["HOST_REPO_ROOT"] ?? "/home/avi/documents/work/exp-repo/metabob-devbob";
const CONTAINER_VESSELS_ROOT = process.env["CONTAINER_VESSELS_ROOT"] ?? "/vessels";

// Vessel container-name → host-repo dir. Most match directly; activity-api
// maps to repos/metabob-activity-api.
const DEFAULT_VESSEL_PAIRS: Array<{ container: string; host: string }> = [
  { container: "activity-api", host: "metabob-activity-api" },
  { container: "analysis-vessel", host: "analysis-vessel" },
  { container: "boredom-vessel", host: "boredom-vessel" },
  { container: "concept-db", host: "concept-db" },
  { container: "development-vessel", host: "development-vessel" },
  { container: "discovery-vessel", host: "discovery-vessel" },
  { container: "goal-host-vessel", host: "goal-host-vessel" },
  { container: "identity-vessel", host: "identity-vessel" },
  { container: "light-dispatch-vessel", host: "light-dispatch-vessel" },
  { container: "llm-resolver-vessel", host: "llm-resolver-vessel" },
  { container: "local-tools-vessel", host: "local-tools-vessel" },
  { container: "ribosome-vessel", host: "ribosome-vessel" },
];

export interface HostContainerSourceDriftObserverPointer {
  type: "host_container_source_drift_observer";
  hostRepoRoot?: string;
  containerVesselsRoot?: string;
  vesselPairs?: Array<{ container: string; host: string }>;
  maxFilesPerVessel?: number;
  sampleLimit?: number;
}

interface PerVessel {
  vessel: string;
  scanned_files: number;
  drifted_files: number;
  container_missing: boolean;
  host_missing: boolean;
  sample_drifted: string[];
}

async function walkTs(root: string, max: number): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= max) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
        await walk(p);
      } else if (e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".tsx"))) {
        out.push(p);
      }
    }
  }
  await walk(root);
  return out;
}

async function hashFile(p: string): Promise<string | null> {
  try {
    const data = await readFile(p);
    return createHash("sha256").update(data).digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}

export async function resolveHostContainerSourceDriftObserver(
  pointer: HostContainerSourceDriftObserverPointer,
): Promise<ResolverResult> {
  const hostRoot = pointer.hostRepoRoot ?? HOST_REPO_ROOT;
  const containerRoot = pointer.containerVesselsRoot ?? CONTAINER_VESSELS_ROOT;
  const pairs = pointer.vesselPairs ?? DEFAULT_VESSEL_PAIRS;
  const maxFiles = pointer.maxFilesPerVessel ?? 200;
  const sampleLimit = pointer.sampleLimit ?? 5;

  const perVessel: PerVessel[] = [];
  let totalScanned = 0;
  let totalDrifted = 0;
  const allDriftedSample: string[] = [];

  for (const pair of pairs) {
    const containerSrc = join(containerRoot, pair.container, "src");
    const hostSrc = join(hostRoot, "repos", pair.host, "src");
    let containerMissing = false;
    let hostMissing = false;
    try {
      await stat(containerSrc);
    } catch {
      containerMissing = true;
    }
    try {
      await stat(hostSrc);
    } catch {
      hostMissing = true;
    }
    if (containerMissing || hostMissing) {
      perVessel.push({
        vessel: pair.container,
        scanned_files: 0,
        drifted_files: 0,
        container_missing: containerMissing,
        host_missing: hostMissing,
        sample_drifted: [],
      });
      continue;
    }

    const files = await walkTs(containerSrc, maxFiles);
    let scanned = 0;
    let drifted = 0;
    const sample: string[] = [];
    for (const containerPath of files) {
      const rel = containerPath.slice(containerSrc.length + 1);
      const hostPath = join(hostSrc, rel);
      const [ch, hh] = await Promise.all([hashFile(containerPath), hashFile(hostPath)]);
      if (ch === null && hh === null) continue;
      scanned += 1;
      if (ch !== hh) {
        drifted += 1;
        if (sample.length < sampleLimit) sample.push(`${pair.container}/src/${rel}`);
      }
    }
    perVessel.push({
      vessel: pair.container,
      scanned_files: scanned,
      drifted_files: drifted,
      container_missing: false,
      host_missing: false,
      sample_drifted: sample,
    });
    totalScanned += scanned;
    totalDrifted += drifted;
    for (const s of sample) {
      if (allDriftedSample.length < sampleLimit) allDriftedSample.push(s);
    }
  }

  return {
    shape: "hostContainerSourceDriftState",
    body: {
      host_repo_root: hostRoot,
      container_vessels_root: containerRoot,
      vessels_checked: perVessel.length,
      total_scanned: totalScanned,
      total_drifted: totalDrifted,
      drift_present: totalDrifted > 0,
      sample_drifted_files: allDriftedSample,
      per_vessel: perVessel,
      generated_at: new Date().toISOString(),
    },
  };
}
