import { METABOB_ENDPOINT } from "../config.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveDocsAlignScan } from "./docs-align-scan.js";
import { resolveDocsAlignBridge } from "./docs-align-bridge.js";
import type { ResolverResult } from "./types.js";
import type { DocsAlignFinding } from "./docs-align-scan.js";

const DOC_ROOT = process.env.DOC_FIX_ROOT ?? "/workspace/git/super-repo";

interface DocsAlignTickPointer {
  type: "docs_align_tick";
  dry_run?: boolean;
  max_fixes?: number;
}

function walkMd(dir: string, cap: number): Array<{ id: string; source: string; body: string }> {
  const results: Array<{ id: string; source: string; body: string }> = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= cap) break;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "archive") continue;
        const sub = walkMd(full, cap - results.length);
        results.push(...sub);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          const st = statSync(full);
          if (st.size > 200000) continue;
          const rel = relative(DOC_ROOT, full);
          const body = readFileSync(full, "utf8");
          results.push({ id: rel, source: rel, body });
        } catch {
          // skip unreadable file
        }
      }
    }
  } catch {
    // skip unreadable dir
  }
  return results;
}

async function deriveNamingVocabulary(
  documents: Array<{ id: string; source: string; body: string }>,
): Promise<{ deprecated: Array<{ pattern: string; canonical: string; path_only?: boolean }>; retained: string[] }> {
  try {
    let projectName = "substrate";
    try {
      const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { cwd: DOC_ROOT, stdout: "pipe" });
      const out = await new Response(proc.stdout).text();
      const trimmed = out.trim();
      if (trimmed.length > 0) {
        const parts = trimmed.split("/");
        const last = parts[parts.length - 1];
        if (last && last.length > 0) projectName = last;
      }
    } catch {
      // git absent
    }

    const tokenRe = /metabob-[a-z0-9]+(?:-[a-z0-9]+)*/gi;
    const tokens = new Set<string>();

    try {
      const proc = Bun.spawn(["git", "log", "--oneline", "-n", "500"], { cwd: DOC_ROOT, stdout: "pipe" });
      const out = await new Response(proc.stdout).text();
      const matches = out.match(tokenRe);
      if (matches) for (const m of matches) tokens.add(m.toLowerCase());
    } catch {
      // ignore
    }

    try {
      const combined = documents.map((d) => d.body).join("\n");
      const matches = combined.match(tokenRe);
      if (matches) for (const m of matches) tokens.add(m.toLowerCase());
    } catch {
      // ignore
    }

    try {
      const res = await fetch(`${METABOB_ENDPOINT}/v2/impulses/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ impulse: { type: "memoryNote", limit: 100 } }),
      });
      const j = (await res.json()) as unknown;
      const text = JSON.stringify(j);
      const matches = text.match(tokenRe);
      if (matches) for (const m of matches) tokens.add(m.toLowerCase());
    } catch {
      // ignore
    }

    const deprecated: Array<{ pattern: string; canonical: string; path_only?: boolean }> = [];
    for (const token of tokens) {
      const x = token.slice("metabob-".length);
      const canonical = x === "devbob" ? projectName : x;
      if (canonical === token) continue;
      deprecated.push({ pattern: token, canonical, path_only: x !== "devbob" });
    }
    return { deprecated, retained: [] };
  } catch {
    return { deprecated: [], retained: [] };
  }
}


function walkScripts(dir: string, cap: number): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= cap) break;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = walkScripts(full, cap - results.length);
        results.push(...sub);
      } else if (entry.isFile()) {
        const rel = relative(DOC_ROOT, full);
        if (rel.startsWith("scripts/")) results.push(rel);
      }
    }
  } catch {
    // skip unreadable dir
  }
  return results;
}

function isDocsAlignFinding(v: unknown): v is DocsAlignFinding {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["doc_id"] === "string" &&
    typeof r["invariant"] === "string" &&
    typeof r["evidence"] === "string" &&
    typeof r["suggested_repair"] === "string"
  );
}

export async function resolveDocsAlignTick(
  pointer: DocsAlignTickPointer,
): Promise<ResolverResult> {
  // 1. Enumerate human-facing docs
  const documents: Array<{ id: string; source: string; body: string }> = [];

  for (const name of ["CLAUDE.md", "README.md"]) {
    try {
      const full = join(DOC_ROOT, name);
      const st = statSync(full);
      if (st.size <= 200000) {
        const body = readFileSync(full, "utf8");
        documents.push({ id: name, source: name, body });
      }
    } catch {
      // file absent or unreadable — skip
    }
  }

  const docsDir = join(DOC_ROOT, "docs");
  const mdFiles = walkMd(docsDir, 80 - documents.length);
  documents.push(...mdFiles);

  // 2. Assemble live_truth from local filesystem only
  const scriptsDir = join(DOC_ROOT, "scripts");
  const existing_paths = walkScripts(scriptsDir, 2000);

  let unit_names: string[] = [];
  try {
    const unitsDir = join(DOC_ROOT, "scripts/substrate/units");
    unit_names = readdirSync(unitsDir).filter((e) => e.endsWith(".service"));
  } catch {
    unit_names = [];
  }

  // 3. Run docs_align_scan
  const vocabulary = await deriveNamingVocabulary(documents);
  let advertised_shapes: string[] = [];
  try {
    const base = (process.env["DISCOVERY_ENDPOINT"] ?? "http://127.0.0.1:8100").replace(/\/+$/, "");
    const res = await fetch(`${base}/registry/shapes`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const j = (await res.json()) as unknown;
      const arr = Array.isArray(j)
        ? j
        : Array.isArray((j as { shapes?: unknown })?.shapes)
          ? (j as { shapes: unknown[] }).shapes
          : [];
      advertised_shapes = arr.filter((s): s is string => typeof s === "string");
    }
  } catch {
    advertised_shapes = [];
  }
  const scan = await resolveDocsAlignScan({
    type: "docs_align_scan",
    corpus: { documents },
    live_truth: { existing_paths, unit_names, advertised_shapes },
    invariants: ["timelessness", "naming_alignment", "setup_enablement", "accuracy"],
    vocabulary,
    max_findings: 100,
  });

  // 4. Narrow scan body findings to a typed array
  const rawScanBody = scan.body as Record<string, unknown>;
  const rawFindings = rawScanBody["findings"];
  const findingsArray: DocsAlignFinding[] = Array.isArray(rawFindings)
    ? rawFindings.filter(isDocsAlignFinding)
    : [];

  // 5. Run docs_align_bridge
  const fixLimit = typeof pointer.max_fixes === "number" ? pointer.max_fixes : findingsArray.length;
  const bridge = await resolveDocsAlignBridge({
    type: "docs_align_bridge",
    report: { findings: findingsArray.slice(0, fixLimit) },
    dry_run: pointer.dry_run,
  });

  // 6. Return summary
  const rawBridgeBody = bridge.body as Record<string, unknown>;
  return {
    shape: "docsAlignTickReport",
    body: {
      docs_scanned: documents.length,
      findings: findingsArray.length,
      gaps_emitted:
        typeof rawBridgeBody["gaps_emitted"] === "number"
          ? rawBridgeBody["gaps_emitted"]
          : 0,
      sources: Array.isArray(rawBridgeBody["sources"])
        ? (rawBridgeBody["sources"] as string[])
        : [],
      dry_run: pointer.dry_run ?? false,
    },
  };
}