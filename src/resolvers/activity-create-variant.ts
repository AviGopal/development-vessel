import { METABOB_ENDPOINT, METABOB_API_KEY } from "../config.js";
import type { ResolverResult } from "./types.js";

export interface ActivityCreateVariantPointer {
  type: "activity_create_variant";
  template: unknown;
  parentTemplateId?: string;
}

export async function resolveActivityCreateVariant(pointer: ActivityCreateVariantPointer): Promise<ResolverResult> {
  const url = `${METABOB_ENDPOINT}/v2/activities/templates`;
  const body = pointer.parentTemplateId
    ? { ...pointer.template as object, parent_template_id: pointer.parentTemplateId }
    : pointer.template;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `ApiKey ${METABOB_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const adminNote = res.status === 403 ? "admin scope required for this operation" : undefined;
    return {
      shape: "structuredError",
      body: { resolver: "activity_create_variant", status: res.status, detail: text.slice(0, 200), adminNote },
    };
  }
  const result = await res.json() as { id?: string; template_id?: string };
  const variantId = result.id ?? result.template_id ?? "";
  return {
    shape: "variant_created",
    body: { variantId, parentTemplateId: pointer.parentTemplateId, accepted: true },
  };
}
