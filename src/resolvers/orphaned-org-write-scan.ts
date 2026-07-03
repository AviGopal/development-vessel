const SURREALDB_URL = process.env["SURREALDB_URL"] ?? "http://127.0.0.1:8000";
const SURREALDB_NAMESPACE = process.env["SURREALDB_NAMESPACE"] ?? "activity-system";
const SURREALDB_DATABASE = process.env["SURREALDB_DATABASE"] ?? "learning_loop";
const SURREALDB_USERNAME = process.env["SURREALDB_USERNAME"] ?? "root";
const SURREALDB_PASSWORD = process.env["SURREALDB_PASSWORD"] ?? process.env["SURREAL_PASS"] ?? "root";

interface SurrealResult<T> {
  result: T[];
  status: string;
}

async function surrealQuery<T>(sql: string): Promise<T[]> {
  const creds = btoa(`${SURREALDB_USERNAME}:${SURREALDB_PASSWORD}`);
  const res = await fetch(`${SURREALDB_URL}/sql`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "surreal-ns": SURREALDB_NAMESPACE,
      "surreal-db": SURREALDB_DATABASE,
      Accept: "application/json",
      "Content-Type": "text/plain",
    },
    body: sql,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SurrealDB HTTP error ${res.status}: ${text}`);
  }
  const json = (await res.json()) as SurrealResult<T>[];
  const first = json[0];
  if (!first) return [];
  if (first.status !== "OK") {
    throw new Error(`SurrealDB query error: ${JSON.stringify(first)}`);
  }
  return first.result;
}

interface OrgIdRow {
  org_id: string;
  count: number;
}

interface OrphanEntry {
  table: string;
  org_id: string;
  row_count: number;
}

export async function resolveOrphanedOrgWriteScan(_pointer: { type: string } & Record<string, unknown>): Promise<{
  shape: "orphanedOrgWriteReport";
  body: {
    known_orgs: string[];
    orphans: OrphanEntry[];
    orphan_count: number;
    checked_at: string;
  };
}> {
  // (1) Fetch all known org record ids
  const orgIds = await surrealQuery<string>("SELECT VALUE id FROM organizations;");
  const knownOrgs = new Set<string>(orgIds.map((id) => String(id)));

  // (2) Fetch org_id usage in concept and concept_edge tables
  const conceptRows = await surrealQuery<OrgIdRow>("SELECT org_id, count() FROM concept GROUP BY org_id;");
  const edgeRows = await surrealQuery<OrgIdRow>("SELECT org_id, count() FROM concept_edge GROUP BY org_id;");

  // (3) Identify orphaned org_id values
  const orphans: OrphanEntry[] = [];

  for (const row of conceptRows) {
    const orgId = String(row.org_id);
    if (!knownOrgs.has(orgId)) {
      orphans.push({ table: "concept", org_id: orgId, row_count: row.count });
    }
  }

  for (const row of edgeRows) {
    const orgId = String(row.org_id);
    if (!knownOrgs.has(orgId)) {
      orphans.push({ table: "concept_edge", org_id: orgId, row_count: row.count });
    }
  }

  return {
    shape: "orphanedOrgWriteReport",
    body: {
      known_orgs: Array.from(knownOrgs),
      orphans,
      orphan_count: orphans.length,
      checked_at: new Date().toISOString(),
    },
  };
}
