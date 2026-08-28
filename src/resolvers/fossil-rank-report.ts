export interface FossilRankReportPointer {
  fileLineCounts?: Record<string, number>;
  recentFailuresByFile?: Record<string, number>;
  spliceCeiling?: number;
}

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

export interface FossilRankReportResult {
  shape: 'fossilRankReport';
  body: { fossils: Array<{ file: string; weight: number }>; ceiling: number };
}

export async function resolveFossilRankReport(pointer: FossilRankReportPointer): Promise<FossilRankReportResult> {
  const ceiling = pointer.spliceCeiling ?? 2000;
  const fileLineCounts = pointer.fileLineCounts ?? {};
  const recentFailuresByFile = pointer.recentFailuresByFile ?? {};
  const fossils: Array<{ file: string; weight: number }> = [];
  for (const file of Object.keys(fileLineCounts)) {
    const lines = fileLineCounts[file] ?? 0;
    if (lines > ceiling) {
      const failures = recentFailuresByFile[file] ?? 0;
      const weight = (Math.max(0, lines - ceiling) / ceiling) * (1 + failures);
      fossils.push({ file, weight });
    }
  }
  fossils.sort((a, b) => b.weight - a.weight);
  return { shape: 'fossilRankReport', body: { fossils, ceiling } };
}
