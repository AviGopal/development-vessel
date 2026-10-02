/**
 * SEED DELIVERY — how activity seed templates reach the catalogue.
 *
 * Two paths, one owner each:
 *   - COLD START (empty catalogue): `cli.ts seed-templates`, run by development-vessel-seed,
 *     bulk-uploads every seed through activity_create_variant.
 *   - POPULATED catalogue: only a seed that OPTS IN by raising `metadata.seed_version` above
 *     the registered row's is uploaded (upsertVersionBumpedSeeds). A seed absent from the
 *     registry counts as version 0, so a brand-new seed carrying seed_version >= 1 is
 *     delivered too. Untouched seeds and rows the learning loop evolved stay as they are.
 *
 * The populated path used to run only when the seed unit ran, and the unit only runs at boot
 * (it is disabled or masked on running nodes; restarting it from the vessel at module import
 * was a `systemctl --user` call against a system unit, which always failed). So a version
 * bump or a new seed landed by a cutover stayed inert until a reboot. The vessel server now
 * schedules the populated-path upsert itself, once per process, deferred off the startup path
 * (scheduleSeedDelivery, called from startDiscoveryRegistration — the server's start path,
 * never an import). Importing this module, or the seed registry, does nothing.
 */
import type { ActivityTemplate } from "@avigopal/ias-executor-ts";
import { METABOB_API_KEY, METABOB_ENDPOINT, lookupShape, type DevDiscoveryLookup } from "../config.js";

export interface SeedUpsertCounts {
  /** Seeds uploaded because their seed_version exceeded the registered row's (or no row existed). */
  upserted: number;
  /** Seeds whose registered row is already at or above their seed_version. */
  current: number;
  /** Seeds whose registered version could not be read (non-404 error) or whose upload failed. */
  skipped: number;
}

/**
 * UPSERT A SEED WHOSE AUTHOR BUMPED ITS VERSION. Once the catalogue is populated the
 * bulk seed is skipped entirely (see SEED-IF-EMPTY in cli.ts) so learned rows are not
 * clobbered — which also made every edit to a seed file inert on a running substrate (the
 * trace-store reconcile carried a 900 s timeout in source for hours while the registered
 * row still aborted at 15 s). A seed opts in to an update by raising
 * `metadata.seed_version`; it is re-uploaded only when that number exceeds the
 * registered row's, so untouched seeds and rows the learning loop evolved stay as they are.
 *
 * ABSENT means 404 only. activity-api answers 404 "Template not found" for an id it does not
 * hold, and that is `have = 0`. Any other failure to read the row (401, 5xx, timeout) is
 * skipped, not treated as absent: uploading over a row we could not see could replace an
 * evolved version at an equal seed_version.
 *
 * Upserted by id straight to activity-api: this is an update of an existing template (or the
 * delivery of a seed the catalogue never received), not a mint, so the reuse-before-mint
 * probe (which refuses a second producer of the same shapes) does not apply.
 */
export async function upsertVersionBumpedSeeds(
  templates: ReadonlyArray<unknown>,
  endpoint: string,
  apiKey: string | undefined,
): Promise<SeedUpsertCounts> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}) };
  const counts: SeedUpsertCounts = { upserted: 0, current: 0, skipped: 0 };
  for (const t of templates) {
    const tpl = t as { id?: string; metadata?: { seed_version?: unknown } };
    const want = Number(tpl.metadata?.seed_version ?? 0);
    if (!tpl.id || !Number.isFinite(want) || want <= 0) continue;
    try {
      const r = await fetch(`${endpoint}/v2/activities/templates/${encodeURIComponent(tpl.id)}`, { headers, signal: AbortSignal.timeout(10_000) });
      let have = 0;
      if (r.ok) {
        const reg = (await r.json()) as { metadata?: { seed_version?: unknown } } | null;
        have = Number(reg?.metadata?.seed_version ?? 0);
        if (Number.isFinite(have) && have >= want) {
          counts.current++;
          continue;
        }
      } else if (r.status !== 404) {
        counts.skipped++;
        console.warn(`[seed] version check for ${tpl.id} returned HTTP ${r.status} (skipped: cannot tell absent from unreadable)`);
        continue;
      }
      // Same tag sanitising activity_create_variant applies before it posts: activity-api's
      // TagSchema is /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/, and seeds carry hyphenated tags
      // (e.g. "db.maintenance.trace-store") that the variant path always rewrote.
      const rawTags = (t as { tags?: unknown }).tags;
      const tags = Array.isArray(rawTags)
        ? rawTags.map((tag) => (typeof tag === "string" ? tag.toLowerCase().replace(/-/g, ".").replace(/[^a-z0-9.]/g, "") : tag))
        : rawTags;
      const body = { ...(t as Record<string, unknown>), tags, proposed: false, org_id: "organizations:substrate" };
      const w = await fetch(`${endpoint}/v2/activities/templates`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      if (w.ok) {
        counts.upserted++;
        console.log(`[seed] upserted ${tpl.id}: seed_version ${have} -> ${want}`);
      } else {
        counts.skipped++;
        console.warn(`[seed] upsert of ${tpl.id} refused: HTTP ${w.status} ${(await w.text()).slice(0, 200)}`);
      }
    } catch (e) {
      counts.skipped++;
      console.warn(`[seed] version check for ${tpl.id} failed (skipped): ${(e as Error).message}`);
    }
  }
  console.log(`[seed] populated catalogue: ${counts.upserted} version-bumped seed(s) upserted, ${counts.current} already current, ${counts.skipped} skipped`);
  return counts;
}

export type CatalogueState =
  | { state: "populated"; count: number }
  | { state: "empty" }
  | { state: "unknown"; detail: string };

/** One authenticated `?limit=1` read of the catalogue: populated, empty, or could not tell. */
export async function readCatalogueState(endpoint: string, apiKey: string | undefined): Promise<CatalogueState> {
  try {
    const r = await fetch(`${endpoint}/v2/activities/templates?limit=1`, {
      headers: apiKey ? { Authorization: `ApiKey ${apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return { state: "unknown", detail: `HTTP ${r.status}` };
    const body = (await r.json()) as { templates?: unknown[]; total?: number };
    const count = body.total ?? (Array.isArray(body.templates) ? body.templates.length : 0);
    return count > 0 ? { state: "populated", count } : { state: "empty" };
  } catch (e) {
    return { state: "unknown", detail: (e as Error).message };
  }
}

/**
 * LOCAL-ONLY DELIVERY. A node writes seeds only into the catalogue served by ITS OWN activity-api.
 * A canary node (node 2) points METABOB_ENDPOINT at another node's catalogue; were it to upsert
 * there, a seed bump it carries would reach the shared catalogue before the owning node runs the
 * code the seed references, a side door around staged rollout.
 *
 * Decided BEFORE any catalogue GET/POST, from one typed discovery lookup of the catalogue shape
 * (`activityTemplate`, which only activity-api advertises). The catalogue is local only when
 * THIS node's discovery registry serves a producer of it (origin "local"; a peer row, even one of
 * this same substrate, is another node's catalogue) AND the configured endpoint is that producer:
 * its http origin equals the producer's advertised origin, or it is a loopback address (the
 * vessel dials its co-resident activity-api on 127.0.0.1 while discovery advertises a routable
 * host). Everything else skips, and it fails CLOSED: a failed lookup, or a producer list without
 * origin stamps (an older discovery or ias dist), never delivers.
 */
export type CatalogueLocality =
  | { local: true; host: string }
  | { local: false; host: string; why: string };

const CATALOGUE_SHAPE = "activityTemplate";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const originOf = (u: string): string | null => {
  try {
    const x = new URL(u);
    return x.protocol === "http:" || x.protocol === "https:" ? x.origin : null;
  } catch {
    return null;
  }
};

export async function catalogueLocality(
  endpoint: string,
  lookup: (shape: string) => Promise<DevDiscoveryLookup> = lookupShape,
): Promise<CatalogueLocality> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { local: false, host: String(endpoint), why: "catalogue endpoint is not a URL" };
  }
  const host = url.host;
  let r: DevDiscoveryLookup;
  try {
    r = await lookup(CATALOGUE_SHAPE);
  } catch (e) {
    return { local: false, host, why: `${CATALOGUE_SHAPE} lookup failed: ${(e as Error).message}` };
  }
  // Formatted here, not via describeLookup: a node loading an older ias dist has no describe(),
  // and the verdict must still come back as a skip, not a throw.
  if (!r.ok) return { local: false, host, why: `${CATALOGUE_SHAPE} lookup failed (${r.reason}): ${r.detail}` };
  type Producer = { resolveEndpoint: string; origin?: unknown };
  const own = (r.producers as Producer[]).filter((p) => p.origin === "local");
  if (own.length === 0) {
    return { local: false, host, why: `this node's registry serves no ${CATALOGUE_SHAPE} producer (${r.producers.length} non-local)` };
  }
  if (LOOPBACK.has(url.hostname)) return { local: true, host };
  if (own.some((p: Producer) => originOf(p.resolveEndpoint) === url.origin)) return { local: true, host };
  return { local: false, host, why: `endpoint is not this node's ${CATALOGUE_SHAPE} producer` };
}

/**
 * The server-side delivery: wait (bounded) for activity-api to answer, then upsert
 * version-bumped and brand-new seeds — but ONLY into a populated catalogue. An empty one is
 * left to the cold-start bulk seed: a single seed landing first would make the catalogue
 * non-empty and the bulk seeder would then skip the whole bootstrap set.
 *
 * Targets METABOB_ENDPOINT only when it is THIS node's own activity-api (catalogueLocality,
 * checked before any catalogue request); on a node that reads another node's catalogue it skips
 * with `[seed-delivery] skipped: remote catalogue <host>`, and the owning node delivers when it
 * runs the code. Within one catalogue an upload happens only when the seed's version is
 * STRICTLY greater than the registered one, so an older process never downgrades a row.
 */
export async function deliverSeedsToPopulatedCatalogue(opts: {
  templates?: ReadonlyArray<unknown>;
  endpoint?: string;
  apiKey?: string;
  attempts?: number;
  intervalMs?: number;
  lookup?: (shape: string) => Promise<DevDiscoveryLookup>;
} = {}): Promise<SeedUpsertCounts | null> {
  const endpoint = opts.endpoint ?? METABOB_ENDPOINT;
  const apiKey = opts.apiKey ?? METABOB_API_KEY;
  const where = await catalogueLocality(endpoint, opts.lookup);
  if (!where.local) {
    console.log(`[seed-delivery] skipped: remote catalogue ${where.host} (${where.why})`);
    return null;
  }
  const attempts = opts.attempts ?? 10;
  const intervalMs = opts.intervalMs ?? 15_000;
  let last = "";
  for (let i = 1; i <= attempts; i++) {
    const st = await readCatalogueState(endpoint, apiKey);
    if (st.state === "populated") {
      const templates: ReadonlyArray<unknown> =
        opts.templates ?? ((await import("./index.js")).SEED_TEMPLATES as ReadonlyArray<ActivityTemplate>);
      return upsertVersionBumpedSeeds(templates, endpoint, apiKey);
    }
    if (st.state === "empty") {
      console.log("[seed] catalogue empty — leaving it to the cold-start seed (development-vessel-seed)");
      return null;
    }
    last = st.detail;
    if (i < attempts) await new Promise((r) => setTimeout(r, intervalMs));
  }
  console.warn(`[seed] seed delivery gave up after ${attempts} attempt(s): catalogue unreadable (${last})`);
  return null;
}

let scheduled = false;

/**
 * Schedule seed delivery ONCE per process, deferred so it never holds server start.
 * Returns true for the call that scheduled it, false for every later call. The timer is
 * unref'd: a pending delivery never keeps a process alive on its own.
 */
export function scheduleSeedDelivery(opts: { run?: () => Promise<unknown>; delayMs?: number } = {}): boolean {
  if (scheduled) return false;
  scheduled = true;
  const run = opts.run ?? (() => deliverSeedsToPopulatedCatalogue());
  const timer = setTimeout(() => {
    run().catch((e: unknown) => console.warn(`[seed] seed delivery failed: ${e instanceof Error ? e.message : String(e)}`));
  }, opts.delayMs ?? 10_000);
  (timer as { unref?: () => void }).unref?.();
  return true;
}
