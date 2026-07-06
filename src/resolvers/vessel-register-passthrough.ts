import { DISCOVERY_ENDPOINT, METABOB_API_KEY, VESSEL_ID } from "../config.js";
import type { ResolverResult } from "./types.js";

export interface VesselRegisterPassthroughPointer {
  type: "vessel_register_passthrough";
  registration: {
    vessel_id?: string;
    shapes: string[];
    resolve_endpoint: string;
    endpoint?: string;
    auth_scheme?: string;
  };
}

export async function resolveVesselRegisterPassthrough(
  pointer: VesselRegisterPassthroughPointer,
): Promise<ResolverResult> {
  const registration = pointer?.registration;
  if (!registration || typeof registration !== "object") {
    return {
      shape: "structuredError",
      body: {
        detail:
          "vessel_register_passthrough requires pointer.registration with shapes and resolve_endpoint",
      },
    };
  }
  const payload = {
    vessel_id: registration.vessel_id ?? VESSEL_ID,
    ...registration,
  };
  const res = await fetch(`${DISCOVERY_ENDPOINT}/register`, {
    method: "POST",
    headers: {
      Authorization: `ApiKey ${METABOB_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`vessel_register_passthrough: ${res.status}: ${text.slice(0, 200)}`);
  }
  const result = await res.json() as Record<string, unknown>;
  return {
    shape: "vessel_register_passthrough",
    body: result,
  };
  return { shape: "vessel_registered", body: result };
}
