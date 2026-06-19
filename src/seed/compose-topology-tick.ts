import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

export const COMPOSE_TOPOLOGY_TICK_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:compose-topology-tick",
  name: "compose-topology-tick",
  description:
    "Boredom-driven topology exploration via activity composition: finds a reliably-" +
    "succeeding chainable pair of real capabilities (preferring leaf×leaf strict chains " +
    "that cross-link degree-1 pendants), authors a composite chaining them, and dispatches " +
    "it so an organic non-hub composition edge forms — raising the spectral-gap headroom " +
    "(λ₂·(1−star_ratio)) toward the 0.35 threshold that unlocks the native generative " +
    "frontier. Replaces the fixed-clock compose-teacher as the primary driver; rate scales " +
    "with sample throughput. Tagged intent:topology_discovery, phase:explore.",
  inputShapes: [],
  outputShapes: ["compositionTeachReport"],
  tags: ["intent:topology_discovery", "phase:explore", "topology.discovery.loop", "composition"],
  variables: [
    { name: "max_composites", description: "Cap on distinct composites before shifting to reinforcement (default 40)." },
  ],
  tasks: [
    {
      id: "compose_topology",
      description:
        "Invoke compose_topology_tick resolver: discover a chainable capability pair, author + " +
        "dispatch a composite, and emit compositionTeachReport with the becoming metrics.",
      resolver: "development-vessel:compose_topology_tick",
      config: { type: "compose_topology_tick", max_composites: 40 },
      outputShapes: ["compositionTeachReport"],
    },
  ],
};
