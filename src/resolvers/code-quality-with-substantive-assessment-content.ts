import type { ResolverResult } from "./types.js";

const DEV_VESSEL_URL =
  process.env["DEV_VESSEL_IMPULSES_URL"] ?? "http://127.0.0.1:8090/v2/impulses/resolve";
const API_KEY = process.env["METABOB_API_KEY"] ?? "";

const CLOCK_VESSEL_REPO = process.env["WORKSPACE_ROOT"] ?? process.cwd();

async function fetchJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<any>;
}

/**
 * Resolve: "code_quality with substantive assessment content"
 *
 * Reads the source code of clock-vessel via fs_list + fs_read impulses,
 * then sends it to the LLM for a substantive code quality assessment.
 */
export async function resolveCodeQualityWithSubstantiveAssessmentContent(
  pointer: Record<string, unknown>
): Promise<ResolverResult> {
  const clockVesselRoot = (pointer["vesselRoot"] as string | undefined) ?? `${CLOCK_VESSEL_REPO}/../clock-vessel`;

  // Step 1: list source files in clock-vessel
  let fileList: string[] = [];
  try {
    const listResult = await fetchJson(DEV_VESSEL_URL, {
      type: "fs_list",
      path: clockVesselRoot,
      recursive: true,
    });
    const rawPaths: unknown[] = Array.isArray(listResult?.body?.paths)
      ? (listResult.body.paths as unknown[])
      : Array.isArray(listResult?.body)
      ? (listResult.body as unknown[])
      : [];
    fileList = rawPaths
      .filter((p): p is string => typeof p === "string")
      .filter((p) => p.endsWith(".ts") && !p.includes("node_modules") && !p.includes(".d.ts"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      shape: "code_quality with substantive assessment content",
      body: {
        assessment: `Failed to list clock-vessel source files: ${msg}`,
        files_analyzed: 0,
        error: true,
      },
    };
  }

  if (fileList.length === 0) {
    return {
      shape: "code_quality with substantive assessment content",
      body: {
        assessment: "No TypeScript source files found in clock-vessel. Cannot produce code quality assessment.",
        files_analyzed: 0,
        error: true,
      },
    };
  }

  // Step 2: read up to 20 source files (cap to avoid prompt overflow)
  const filesToRead = fileList.slice(0, 20);
  const fileContents: Array<{ path: string; content: string }> = [];

  for (const filePath of filesToRead) {
    try {
      const readResult = await fetchJson(DEV_VESSEL_URL, {
        type: "fs_read",
        path: filePath,
      });
      const content: unknown = readResult?.body?.content ?? readResult?.body ?? "";
      fileContents.push({
        path: filePath,
        content: typeof content === "string" ? content : JSON.stringify(content),
      });
    } catch {
      // skip unreadable files
    }
  }

  if (fileContents.length === 0) {
    return {
      shape: "code_quality with substantive assessment content",
      body: {
        assessment: "Could not read any clock-vessel source files.",
        files_analyzed: 0,
        error: true,
      },
    };
  }

  // Step 3: build prompt for code quality assessment
  const codeBlock = fileContents
    .map((f) => `### ${f.path}\n\`\`\`typescript\n${f.content.slice(0, 4000)}\n\`\`\``)
    .join("\n\n");

  const prompt = `You are a senior software engineer performing a code quality review of clock-vessel, a Bun + TypeScript microservice.

Analyze the following source files and produce a SUBSTANTIVE code quality assessment. Cover:
1. Architecture and design patterns
2. TypeScript usage (type safety, strict mode compliance)
3. Error handling robustness
4. Code clarity and maintainability
5. Potential bugs or reliability issues
6. Specific actionable improvement suggestions

Be concrete — cite specific file names, function names, and line patterns.

${codeBlock}

Provide a structured assessment with an overall quality score (1-10) and per-category findings.`;

  // Step 4: call LLM for assessment
  let assessment = "";
  try {
    const llmResult = await fetchJson(DEV_VESSEL_URL, {
      type: "llm_completion_dispatch",
      prompt,
      max_tokens: 2000,
      model: "claude-3-5-haiku-20241022",
    });
    const llmBody: any = llmResult?.body ?? llmResult ?? {};
    assessment =
      (typeof llmBody?.completion === "string" ? llmBody.completion : null) ??
      (typeof llmBody?.text === "string" ? llmBody.text : null) ??
      (typeof llmBody?.content === "string" ? llmBody.content : null) ??
      JSON.stringify(llmBody);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Fallback: produce a static structural analysis without LLM
    const fileSummaries = fileContents.map((f) => {
      const lines = f.content.split("\n");
      const asyncCount = lines.filter((l) => l.includes("async ")).length;
      const todoCount = lines.filter((l) => l.includes("TODO") || l.includes("FIXME") || l.includes("HACK")).length;
      const errorHandling = lines.filter((l) => l.includes("catch") || l.includes("try {")).length;
      return `- ${f.path}: ${lines.length} lines, ${asyncCount} async fns, ${todoCount} TODO/FIXME/HACK, ${errorHandling} try/catch blocks`;
    });
    assessment = [
      `## Clock-Vessel Code Quality Assessment (static analysis — LLM unavailable: ${msg})`,
      "",
      `**Files analyzed:** ${fileContents.length} of ${fileList.length} TypeScript files`,
      "",
      "### File Summary",
      ...fileSummaries,
      "",
      "### Static Observations",
      `- Total files in vessel: ${fileList.length}`,
      `- Files successfully read: ${fileContents.length}`,
      `- Largest file: ${fileContents.reduce((a, b) => (a.content.length > b.content.length ? a : b), fileContents[0] ?? { path: "none", content: "" }).path}`,
      "",
      "*Full LLM-based assessment unavailable. Run again when llm_completion_dispatch is reachable.*",
    ].join("\n");
  }

  return {
    shape: "code_quality with substantive assessment content",
    body: {
      assessment,
      files_analyzed: fileContents.length,
      total_files_found: fileList.length,
      files_read: fileContents.map((f) => f.path),
      vessel: "clock-vessel",
    },
  };
}
