/**
 * BY-NAME EGRESS RESOLVES TO SELF. PIN THE DESTINATION SUBSTRATE.
 *
 * Three resolvers (feature-compose, patch-with-tools, llm-completion-dispatch) each carried the
 * same "hub-egress fallback": when no llm arm is discoverable locally, POST to
 *
 *     ${FED_TRANSPORT_EGRESS}/egress/resolve?vessel=llm-resolver-vessel
 *
 * Their comments all state the intent — "the egress picks a LIVE hub circuit and lands on the
 * owning vessel over libp2p" — and all three were wrong in the same way.
 *
 * MEASURED 2026-08-18 on a spoke federated to a funded hub:
 *
 *   ?vessel=llm-resolver-vessel  -> produced_by llm-resolver-vessel@...@spoke-739b76f1
 *   ?vessel=llm-resolver-google  -> produced_by llm-resolver-google@...@spoke-739b76f1
 *   ?vessel=llm-resolver-haiku   -> produced_by llm-resolver-haiku@...@spoke-739b76f1
 *
 * By-name routing lands on the LOCAL substrate every time — even for a name that exists on both
 * substrates. The "hub fallback" was a loop back to the credit-dead local arm it was written to
 * escape. Adding a target pins the destination:
 *
 *   ?target=<circuit-multiaddr>&vessel=llm-resolver-google
 *     -> produced_by llm-resolver-google@...@syzygy-hub, value "HUB", mistral-small-latest
 *
 * ★ AND THE NAME ITSELF WAS UNROUTABLE. The hub advertises llm-resolver-google / -haiku / -opus.
 *   There is no vessel named "llm-resolver-vessel" on it. So even had by-name routing crossed
 *   substrates, the hardcoded literal could not have matched a hub arm. Two independent defects,
 *   each alone sufficient — which is why fixing either one alone changes nothing.
 *
 * This helper asks discovery for llm_completion producers, keeps one row per PEER substrate
 * (never our own FED_SUBSTRATE_ID — and note that carrying a multiaddr does NOT mean remote:
 * measured, this substrate's own rows carry one too), and builds target-pinned URLs from the
 * discovered vesselId. Nothing is hardcoded: no peer name, no endpoint, no substrate id. If the
 * hub renames or re-homes an arm, discovery carries the change.
 */

interface DiscoveredVessel {
  vesselId?: string;
  endpoint?: string;
  libp2p_multiaddr?: string[];
  health_score?: number;
}

/**
 * Target-pinned egress URLs for every FEDERATED llm_completion producer discovery knows about,
 * best health first. Empty when discovery is unreachable or no federated producer exists — the
 * caller keeps whatever local endpoints it already had.
 */
export async function federatedLlmEgressUrls(
  discoveryEndpoint: string,
  apiKey: string,
  fedTransportEgress: string,
): Promise<string[]> {
  const rows: DiscoveredVessel[] = [];
  try {
    for (const shape of ["llm_completion", "llmCompletion"]) {
      const r = await fetch(`${discoveryEndpoint.replace(/\/$/, "")}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `ApiKey ${apiKey}` },
        body: JSON.stringify({ pointer: { type: "vesselCapability", shape } }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!r.ok) continue;
      const data = (await r.json()) as { content?: { vessels?: DiscoveredVessel[] }; vessels?: DiscoveredVessel[] };
      const vs = data.content?.vessels ?? data.vessels ?? [];
      if (vs.length > 0) { rows.push(...vs); break; }
    }
  } catch {
    return [];
  }

  // ★ CORRECTED 2026-08-18, SAME DAY, BY MEASUREMENT. The first version of this filter kept
  // "rows carrying a circuit multiaddr" and asserted in this very file that "a local row has
  // none". THAT IS FALSE. Measured against a live spoke registry, ALL FIVE llm_completion rows
  // carried a multiaddr — four of them this substrate's own vessels. Presence of a multiaddr is
  // not evidence of remoteness, so the filter admitted the dead local arms it existed to skip.
  //
  // The real discriminator is the substrate suffix of the vesselId (`<vessel>@<substrate>`).
  // Two things follow, and both are needed:
  //
  //   1. NEVER our own FED_SUBSTRATE_ID. Routing to ourselves through the egress is the
  //      loop-back this module exists to prevent.
  //   2. ONE CANDIDATE PER PEER SUBSTRATE. The same registry held FOUR rows for
  //      `@spoke-739b76f1` — a PREVIOUS INCARNATION of this spoke whose registrations outlived
  //      its container — all resolving to the same dead local resolver, ahead of the single
  //      live `@syzygy-hub` row. A caller with a bounded turn budget (patch-with-tools gives up
  //      after 3) exhausts it on duplicates of one dead arm and never reaches the working one.
  //      Deduping by substrate makes the cascade's budget buy DISTINCT arms rather than
  //      repeated attempts at the same one.
  // ★ CORRECTED TWICE, BOTH TIMES BY MEASUREMENT.
  //
  // v1 kept "rows carrying a circuit multiaddr" and asserted a local row has none. FALSE — all
  // five rows on a live spoke carried one, four of them ours.
  //
  // v2 kept ONE ROW PER PEER, to stop four stale rows from eating a bounded turn budget. That
  // over-corrected. The four stale rows were four DIFFERENT vessel names
  // (llm-resolver-vessel / -opus / -google / -haiku) on a dead incarnation of THIS spoke, so
  // per-vessel dedupe would not have collapsed them either — but per-PEER dedupe discarded the
  // hub's genuine alternates. Measured minutes later: llm-resolver-google@syzygy-hub returned a
  // transient 404 while llm-resolver-haiku and -opus on the SAME hub both answered "OK". One
  // arm per peer meant that transient took the whole peer down for the call.
  //
  // ROUND-ROBIN ACROSS PEERS is what both facts ask for. Take the first arm of each peer, then
  // the second of each, and so on. A dead or stale peer costs ONE slot per round instead of
  // monopolising the front of the list, and every distinct arm stays reachable as fallback.
  // With patch-with-tools' three turns and one stale peer, the hub is tried on turn two.
  const ownSubstrate = process.env["FED_SUBSTRATE_ID"] ?? "";
  const substrateOf = (vesselId: string): string => vesselId.split("@")[1] ?? "";

  const byPeer = new Map<string, DiscoveredVessel[]>();
  for (const v of rows) {
    const ma = Array.isArray(v.libp2p_multiaddr) ? v.libp2p_multiaddr[0] : undefined;
    if (typeof ma !== "string" || ma.length === 0) continue;
    const sub = substrateOf(String(v.vesselId ?? ""));
    // No suffix means the row names no substrate and cannot be targeted; our own id is the
    // loop-back this module exists to prevent.
    if (!sub || (ownSubstrate && sub === ownSubstrate)) continue;
    const list = byPeer.get(sub) ?? [];
    list.push(v);
    byPeer.set(sub, list);
  }
  for (const list of byPeer.values()) list.sort((a, b) => (b.health_score ?? 0) - (a.health_score ?? 0));

  const urlFor = (v: DiscoveredVessel): string => {
    const base = String(v.vesselId ?? "").split("@")[0] ?? "";
    const ma = (v.libp2p_multiaddr ?? [])[0] ?? "";
    if (!base || !ma) return "";
    return `${fedTransportEgress.replace(/\/$/, "")}/egress/resolve?target=${encodeURIComponent(ma)}&vessel=${encodeURIComponent(base)}`;
  };

  // Peers themselves are ordered by their BEST arm, so health still governs which peer is
  // tried first; round-robin governs only that no peer monopolises the front of the list.
  const peers = [...byPeer.values()].sort(
    (a, b) => (b[0]?.health_score ?? 0) - (a[0]?.health_score ?? 0),
  );
  const depth = Math.max(0, ...peers.map((l) => l.length));
  const out: string[] = [];
  for (let round = 0; round < depth; round++) {
    for (const list of peers) {
      const v = list[round];
      if (!v) continue;
      const u = urlFor(v);
      if (u && !out.includes(u)) out.push(u);
    }
  }
  return out;
}
