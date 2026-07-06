import type { ResolverResult } from "./types.js";

const METABOB_ENDPOINT = process.env["METABOB_ENDPOINT"] ?? "http://127.0.0.1:8080";
const METABOB_API_KEY = process.env["METABOB_API_KEY"] ?? "";

interface ActivityTemplatePointer {
  type: string;
  templateId?: string;
  limit?: number;
}

export async function resolveActivityTemplate(
  pointer: ActivityTemplatePointer,
): Promise<ResolverResult> {
  const templateId = pointer.templateId ?? null;
  const limit = pointer.limit ?? 50;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (METABOB_API_KEY) {
    headers["Authorization"] = `ApiKey ${METABOB_API_KEY}`;
  }

  // Fetch activity templates from the substrate activity-api
  const url = templateId
    ? `${METABOB_ENDPOINT}/v2/activities/templates/${encodeURIComponent(templateId)}`
    : `${METABOB_ENDPOINT}/v2/activities/templates?limit=${limit}`;

  const res = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      shape: "activity_template",
      body: {
        ok: false,
        status: res.status,
        error: text,
        templateId: templateId ?? null,
        templates: [],
        total: 0,
        summary: `Fetch failed: HTTP ${res.status}`,
      },
    };
  }

  const data: any = await res.json();

  if (templateId) {
    // Single template fetch
    const tmpl: any = data?.template ?? data ?? {};
    const id: string = tmpl?.id ?? templateId;
    const taskCount: number = Array.isArray(tmpl?.tasks) ? (tmpl.tasks as unknown[]).length : 0;
    const tags: string[] = Array.isArray(tmpl?.tags) ? (tmpl.tags as string[]) : [];
    return {
      shape: "activity_template",
      body: {
        ok: true,
        templateId: id,
        templates: [tmpl],
        total: 1,
        summary: `Template ${id}: ${taskCount} task(s), tags=[${tags.join(", ")}]`,
        taskCount,
        tags,
      },
    };
  }

  // List fetch — aggregate stats
  const rawTemplates: any[] = Array.isArray(data?.templates)
    ? (data.templates as any[])
    : Array.isArray(data)
    ? (data as any[])
    : [];

  const totalCount: number =
    typeof data?.total === "number" ? (data.total as number) : rawTemplates.length;

  // Aggregate: count tasks per template, collect all unique tags
  let totalTasks = 0;
  const tagCounts: Record<string, number> = {};
  const summaryRows: Array<{ id: string; taskCount: number; tags: string[] }> = [];

  for (const tmpl of rawTemplates) {
    const tId: string = (tmpl?.id as string | undefined) ?? "unknown";
    const tasks: unknown[] = Array.isArray(tmpl?.tasks) ? (tmpl.tasks as unknown[]) : [];
    const tTags: string[] = Array.isArray(tmpl?.tags) ? (tmpl.tags as string[]) : [];
    totalTasks += tasks.length;
    for (const tag of tTags) {
      tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    }
    summaryRows.push({ id: tId, taskCount: tasks.length, tags: tTags });
  }

  const topTags = Object.entries(tagCounts)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, 10)
    .map(([tag, count]) => `${tag}(${count ?? 0})`);

  return {
    shape: "activity_template",
    body: {
      ok: true,
      templateId: null,
      templates: summaryRows,
      total: totalCount,
      fetchedCount: rawTemplates.length,
      totalTasks,
      topTags,
      summary: `Fetched ${rawTemplates.length}/${totalCount} templates; ${totalTasks} total tasks; top tags: ${topTags.slice(0, 5).join(", ")}`,
    },
  };
}
