import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * detect-service-oom-cascade — deterministic detector for the service-level
 * OOM cascade bug class (concept_RYl73llSCGfc / concept_6RwK5H5F28hT /
 * concept_s9ye5GKLw2L8 / concept_T-CTTOEl97IM).
 *
 * The cascade: a vessel accumulates in-flight bus-forward / promise work
 * without backpressure, cgroup OOM-killer fires, systemd restarts the unit,
 * the cycle repeats. Seven hunt iterations without resolution because the
 * substrate had no first-class detector — restarts and memory growth were
 * only ever surfaced by operator-side `journalctl` / `systemctl show`.
 *
 * Detection signature (any one of three thresholds):
 *   - NRestarts delta > 3 since last scan
 *   - MemoryCurrent > 4 GB absolute
 *   - MemoryCurrent delta > 500 MB since last scan
 *
 * Why this template is structurally safe from the bug class (immunity
 * pattern siblings: concept_Y2zGpFNBrcgb, concept_pFSLV6s5s3lQ,
 * concept_t2jHO8I-LxD3):
 *   - inputShapes is empty. Nothing to pre-flight-reject.
 *   - variables is empty. No caller is required to seed specific values.
 *   - Single task dispatching a single server-side resolver
 *     (service_oom_cascade_scan) — no LLM, no iteration, no template-var
 *     interpolation. The resolver does scan + group + post all in-process.
 *
 * Cache lives at WORKSPACE_ROOT/.oom-detector/state.json. First-run
 * findings are restricted to absolute thresholds (delta needs a baseline).
 *
 * Constitutional principle: every observed bug class becomes a detection
 * template, not just a patched instance (concept_9ldsmRgqSTd5).
 */

export const DETECT_SERVICE_OOM_CASCADE_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:detect-service-oom-cascade",
  name: "detect-service-oom-cascade",
  description:
    "Scans systemd-tracked vessel services inside substrate-live for the " +
    "OOM cascade signature (rapid restart loop, single-process memory > 4GB, " +
    "or > 500MB growth since the previous scan). Groups by service and emits " +
    "one substrateGap_write impulse per affected service with structured " +
    "evidence (restarts_since_last, memory_mb, delta_mb). Deterministic " +
    "detector (no LLM); resolver collapses systemctl-show + parse + " +
    "threshold-check + emit into a single server-side step. The detector " +
    "itself is structurally immune to the bug class it catches — empty " +
    "inputShapes and empty variables block the pre-flight rejection path " +
    "that produced the class in the first place.",
  inputShapes: [],
  outputShapes: ["substrateGap", "serviceOomReport"],
  tags: [
    "lift.autonomous.loop",
    "substrate.self.detection",
    "failure.mode.detection",
    "oom.cascade",
  ],
  variables: [],
  tasks: [
    {
      id: "scan_and_emit",
      description:
        "Run systemctl-show across the substrate's vessel services, compare " +
        "against a cached baseline, classify findings by three thresholds " +
        "(restart-delta, memory-absolute, memory-delta), and emit one " +
        "substrateGap per service that crossed any threshold. Returns a " +
        "serviceOomReport with scanned / services_with_findings / emitted " +
        "counts and per-service evidence.",
      resolver: "service_oom_cascade_scan",
      config: {
        type: "service_oom_cascade_scan",
        dry_run: false,
        maxEmits: 20,
      },
      outputShapes: ["serviceOomReport"],
    },
  ],
};
