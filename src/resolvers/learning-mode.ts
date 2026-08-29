import { env } from "../config.js";
interface ConceptRecord {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly provenance?: unknown;
  readonly updatedAt?: unknown;
}

interface ConceptDbResponse {
  readonly concepts?: ReadonlyArray<ConceptRecord>;
  readonly items?: ReadonlyArray<ConceptRecord>;
}

interface LearningModeBodySuccess {
  readonly concepts: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly provenance: string;
    readonly updatedAt: number;
  }>;
  readonly count: number;
}

interface LearningModeBodyError {
  readonly error: string;
  readonly concepts: readonly unknown[];
}

type LearningModeBody = LearningModeBodySuccess | LearningModeBodyError;

interface LearningModeResult {
  readonly shape: "learningMode";
  readonly body: LearningModeBody;
}

export async function resolveLearningMode(_pointer: Record<string, unknown>): Promise<LearningModeResult> {
  const endpoint = env("CONCEPT_DB_ENDPOINT", "http://127.0.0.1:8260");
  let res: Response;
  try {
    res = await fetch(`${endpoint}/concepts?limit=1000`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "fetch failed";
    return { shape: "learningMode", body: { error: msg, concepts: [] } };
  }

  if (!res.ok) {
    return { shape: "learningMode", body: { error: `concept-db ${res.status}`, concepts: [] } };
  }

  let json: ConceptDbResponse;
  try {
    json = (await res.json()) as ConceptDbResponse;
  } catch {
    return { shape: "learningMode", body: { error: "invalid json", concepts: [] } };
  }

  const items: ReadonlyArray<ConceptRecord> = json.concepts ?? json.items ?? [];

  const report = items.map((c: ConceptRecord) => ({
    id: typeof c.id === "string" ? c.id : "",
    title: typeof c.title === "string" ? c.title : "",
    provenance: typeof c.provenance === "string" ? c.provenance : "",
    updatedAt: typeof c.updatedAt === "number" ? c.updatedAt : 0,
  }));

  return { shape: "learningMode", body: { concepts: report, count: report.length } };
}