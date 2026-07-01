import type { ResolverResult } from "./types.js";

const DEV_VESSEL_URL =
  process.env["DEV_VESSEL_IMPULSES_URL"] ?? "http://127.0.0.1:8090/v2/impulses/resolve";
const METABOB_API_KEY = process.env["METABOB_API_KEY"] ?? "";
const WORKSPACE_ROOT = process.env["WORKSPACE_ROOT"] ?? process.cwd();

interface Pointer {
  type: string;
  target_file?: string;
  vessel_id?: string;
  [key: string]: unknown;
}

interface FsReadResult {
  shape: string;
  body: any;
}

interface ConceptSearchResult {
  shape: string;
  body: any;
}

async function resolveImpulse(pointer: Record<string, unknown>): Promise<any> {
  const res = await fetch(DEV_VESSEL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {}),
    },
    body: JSON.stringify(pointer),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`impulse resolve ${res.status}: ${text}`);
  }
  return (await res.json()) as any;
}

function scoreTypeAnnotations(source: string): { score: number; detail: string } {
  const lines = source.split("\n");
  const totalLines = lines.length;
  if (totalLines === 0) return { score: 0, detail: "empty file" };

  const exportLines = lines.filter((l) => /^export/.test(l.trim()));
  const typedExports = exportLines.filter((l) => /:\s*\w/.test(l) || /as const/.test(l));
  const typeAnnotationFraction =
    exportLines.length > 0 ? typedExports.length / exportLines.length : 1;

  const hasExplicitAny = (source.match(/:\s*any/g) ?? []).length;
  const hasTsIgnore = (source.match(/@ts-ignore/g) ?? []).length;
  const hasNonNull = (source.match(/!/g) ?? []).length;

  const penaltyAny = Math.min(hasExplicitAny * 5, 20);
  const penaltyIgnore = Math.min(hasTsIgnore * 10, 20);
  const penaltyNonNull = Math.min(hasNonNull * 2, 10);

  const base = Math.round(typeAnnotationFraction * 60);
  const score = Math.max(0, Math.min(100, base + 40 - penaltyAny - penaltyIgnore - penaltyNonNull));

  return {
    score,
    detail: `exports=${exportLines.length} typed=${typedExports.length} any=${hasExplicitAny} ts-ignore=${hasTsIgnore} non-null-asserts=${hasNonNull}`,
  };
}

function scoreNamingConventions(source: string): { score: number; detail: string } {
  const constMatches = source.match(/^export const (\w+)/gm) ?? [];
  const camelOrUpperConsts = constMatches.filter((m) => {
    const name = m.replace("export const ", "");
    return /^[A-Z_][A-Z0-9_]*$/.test(name) || /^[a-z][a-zA-Z0-9]*$/.test(name);
  });
  const fraction =
    constMatches.length > 0 ? camelOrUpperConsts.length / constMatches.length : 1;
  const score = Math.round(fraction * 100);
  return {
    score,
    detail: `consts=${constMatches.length} well-named=${camelOrUpperConsts.length}`,
  };
}

function scoreMagicValues(source: string): { score: number; detail: string } {
  // Magic numbers: bare numeric literals not in env-default patterns
  const magicNumbers = (source.match(/(?<!parseInt\([^)]*)[,\s=]\d{3,}(?![\w"])/g) ?? []).length;
  const penalty = Math.min(magicNumbers * 5, 40);
  const score = Math.max(0, 100 - penalty);
  return { score, detail: `magic-number-candidates=${magicNumbers}` };
}

function scoreDocumentation(source: string): { score: number; detail: string } {
  const lines = source.split("\n");
  const commentLines = lines.filter((l) => /^\s*(\/\/|\/\*|\*)/.test(l)).length;
  const totalLines = lines.length;
  const fraction = totalLines > 0 ? commentLines / totalLines : 0;
  // Ideal: ~15-30% comment lines. Below 5% is poor, above 50% may be over-commented.
  const normalised = Math.min(fraction / 0.2, 1);
  const score = Math.round(normalised * 100);
  return { score, detail: `comment_lines=${commentLines} total_lines=${totalLines} fraction=${fraction.toFixed(2)}` };
}

function scoreModuleSize(source: string): { score: number; detail: string } {
  const lineCount = source.split("\n").length;
  // > 300 lines starts losing points; > 600 is poor
  const score = lineCount <= 150 ? 100 : lineCount <= 300 ? 80 : lineCount <= 500 ? 60 : lineCount <= 700 ? 40 : 20;
  return { score, detail: `line_count=${lineCount}` };
}

export async function resolveAssessmentSummary(pointer: Pointer): Promise<ResolverResult> {
  const targetFile =
    (pointer.target_file as string | undefined) ??
    `${WORKSPACE_ROOT}/repos/clock-vessel/src/config.ts`;

  // 1. Read the target file via fs_read impulse
  let sourceCode = "";
  let readError: string | null = null;
  try {
    const fsResult = (await resolveImpulse({
      type: "fs_read",
      path: targetFile,
    })) as FsReadResult;
    const fsBody = fsResult?.body as any;
    sourceCode = (fsBody?.content as string | undefined) ??
      (fsBody?.text as string | undefined) ??
      (typeof fsBody === "string" ? fsBody : "");
  } catch (err) {
    readError = err instanceof Error ? err.message : String(err);
  }

  // 2. Attempt to fetch related concepts for the target file from concept-db
  let conceptCount = 0;
  let conceptSample: string[] = [];
  try {
    const conceptResult = (await resolveImpulse({
      type: "concept_search_by_source",
      source_path: targetFile,
      limit: 10,
    })) as ConceptSearchResult;
    const cBody = conceptResult?.body as any;
    const concepts: any[] = Array.isArray(cBody?.concepts) ? cBody.concepts : [];
    conceptCount = concepts.length;
    conceptSample = concepts.slice(0, 5).map((c: any) => {
      const t = (c?.title as string | undefined) ?? (c?.id as string | undefined) ?? "unknown";
      return t;
    });
  } catch {
    // concept-db may be unavailable — non-fatal
  }

  // 3. Attempt to get git log for recency signal
  let lastCommitAge = "unknown";
  let commitCount = 0;
  try {
    const gitResult = (await resolveImpulse({
      type: "git_log",
      path: targetFile,
      limit: 5,
    })) as any;
    const gBody = gitResult?.body as any;
    const commits: any[] = Array.isArray(gBody?.commits) ? gBody.commits : [];
    commitCount = commits.length;
    const latestCommit = commits[0];
    const latestDate = (latestCommit?.date as string | undefined) ??
      (latestCommit?.timestamp as string | undefined);
    if (latestDate) {
      lastCommitAge = latestDate;
    }
  } catch {
    // git may not be available — non-fatal
  }

  // 4. Compute quality metrics from source
  const hasSource = sourceCode.length > 0;

  const typeAnnotations = hasSource ? scoreTypeAnnotations(sourceCode) : { score: 0, detail: "no source" };
  const namingConventions = hasSource ? scoreNamingConventions(sourceCode) : { score: 0, detail: "no source" };
  const magicValues = hasSource ? scoreMagicValues(sourceCode) : { score: 0, detail: "no source" };
  const documentation = hasSource ? scoreDocumentation(sourceCode) : { score: 0, detail: "no source" };
  const moduleSize = hasSource ? scoreModuleSize(sourceCode) : { score: 0, detail: "no source" };

  const overallScore = hasSource
    ? Math.round(
        (typeAnnotations.score * 0.3 +
          namingConventions.score * 0.2 +
          magicValues.score * 0.15 +
          documentation.score * 0.2 +
          moduleSize.score * 0.15),
      )
    : 0;

  const grade =
    overallScore >= 90 ? "A" :
    overallScore >= 80 ? "B" :
    overallScore >= 70 ? "C" :
    overallScore >= 60 ? "D" : "F";

  // 5. Structural analysis: count exports, imports, env reads
  const exportCount = hasSource ? (sourceCode.match(/^export /gm) ?? []).length : 0;
  const importCount = hasSource ? (sourceCode.match(/^import /gm) ?? []).length : 0;
  const envReads = hasSource ? (sourceCode.match(/process\.env\[/g) ?? []).length : 0;
  const hasDefaultExport = hasSource && /export default/.test(sourceCode);
  const hasTypeExports = hasSource && /export type /.test(sourceCode);

  // 6. Identify issues
  const issues: string[] = [];
  if (!hasSource) {
    issues.push(`Could not read target file: ${readError ?? "unknown error"}`);
  }
  if (typeAnnotations.score < 60) {
    issues.push(`Low type annotation coverage (score=${typeAnnotations.score}): ${typeAnnotations.detail}`);
  }
  if (namingConventions.score < 70) {
    issues.push(`Naming convention violations (score=${namingConventions.score}): ${namingConventions.detail}`);
  }
  if (magicValues.score < 70) {
    issues.push(`Magic values detected (score=${magicValues.score}): ${magicValues.detail}`);
  }
  if (documentation.score < 40) {
    issues.push(`Low documentation density (score=${documentation.score}): ${documentation.detail}`);
  }
  if (moduleSize.score < 60) {
    issues.push(`Module size concern (score=${moduleSize.score}): ${moduleSize.detail}`);
  }

  return {
    shape: "assessment_summary",
    body: {
      target_file: targetFile,
      overall_score: overallScore,
      grade,
      metrics: {
        type_annotations: typeAnnotations,
        naming_conventions: namingConventions,
        magic_values: magicValues,
        documentation,
        module_size: moduleSize,
      },
      structural: {
        export_count: exportCount,
        import_count: importCount,
        env_reads: envReads,
        has_default_export: hasDefaultExport,
        has_type_exports: hasTypeExports,
        line_count: hasSource ? sourceCode.split("\n").length : 0,
      },
      provenance: {
        concept_count: conceptCount,
        concept_sample: conceptSample,
        last_commit_date: lastCommitAge,
        recent_commit_count: commitCount,
        read_error: readError,
      },
      issues,
      summary: hasSource
        ? `${targetFile} scores ${overallScore}/100 (grade ${grade}). ` +
          `Exports: ${exportCount}, env-reads: ${envReads}. ` +
          (issues.length > 0 ? `Issues: ${issues.join("; ")}.` : "No major issues detected.")
        : `Assessment failed: could not read ${targetFile}. ${readError ?? ""}`,
    },
  };
}
