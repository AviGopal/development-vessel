/**
 * The full activity-template catalogue, revalidated by ETag instead of re-paged.
 *
 * WHY. reachable-unlearned-report paged GET /v2/activities/templates 100 at a time to the endpoint's `total` on every
 * run: ~30 pages per run, from every node that runs it, against the hub's activity-api, whose catalogue listing was the
 * hub's top database load. activity-api now answers a weak ETag naming the catalogue version of the caller's visibility
 * (the same tag on every page) and a 304 with no body to a matching If-None-Match.
 *
 * THE READ. The last complete walk is kept with its tag, per endpoint and caller credential (a credential belongs to
 * one org, so this is per caller-org; the credential is only fingerprinted, never stored or logged). The first page is
 * asked with If-None-Match; a 304 returns the kept rows without paging. Otherwise the walk runs as before, and is kept
 * only when it was complete AND every page carried the same tag: a catalogue that changed mid-walk is not a version.
 * A server that sends no ETag is never asked conditionally, so the walk is unchanged there.
 */
import { createHash } from "node:crypto";

export interface TemplateCatalogueRead<T> {
  templates: T[];
  /** True when the server answered 304 and the kept rows were returned. */
  notModified: boolean;
  /** Number of /v2/activities/templates requests this read made. */
  requests: number;
}

let kept: { owner: string; etag: string; templates: unknown[] } | null = null;

function ownerOf(endpoint: string, apiKey: string): string {
  return `${endpoint}\u0000${createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}`;
}

/** Test seam: forget the kept catalogue. */
export function __resetTemplateCatalogueCache(): void {
  kept = null;
}

export async function fetchTemplateCatalogue<T>(
  endpoint: string,
  apiKey: string,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<TemplateCatalogueRead<T>> {
  const pageSize = opts.pageSize ?? 100;
  const maxPages = opts.maxPages ?? 100;
  const owner = ownerOf(endpoint, apiKey);
  const prior = kept && kept.owner === owner ? kept : null;
  const templates: T[] = [];
  let offset = 0;
  let total = Infinity;
  let requests = 0;
  let walkTag: string | null | undefined;
  let consistent = true;
  let complete = false;
  for (let guard = 0; guard < maxPages; guard++) {
    if (templates.length >= total) { complete = true; break; }
    const headers: Record<string, string> = { Authorization: `ApiKey ${apiKey}` };
    if (guard === 0 && prior) headers["If-None-Match"] = prior.etag;
    const r = await fetch(`${endpoint}/v2/activities/templates?limit=${pageSize}&offset=${offset}`, { headers });
    requests++;
    if (r.status === 304 && guard === 0 && prior) {
      return { templates: [...prior.templates] as T[], notModified: true, requests };
    }
    if (!r.ok) break;
    const tag = r.headers.get("ETag");
    if (walkTag === undefined) walkTag = tag;
    else if (tag !== walkTag) consistent = false;
    const page = await r.json() as { templates?: T[]; total?: number };
    if (typeof page.total === "number") total = page.total;
    const rows = page.templates ?? [];
    if (rows.length === 0) { complete = true; break; }
    templates.push(...rows);
    offset += rows.length;
  }
  if (!complete && templates.length >= total) complete = true;
  if (complete && consistent && walkTag) kept = { owner, etag: walkTag, templates: [...templates] };
  else if (prior) kept = null;
  return { templates, notModified: false, requests };
}
