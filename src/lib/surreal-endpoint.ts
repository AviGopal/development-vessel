// THE DATABASE ROOT LOGIN GOES ONLY TO THE CONFIGURED DATABASE.
//
// The resolvers that query SurrealDB's /sql directly (surrealdb_export, surrealdb_import,
// residual_shape_discovery) authenticate with `Basic <SURREALDB_USERNAME:SURREALDB_PASSWORD>`, the root
// login. Their pointers accept a `surrealUrl` override. A URL a pointer names must never receive that login.
// These are root operations, so an override that is not the configured database is REFUSED, not sent
// unauthenticated.
//
// The configured database is SURREALDB_URL (read when called), falling back to the local default. An empty
// env value counts as unset, because some containers export endpoint vars as "". A blank override counts
// as unset too, and an override equal to the configured URL (ignoring trailing slashes) is the configured
// URL.

export const DEFAULT_SURREAL_URL = "http://127.0.0.1:8000";

const norm = (u: string): string => u.trim().replace(/\/+$/, "");

export function configuredSurrealUrl(): string {
  return norm(process.env["SURREALDB_URL"] || DEFAULT_SURREAL_URL);
}

/** The database a resolver may send the root login to, or why the pointer's surrealUrl is refused. */
export function surrealTarget(override: unknown): { url: string } | { refused: string } {
  const configured = configuredSurrealUrl();
  if (override === undefined || override === null || (typeof override === "string" && override.trim() === "")) {
    return { url: configured };
  }
  if (typeof override === "string" && norm(override) === configured) return { url: configured };
  return {
    refused:
      `surrealUrl ${JSON.stringify(String(override).slice(0, 120))} is not the configured database: ` +
      `the root login goes only to SURREALDB_URL`,
  };
}
