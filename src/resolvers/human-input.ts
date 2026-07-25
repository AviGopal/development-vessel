import type { ResolverResult } from "../resolvers/types.js";

// Resolver for "human_input" impulses: fetches Obsidian vault notes via discovery API,
// aggregates into a report, and returns the computed report under the advertised shape.
// Uses only globals (fetch, process.env, AbortSignal, JSON, Math) and guards all index accesses.

export async function resolveHumanInput(pointer: Record<string, unknown>): Promise<ResolverResult> {
  const discoveryEndpoint = process.env.DISCOVERY_ENDPOINT ?? "http://localhost:8765";
  const apiKey = process.env.METABOB_API_KEY;

  // Fetch notes from the Obsidian vault via discovery API.
  const url = `${discoveryEndpoint}/v2/notes?limit=1000`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `ApiKey ${apiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        shape: "structuredError",
        body: {
          message: `discovery notes fetch failed: HTTP ${res.status}`,
          details: text,
        },
      };
    }

    const data = (await res.json()) as any;

    // Aggregate notes into a report.
    const notes = Array.isArray(data?.notes) ? data.notes : [];
    const report = {
      total_notes: notes.length ?? 0,
      notes_with_content: (notes.filter((n: any) => (n?.content?.length ?? 0) > 0) ?? []).length,
      note_titles: (notes.map((n: any) => n?.title ?? "Untitled") ?? []).filter((t: string) => typeof t === "string"),
    };

    return {
      shape: "human_input",
      body: report,
    };
  } catch (err) {
    return {
      shape: "structuredError",
      body: {
        message: `failed to fetch notes: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}
