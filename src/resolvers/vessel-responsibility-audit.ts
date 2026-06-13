import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ResolverResult } from "./types.js";

/**
 * vessel_responsibility_audit — horizon-detector (vessel horizon).
 *
 * Stage 1.A of openspec change
 *   2026-06-03-pre-lift-bootstrap-and-architecture-aware-loop
 *
 * Scans vessel source trees (repos/<vessel>/src/**.ts) against the
 * architectural principles stored in concept-db with
 *   source_type = "architectural_pattern_principle"
 * Each principle whose metadata carries `severity: "structural"` and a
 * `check_hints` array drives a deterministic regex check across the
 * vessel's source. Violations emit substrateGap impulses + appear in the
 * returned report.
 *
 * Immunity-pattern compliant: empty inputShapes (template-level), single
 * resolver, no LLM, no iteration over impulse pool. The detector itself
 * cannot be preflight-rejected by the binding layer.
 *
 * Critical empirical target: when the "Backend = trace store, not universal
 * resolver" principle is seeded (severity=structural, target_vessel=
 * goal-host-vessel, forbidden_pattern_regex matching the template-catalogue
 * fetch + LLM-reuse), running this detector against goal-host-vessel emits
 * a `responsibility_misallocation` substrateGap citing that principle.
 */

const DEFAULT_CONCEPT_DB_URL = "http://127.0.0.1:8260/concepts/search";
const DEFAULT_DEV_VESSEL_URL = "http://127.0.0.1:8090/v2/impulses/resolve";

export interface VesselResponsibilityAuditPointer {
  type: "vessel_responsibility_audit";
  /** Restrict scan to one vessel name (e.g. "goal-host-vessel"). Default: scan all. */
  vessel_name?: string;
  /** Override scan root. Default: WORKSPACE_ROOT env or /vessels (substrate container). */
  workspaceRoot?: string;
  conceptDbUrl?: string;
  devVesselImpulsesUrl?: string;
  /** Cap on vessels scanned. Default 20. */
  vesselScanCap?: number;
  /** Cap on files scanned per vessel. Default 60. */
  filesPerVessel?: number;
  /** Cap on substrateGap emissions per detector run. Default 5. */
  emitCap?: number;
  dry_run?: boolean;
}

interface PrincipleMetadata {
  severity?: string;
  check_hints?: Array<{
    target_vessel?: string;
    forbidden_pattern_regex?: string;
    detail?: string;
  }>;
  principle_name?: string;
}

interface PrincipleConcept {
  id: string;
  name?: string;
  summary?: string;
  content?: string;
  /** Top-level metadata field (when concept-db surfaces it). */
  metadata?: PrincipleMetadata;
  /** Concept-db actually stores metadata inside pointer.metadata. */
  pointer?: {
    metadata?: PrincipleMetadata;
  };
}

function principleMetadata(p: PrincipleConcept): PrincipleMetadata {
  if (p.metadata && typeof p.metadata === "object") return p.metadata;
  if (p.pointer && p.pointer.metadata && typeof p.pointer.metadata === "object") {
    return p.pointer.metadata;
  }
  return {};
}

interface ConceptSearchResponse {
  concepts?: PrincipleConcept[];
}

interface Violation {
  vessel: string;
  file_path: string;
  principle_id: string;
  principle_name: string;
  matched_pattern: string;
  matched_excerpt: string;
  detail: string;
  gap_id: string;
  emitted: boolean;
  emit_status?: number | "error" | "skipped";
}

async function fetchPrinciples(
  conceptDbUrl: string,
  apiKey: string,
): Promise<PrincipleConcept[]> {
  const url = `${conceptDbUrl}?source_type=architectural_pattern_principle&limit=100`;
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) return [];
  const json = (await resp.json()) as ConceptSearchResponse;
  return Array.isArray(json.concepts) ? json.concepts : [];
}

/**
 * Best-effort metadata extraction. concept-db's GET /concepts/search response
 * may omit the metadata field on some deployments; in that case we fall back
 * to parsing the content/summary for a JSON-shaped metadata block.
 *
 * The seed script also embeds the signature into content text, but the
 * check_hints (regex + target_vessel + detail) are only in metadata. If
 * metadata isn't returned, the principle is "advisory-only" for this run.
 */
function getCheckHints(p: PrincipleConcept): Array<{
  target_vessel?: string;
  forbidden_pattern_regex?: string;
  detail?: string;
}> {
  const md = principleMetadata(p);
  if (Array.isArray(md.check_hints)) return md.check_hints;
  return [];
}

function severityOf(p: PrincipleConcept): string {
  return principleMetadata(p).severity ?? "advisory";
}

function principleName(p: PrincipleConcept): string {
  return principleMetadata(p).principle_name ?? p.name ?? p.id;
}

interface VesselScanResult {
  /** Vessel dirs to scan (capped). */
  vessels: string[];
  /** Total real vessel dirs found (after excluding mitosis stages), pre-cap. */
  total: number;
  /** True when total > cap, i.e. the scan did NOT cover every real vessel. */
  cap_hit: boolean;
  /** Count of `*-mitosis-*` staging dirs excluded from the scan. */
  mitosis_excluded: number;
}

async function listVesselDirs(workspaceRoot: string, cap: number): Promise<VesselScanResult> {
  // Two possible roots: /vessels (substrate container) or <workspaceRoot>/repos.
  // The container path takes priority when it exists.
  const candidates = ["/vessels", join(workspaceRoot, "repos")];
  for (const root of candidates) {
    try {
      const st = await stat(root);
      if (!st.isDirectory()) continue;
      const entries = await readdir(root, { withFileTypes: true });
      // Exclude abandoned mitosis staging dirs (`<vessel>-mitosis-<ISO>`): they
      // are not real vessels, and at scale (245/263 observed 2026-06-13) they
      // swamp the cap and silently starve the scan of every real vessel. Sort
      // so coverage is deterministic, not readdir-order-dependent.
      const realDirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name);
      const mitosisExcluded = realDirs.filter((n) => /-mitosis-/.test(n)).length;
      const vesselNames = realDirs.filter((n) => !/-mitosis-/.test(n)).sort();
      if (vesselNames.length === 0) continue;
      return {
        vessels: vesselNames.slice(0, cap).map((n) => join(root, n)),
        total: vesselNames.length,
        cap_hit: vesselNames.length > cap,
        mitosis_excluded: mitosisExcluded,
      };
    } catch {
      // try next candidate
    }
  }
  return { vessels: [], total: 0, cap_hit: false, mitosis_excluded: 0 };
}

async function listSourceFiles(vesselDir: string, cap: number): Promise<string[]> {
  const srcDir = join(vesselDir, "src");
  try {
    const st = await stat(srcDir);
    if (!st.isDirectory()) return [];
  } catch {
    return [];
  }
  // Shallow + one-level deep walk (substrate vessels keep almost everything
  // in src/ or src/<subdir>/). Cheap and bounded.
  const collected: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (collected.length >= cap) return;
    if (depth > 2) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (collected.length >= cap) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
        await walk(p, depth + 1);
      } else if (e.isFile() && (p.endsWith(".ts") || p.endsWith(".tsx"))) {
        collected.push(p);
      }
    }
  }
  await walk(srcDir, 0);
  return collected;
}

function vesselNameOf(vesselDir: string): string {
  return vesselDir.split("/").pop() ?? vesselDir;
}

async function emitGap(
  emitUrl: string,
  apiKey: string,
  violation: Violation,
): Promise<void> {
  const body = {
    impulse: {
      pointer: {
        type: "substrateGap_write",
        gap: {
          id: violation.gap_id,
          category: "responsibility_misallocation",
          source: "substrate_detected",
          summary:
            `${violation.vessel}: source pattern matches principle '` +
            `${violation.principle_name}' — ${violation.detail}`,
          detected_at: new Date().toISOString(),
          status: "open",
          classification_metadata: {
            detector: "vessel_responsibility_audit",
            vessel: violation.vessel,
            file_path: violation.file_path,
            principle_id: violation.principle_id,
            principle_name: violation.principle_name,
            matched_pattern: violation.matched_pattern,
            matched_excerpt: violation.matched_excerpt.slice(0, 280),
          },
        },
      },
    },
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
  const resp = await fetch(emitUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  violation.emit_status = resp.status;
  violation.emitted = resp.ok;
}

export async function resolveVesselResponsibilityAudit(
  pointer: VesselResponsibilityAuditPointer,
): Promise<ResolverResult> {
  const conceptDbUrl = pointer.conceptDbUrl ?? DEFAULT_CONCEPT_DB_URL;
  const emitUrl = pointer.devVesselImpulsesUrl ?? DEFAULT_DEV_VESSEL_URL;
  const workspaceRoot = pointer.workspaceRoot ?? process.env["WORKSPACE_ROOT"] ?? "/workspace";
  const vesselScanCap = pointer.vesselScanCap ?? 20;
  const filesPerVessel = pointer.filesPerVessel ?? 60;
  const emitCap = pointer.emitCap ?? 5;
  const dryRun = pointer.dry_run === true;
  const apiKey = process.env["METABOB_API_KEY"] ?? "";

  // 1. Pull principles.
  let principles: PrincipleConcept[] = [];
  let fetchError: string | null = null;
  try {
    principles = await fetchPrinciples(conceptDbUrl, apiKey);
  } catch (err) {
    fetchError = (err as Error).message;
  }
  const structuralPrinciples = principles.filter(
    (p) => severityOf(p) === "structural" && getCheckHints(p).length > 0,
  );

  // 2. List vessels.
  const scan = await listVesselDirs(workspaceRoot, vesselScanCap);
  const filtered = pointer.vessel_name
    ? scan.vessels.filter((d) => vesselNameOf(d) === pointer.vessel_name)
    : scan.vessels;

  // 3. For each vessel × principle × check_hint, scan files for forbidden regex.
  const violations: Violation[] = [];
  for (const vesselDir of filtered) {
    const vessel = vesselNameOf(vesselDir);
    const files = await listSourceFiles(vesselDir, filesPerVessel);
    for (const principle of structuralPrinciples) {
      const hints = getCheckHints(principle);
      const pName = principleName(principle);
      for (const hint of hints) {
        if (hint.target_vessel && hint.target_vessel !== vessel) continue;
        if (!hint.forbidden_pattern_regex) continue;
        let regex: RegExp;
        try {
          regex = new RegExp(hint.forbidden_pattern_regex, "m");
        } catch {
          continue;
        }
        for (const filePath of files) {
          let content: string;
          try {
            content = await readFile(filePath, "utf-8");
          } catch {
            continue;
          }
          const match = regex.exec(content);
          if (!match) continue;
          const excerptStart = Math.max(0, match.index - 60);
          const excerptEnd = Math.min(content.length, match.index + 160);
          violations.push({
            vessel,
            file_path: filePath,
            principle_id: principle.id,
            principle_name: pName,
            matched_pattern: hint.forbidden_pattern_regex,
            matched_excerpt: content.slice(excerptStart, excerptEnd),
            detail: hint.detail ?? "violates principle",
            gap_id: `responsibility-${vessel}-${pName}-${Date.now()}`,
            emitted: false,
          });
          // One match per (vessel, principle, hint) suffices.
          break;
        }
        if (violations.length >= emitCap * 2) break;
      }
    }
  }

  // 4. Emit substrateGaps (capped).
  const toEmit = violations.slice(0, emitCap);
  if (!dryRun) {
    for (const v of toEmit) {
      try {
        await emitGap(emitUrl, apiKey, v);
      } catch (err) {
        v.emit_status = "error";
        v.emitted = false;
        (v as Violation & { emit_error?: string }).emit_error = (err as Error).message;
      }
    }
  } else {
    for (const v of toEmit) v.emit_status = "skipped";
  }

  return {
    shape: "vesselResponsibilityAudit",
    body: {
      vessels_scanned: filtered.length,
      // Coverage stats — make silent scan-truncation trace-inspectable.
      vessels_total: scan.total,
      vessel_scan_cap: vesselScanCap,
      cap_hit: scan.cap_hit,
      coverage_pct: scan.total > 0 ? Math.round((filtered.length / scan.total) * 100) : 100,
      mitosis_dirs_excluded: scan.mitosis_excluded,
      principles_fetched_total: principles.length,
      principles_consulted: structuralPrinciples.length,
      principles_with_check_hints: structuralPrinciples.length,
      total_violations: violations.length,
      emit_cap: emitCap,
      violations: violations.slice(0, 25),
      concept_db_url: conceptDbUrl,
      fetch_error: fetchError,
      dry_run: dryRun,
      completed_at: new Date().toISOString(),
    },
  };
}
