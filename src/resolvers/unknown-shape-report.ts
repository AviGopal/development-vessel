import { METABOB_ENDPOINT, METABOB_API_KEY, WORKSPACE_ROOT } from "../config.js";
import type { ResolverResult } from "./types.js";
import { readdir, readFile } from "node:fs/promises";
import { join, extname } from "node:path";

export interface UnknownShapeReportPointer {
  type: "unknown_shape_report";
  scan_dirs?: string[];  // relative to WORKSPACE_ROOT; defaults to ["openspec", "docs", "validation"]
}

interface Template {
  id: string;
  output_shapes?: string[];
  input_shapes?: string[];
}

// Scan a directory tree for files, returning paths relative to WORKSPACE_ROOT.
async function collectFiles(dir: string, exts: Set<string>): Promise<string[]> {
  const results: string[] = [];
  let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[] = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
      results.push(...(await collectFiles(full, exts)));
    } else if (entry.isFile() && exts.has(extname(entry.name))) {
      results.push(full);
    }
  }
  return results;
}

// Extract candidate shape names from text: PascalCase identifiers that
// appear in contexts suggesting they are shape names (near "shape", "impulse",
// "produces", "output", "input", or standalone ALL_CAPS_WITH_UNDERSCORE).
// Returns an array of { name, context } pairs.
function extractShapeReferences(text: string, filePath: string): string[] {
  const found = new Set<string>();

  // Pattern 1: quoted strings that look like shape names in YAML/JSON/TS
  // e.g. "output_shapes": ["learnedTopologySnapshot"], type: "coverage_tick"
  const quotedPattern = /["']([a-z][a-zA-Z0-9]+(?:[A-Z][a-zA-Z0-9]+)+)["']/g;
  for (const m of text.matchAll(quotedPattern)) {
    const candidate = m[1] ?? "";
    // camelCase with at least one uppercase letter after the first char = shape candidate
    if (candidate && /[A-Z]/.test(candidate)) found.add(candidate);
  }

  // Pattern 2: markdown backtick references like `coverageReport` or `learnedTopologySnapshot`
  const backtickPattern = /`([a-z][a-zA-Z0-9]+(?:[A-Z][a-zA-Z0-9]+)+)`/g;
  for (const m of text.matchAll(backtickPattern)) {
    if (m[1]) found.add(m[1]);
  }

  // Pattern 3: explicit shape: "..." or shape: `...` patterns
  const shapePattern = /shape['":\s]+([a-z][a-zA-Z0-9]+(?:[A-Z][a-zA-Z0-9]+)+)/g;
  for (const m of text.matchAll(shapePattern)) {
    if (m[1]) found.add(m[1]);
  }

  // Filter out common non-shape camelCase words (TypeScript/JS keywords, common terms)
  const excluded = new Set([
    "toString", "valueOf", "hasOwnProperty", "constructor", "prototype",
    "undefined", "typeScript", "javaScript", "gitHub", "youTube",
    "forEach", "indexOf", "startsWith", "endsWith", "includes", "findIndex",
    "parseInt", "parseFloat", "encodeURIComponent", "decodeURIComponent",
    "setTimeout", "setInterval", "clearTimeout", "clearInterval",
    "readFile", "readdir", "writeFile", "mkdirp",
    "fromEntries", "groupBy", "flatMap", "findLast",
  ]);

  return [...found].filter(s => !excluded.has(s));
}

export async function resolveUnknownShapeReport(
  pointer: UnknownShapeReportPointer,
): Promise<ResolverResult> {
  const auth = { Authorization: `ApiKey ${METABOB_API_KEY}` };

  // Fetch all advertised shapes from templates
  const templates: Template[] = [];
  let offset = 0;
  const pageSize = 100;
  while (templates.length < 500) {
    const r = await fetch(`${METABOB_ENDPOINT}/v2/activities/templates?limit=${pageSize}&offset=${offset}`, {
      headers: auth,
    });
    if (!r.ok) break;
    const page = await r.json() as { templates?: Template[] };
    const rows = page.templates ?? [];
    templates.push(...rows);
    offset += rows.length;
    if (rows.length < pageSize) break;
  }

  const advertisedShapes = new Set<string>();
  for (const tpl of templates) {
    for (const s of (tpl.output_shapes ?? [])) advertisedShapes.add(s);
    for (const s of (tpl.input_shapes ?? [])) advertisedShapes.add(s);
  }

  // Scan workspace files for shape references
  const scanDirs = pointer.scan_dirs ?? ["openspec", "docs", "validation"];
  const textExts = new Set([".md", ".ts", ".json", ".yaml", ".yml"]);

  const shapeMentions = new Map<string, { count: number; firstSeen: string; sampleSourceId: string }>();
  const sources: Array<{ source_type: "goal_text" | "proposal_draft" | "scenario"; source_id: string; shape_references: string[] }> = [];

  for (const dir of scanDirs) {
    const fullDir = join(WORKSPACE_ROOT, dir);
    const files = await collectFiles(fullDir, textExts);
    for (const filePath of files) {
      let text = "";
      try {
        text = await readFile(filePath, "utf-8");
      } catch {
        continue;
      }
      const refs = extractShapeReferences(text, filePath);
      if (refs.length === 0) continue;

      const relPath = filePath.replace(WORKSPACE_ROOT + "/", "");
      let sourceType: "goal_text" | "proposal_draft" | "scenario" = "proposal_draft";
      if (relPath.includes("goal") || relPath.includes("task")) sourceType = "goal_text";
      if (relPath.includes("scenario") || relPath.includes("harness")) sourceType = "scenario";

      sources.push({ source_type: sourceType, source_id: relPath, shape_references: refs });

      for (const s of refs) {
        if (!shapeMentions.has(s)) {
          shapeMentions.set(s, { count: 0, firstSeen: new Date().toISOString(), sampleSourceId: relPath });
        }
        shapeMentions.get(s)!.count++;
      }
    }
  }

  // Unknown = mentioned in docs/specs but not in any template's input/output_shapes
  const unknown_shapes = [...shapeMentions.entries()]
    .filter(([shape]) => !advertisedShapes.has(shape))
    .map(([shape, meta]) => ({
      shape,
      first_observed_at: meta.firstSeen,
      mention_count: meta.count,
      sample_source_id: meta.sampleSourceId,
    }))
    .sort((a, b) => b.mention_count - a.mention_count)
    .slice(0, 50); // cap at 50 to keep impulse body manageable

  return {
    shape: "unknownShapeReport",
    body: {
      generated_at: new Date().toISOString(),
      sources: sources.slice(0, 100),
      unknown_shapes,
      total: unknown_shapes.length,
    },
  };
}
