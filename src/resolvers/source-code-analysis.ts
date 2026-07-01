import type { ResolverResult } from "./types.js";

const WORKSPACE_ROOT = process.env["WORKSPACE_ROOT"] ?? process.cwd();
const FS_READ_URL =
  process.env["DEV_VESSEL_IMPULSES_URL"] ?? "http://127.0.0.1:8090/v2/impulses/resolve";
const FS_LIST_URL =
  process.env["DEV_VESSEL_IMPULSES_URL"] ?? "http://127.0.0.1:8090/v2/impulses/resolve";
const METABOB_API_KEY = process.env["METABOB_API_KEY"] ?? "";

async function callImpulse(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(FS_READ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(METABOB_API_KEY ? { Authorization: `ApiKey ${METABOB_API_KEY}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`impulse call failed ${res.status}: ${text}`);
  }
  return res.json() as Promise<any>;
}

async function listFiles(dirPath: string): Promise<string[]> {
  try {
    const result = await callImpulse({
      type: "fs_list",
      path: dirPath,
    });
    const body = (result as any)?.body;
    const entries: unknown[] = Array.isArray(body?.entries) ? body.entries : [];
    return entries
      .map((e: unknown) => {
        if (typeof e === "string") return e;
        if (e !== null && typeof e === "object") {
          const obj = e as Record<string, unknown>;
          return typeof obj["path"] === "string" ? obj["path"] : "";
        }
        return "";
      })
      .filter((p) => p.length > 0);
  } catch {
    return [];
  }
}

async function readFile(filePath: string): Promise<string> {
  try {
    const result = await callImpulse({
      type: "fs_read",
      path: filePath,
    });
    const body = (result as any)?.body;
    if (typeof body?.content === "string") return body.content;
    if (typeof body === "string") return body;
    return "";
  } catch {
    return "";
  }
}

function classifyFile(filename: string): "source" | "config" | "test" | "doc" | "other" {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".test.ts") || lower.endsWith(".spec.ts")) return "test";
  if (lower.endsWith(".ts") || lower.endsWith(".js")) return "source";
  if (
    lower === "package.json" ||
    lower === "tsconfig.json" ||
    lower.endsWith(".json") ||
    lower.endsWith(".yaml") ||
    lower.endsWith(".yml") ||
    lower.endsWith(".toml")
  )
    return "config";
  if (lower.endsWith(".md") || lower.endsWith(".txt")) return "doc";
  return "other";
}

function extractExports(source: string): string[] {
  const exports: string[] = [];
  const re = /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const name = m[1];
    if (name !== undefined) exports.push(name);
  }
  return exports;
}

function extractImports(source: string): string[] {
  const imports: string[] = [];
  const re = /from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const mod = m[1];
    if (mod !== undefined) imports.push(mod);
  }
  return imports;
}

function countLines(source: string): number {
  if (source.length === 0) return 0;
  return source.split("\n").length;
}

interface FileAnalysis {
  path: string;
  kind: "source" | "config" | "test" | "doc" | "other";
  lines: number;
  exports: string[];
  imports: string[];
  snippet: string;
}

interface SourceCodeAnalysisBody {
  target_path: string;
  summary: string;
  file_count: number;
  source_files: number;
  test_files: number;
  config_files: number;
  doc_files: number;
  total_lines: number;
  all_exports: string[];
  all_imports: string[];
  entry_points: string[];
  files: FileAnalysis[];
  purpose_signals: string[];
}

export async function resolveSourceCodeAnalysis(
  pointer: Record<string, unknown>,
): Promise<ResolverResult> {
  const rawTarget = pointer["target_path"] ?? pointer["path"] ?? pointer["vesselPath"];
  const targetPath: string =
    typeof rawTarget === "string" && rawTarget.length > 0
      ? rawTarget
      : "repos/clock-vessel";

  // Resolve absolute path
  const absoluteTarget = targetPath.startsWith("/")
    ? targetPath
    : `${WORKSPACE_ROOT}/${targetPath}`;

  // Discover files recursively (up to 2 levels to avoid explosion)
  const topEntries = await listFiles(absoluteTarget);
  const allPaths: string[] = [];

  for (const entry of topEntries) {
    const entryPath = entry.startsWith("/") ? entry : `${absoluteTarget}/${entry}`;
    const basename = entry.split("/").pop() ?? entry;
    const kind = classifyFile(basename);
    if (kind !== "other" || basename.includes(".")) {
      allPaths.push(entryPath);
    }
    // One level deeper for src/ directories
    if (basename === "src" || basename.endsWith("/src")) {
      const subEntries = await listFiles(entryPath);
      for (const sub of subEntries) {
        const subPath = sub.startsWith("/") ? sub : `${entryPath}/${sub}`;
        allPaths.push(subPath);
      }
    }
  }

  // Also try standard sub-paths for known vessel layout
  const standardPaths = [
    `${absoluteTarget}/src/index.ts`,
    `${absoluteTarget}/package.json`,
    `${absoluteTarget}/README.md`,
    `${absoluteTarget}/tsconfig.json`,
  ];
  for (const sp of standardPaths) {
    if (!allPaths.includes(sp)) allPaths.push(sp);
  }

  // Read and analyze each file (cap at 40 files, prefer source/config)
  const analysed: FileAnalysis[] = [];
  let totalLines = 0;

  const prioritized = allPaths
    .map((p) => ({
      p,
      kind: classifyFile(p.split("/").pop() ?? p),
    }))
    .sort((a, b) => {
      const order = { source: 0, config: 1, test: 2, doc: 3, other: 4 };
      return (order[a.kind] ?? 4) - (order[b.kind] ?? 4);
    });

  for (const { p, kind } of prioritized.slice(0, 40)) {
    const content = await readFile(p);
    if (content.length === 0) continue;
    const lines = countLines(content);
    totalLines += lines;
    const exports =
      kind === "source" || kind === "test" ? extractExports(content) : [];
    const imports =
      kind === "source" || kind === "test" ? extractImports(content) : [];
    const snippet = content.slice(0, 400);
    analysed.push({ path: p, kind, lines, exports, imports, snippet });
  }

  // Aggregate
  const allExports = Array.from(
    new Set(analysed.flatMap((f) => f.exports)),
  );
  const allImports = Array.from(
    new Set(
      analysed
        .flatMap((f) => f.imports)
        .filter((i) => !i.startsWith("."))
        .map((i) => i.split("/")[0] ?? i),
    ),
  );

  const entryPoints = analysed
    .filter(
      (f) =>
        f.path.endsWith("index.ts") ||
        f.path.endsWith("index.js") ||
        f.path.endsWith("main.ts"),
    )
    .map((f) => f.path);

  // Derive purpose signals from exports + snippets
  const purposeSignals: string[] = [];
  for (const f of analysed) {
    if (f.kind === "source" && f.exports.length > 0) {
      purposeSignals.push(`exports: ${f.exports.slice(0, 5).join(", ")}`);
    }
    // Look for Bun.serve / Hono / fetch handler patterns
    if (f.snippet.includes("Bun.serve")) purposeSignals.push("http_server:bun_serve");
    if (f.snippet.includes("new Hono")) purposeSignals.push("http_framework:hono");
    if (f.snippet.includes("setInterval")) purposeSignals.push("periodic_tick:setInterval");
    if (f.snippet.includes("cron") || f.snippet.includes("Cron")) purposeSignals.push("scheduling:cron");
    if (f.snippet.includes("clock") || f.snippet.includes("Clock")) purposeSignals.push("domain:clock");
    if (f.snippet.includes("tick") || f.snippet.includes("Tick")) purposeSignals.push("domain:tick");
    if (f.snippet.includes("impulse") || f.snippet.includes("Impulse")) purposeSignals.push("pattern:impulse");
  }

  const uniqueSignals = Array.from(new Set(purposeSignals));

  const sourceCount = analysed.filter((f) => f.kind === "source").length;
  const testCount = analysed.filter((f) => f.kind === "test").length;
  const configCount = analysed.filter((f) => f.kind === "config").length;
  const docCount = analysed.filter((f) => f.kind === "doc").length;

  const pkgFile = analysed.find((f) => f.path.endsWith("package.json"));
  let packageName = "";
  if (pkgFile !== undefined) {
    try {
      const pkg = JSON.parse(pkgFile.snippet) as any;
      packageName = typeof pkg["name"] === "string" ? pkg["name"] : "";
    } catch {
      packageName = "";
    }
  }

  const summary = [
    packageName ? `Package: ${packageName}.` : "",
    `Analysed ${analysed.length} files (${sourceCount} source, ${testCount} test, ${configCount} config, ${docCount} doc).`,
    `Total lines: ${totalLines}.`,
    `Exported symbols: ${allExports.slice(0, 10).join(", ") || "(none found)"}`,
    `External dependencies: ${allImports.slice(0, 8).join(", ") || "(none)"}`,
    uniqueSignals.length > 0
      ? `Purpose signals: ${uniqueSignals.slice(0, 8).join("; ")}`
      : "",
  ]
    .filter((s) => s.length > 0)
    .join(" ");

  const body: SourceCodeAnalysisBody = {
    target_path: targetPath,
    summary,
    file_count: analysed.length,
    source_files: sourceCount,
    test_files: testCount,
    config_files: configCount,
    doc_files: docCount,
    total_lines: totalLines,
    all_exports: allExports,
    all_imports: allImports,
    entry_points: entryPoints,
    files: analysed,
    purpose_signals: uniqueSignals,
  };

  return { shape: "sourceCodeAnalysis", body };
}
