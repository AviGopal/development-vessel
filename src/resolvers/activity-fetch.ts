import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

export interface ActivityFetchPointer {
  type: "activity_fetch";
  templateId: string;
}

export async function resolveActivityFetch(pointer: ActivityFetchPointer): Promise<ResolverResult> {
  const url = `${METABOB_ENDPOINT}/v2/activities/templates/${encodeURIComponent(pointer.templateId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `ApiKey ${METABOB_API_KEY}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      shape: "structuredError",
      body: { resolver: "activity_fetch", status: res.status, templateId: pointer.templateId, detail: text.slice(0, 200) },
    };
  }
  const body = await res.json();
  return { shape: "activity_template", body };
}
