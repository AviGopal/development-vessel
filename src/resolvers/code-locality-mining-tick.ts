import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ResolverResult } from "./types.js";

export interface CodeLocalityMiningTickPointer {
  type: "code_locality_mining_tick";
  proposalsDir?: string;
  indexPath?: string;
  dry_run?: boolean;
}

interface SpanEntry {
  start_line: number;
  end_line: number;
  count: number;
}

interface FileEntry {
  edit_count: number;
  spans: SpanEntry[];
}

interface FamilyEntry {
  report_count: number;
  files: Record<string, FileEntry>;
}

interface LocalityIndex {
  version: 1;
  generated_at: string;
  total_reports_scanned: number;
  favorable_reports: number;
  families: Record<string, FamilyEntry>;
}

export async function resolveCodeLocalityMiningTick(
  pointer: CodeLocalityMiningTickPointer,
): Promise<ResolverResult> {
  const proposalsDir =
    pointer.proposalsDir ??
    process.env["PROPOSALS_DIR"] ??
    "/workspace/proposals";
  const indexPath =
    pointer.indexPath ?? "/workspace/locality/code-locality-index.json";

  // (a) list files ending in "-compose-report.json"
  let files: string[] = [];
  try {
    const entries = readdirSync(proposalsDir);
    files = entries.filter((f) => f.endsWith("-compose-report.json"));
  } catch {
    // directory may not exist yet — treat as zero reports
    files = [];
  }

  let total_reports_scanned = 0;
  let favorable_reports = 0;
  const families: Record<string, FamilyEntry> = {};

  for (const filename of files) {
    let parsed: unknown;
    try {
      const raw = readFileSync(`${proposalsDir}/${filename}`, "utf8");
      parsed = JSON.parse(raw);
      total_reports_scanned += 1;
    } catch {
      // (a) one bad file never fails the tick
      continue;
    }

    // (b) keep only reports whose parsed.ok === true
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as Record<string, unknown>)["ok"] !== true
    ) {
      continue;
    }
    favorable_reports += 1;

    // (c) derive family key from filename
    const stem = filename.slice(0, filename.length - "-compose-report.json".length);
    const hashMatch = /^route-edit-([0-9a-f]+)$/.exec(stem);
    const family = hashMatch !== null ? `goal:${hashMatch[1]}` : `gap:${stem}`;

    // ensure family entry exists
    if (!families[family]) {
      families[family] = { report_count: 0, files: {} };
    }
    const familyEntry = families[family] as FamilyEntry;
    familyEntry.report_count += 1;

    // (d) iterate parsed.applied
    const parsedObj = parsed as Record<string, unknown>;
    const applied = parsedObj["applied"];
    if (!Array.isArray(applied)) {
      continue;
    }

    for (const entry of applied) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (e["ok"] !== true) continue;

      const span = e["span"];
      const path = e["path"];
      if (typeof path !== "string") continue;
      if (
        typeof span !== "object" ||
        span === null ||
        typeof (span as Record<string, unknown>)["start_line"] !== "number" ||
        typeof (span as Record<string, unknown>)["end_line"] !== "number"
      ) {
        continue;
      }

      const spanObj = span as Record<string, unknown>;
      const start_line = spanObj["start_line"] as number;
      const end_line = spanObj["end_line"] as number;

      if (!familyEntry.files[path]) {
        familyEntry.files[path] = { edit_count: 0, spans: [] };
      }
      const fileEntry = familyEntry.files[path] as FileEntry;
      fileEntry.edit_count += 1;

      // deduplicate spans by "${start_line}-${end_line}"
      const spanKey = `${start_line}-${end_line}`;
      const existingSpan = fileEntry.spans.find(
        (s) => `${s.start_line}-${s.end_line}` === spanKey,
      );
      if (existingSpan) {
        existingSpan.count += 1;
      } else {
        fileEntry.spans.push({ start_line, end_line, count: 1 });
      }
    }
  }

  // (e) build index
  const index: LocalityIndex = {
    version: 1,
    generated_at: new Date().toISOString(),
    total_reports_scanned,
    favorable_reports,
    families,
  };

  // (f) write unless dry_run
  if (pointer.dry_run !== true) {
    try {
      mkdirSync(dirname(indexPath), { recursive: true });
      writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf8");
    } catch {
      // never fails the tick
    }
  }

  // (g) build result
  const family_count = Object.keys(families).length;
  const families_summary = Object.entries(families).map(([fam, fe]) => ({
    family: fam,
    report_count: fe.report_count,
    file_count: Object.keys(fe.files).length,
  }));

  return {
    shape: "codeLocalityIndex",
    body: {
      scanned: true,
      total_reports_scanned,
      favorable_reports,
      family_count,
      index_path: indexPath,
      dry_run: pointer.dry_run === true,
      families_summary,
      completed_at: new Date().toISOString(),
    },
  };
}
