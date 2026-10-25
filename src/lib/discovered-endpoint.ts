import { lookupShape, CONCEPT_DB_ENDPOINT } from "../config.js";

/**
 * The http base of a producer of `shape`, by discovery: a local producer first, else an http peer row
 * (discovery re-homes a peer's loopback onto the peer's host; a libp2p overlay facade is not an http
 * base and is skipped). An unreadable or empty lookup falls back to `fallback`.
 *
 * The pattern drafter's tasks fetch fixed services (activity-api for its vocabulary, concept-db for its
 * priors) at loopback defaults, which are dead on a node that does not run them. Its feeders resolve
 * those bases here and pass them in the dispatch, so the same template runs on any profile.
 */
export async function discoverShapeBase(shape: string, fallback: string): Promise<string> {
  const look = await lookupShape(shape);
  if (look.ok) {
    const bases = (origin: (o: string | undefined) => boolean): string[] =>
      look.producers
        .filter((p) => origin(p.origin))
        .flatMap((p) => {
          try {
            const u = new URL(p.resolveEndpoint);
            return u.protocol === "http:" || u.protocol === "https:" ? [u.origin] : [];
          } catch {
            return [];
          }
        });
    const pick = bases((o) => o === "local")[0] ?? bases((o) => typeof o === "string" && o.startsWith("peer:"))[0];
    if (pick) return pick;
  }
  return fallback.replace(/\/+$/, "");
}

/** activity-api, which advertises activityTemplate. */
export function discoverActivityApiEndpoint(fallback: string): Promise<string> {
  return discoverShapeBase("activityTemplate", fallback);
}

/**
 * concept-db. conceptGraph, not concept: development-vessel advertises concept too, and the drafter's
 * /concepts/search is concept-db's own route. Fallback: the configured CONCEPT_DB_ENDPOINT.
 */
export function discoverConceptDbEndpoint(fallback: string = CONCEPT_DB_ENDPOINT): Promise<string> {
  return discoverShapeBase("conceptGraph", fallback);
}
