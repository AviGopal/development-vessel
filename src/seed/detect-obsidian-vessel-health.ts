import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * detect-obsidian-vessel-health — autonomous connectivity detector for
 * obsidian-vessel anti-patterns that are invisible from substrate logs.
 *
 * The substrate cannot read Obsidian's DevTools console, so CORS failures
 * and WebSocket URL construction errors are silent from the outside: the
 * plugin appears to load, but registration with discovery never arrives.
 * This template detects the bug class from observable external signals:
 *
 *   1. **CORS anti-pattern**: `await fetch(` calls in vessel-client.ts target
 *      the activity-api origin from inside the Obsidian renderer (a different
 *      origin). The fix is `requestUrl` from the `obsidian` package, which
 *      proxies through the Electron main process and bypasses CORS. If the
 *      plugin sends `fetch(` directly, the browser rejects the request before
 *      it leaves the host — the substrate sees no inbound call and no trace.
 *
 *   2. **WebSocket URL doubling**: construction patterns of the form
 *      `endpoint + '/ws'` applied to a base URL that already ends in `/ws`
 *      produce `…/ws/ws`. The handshake never completes; the plugin stays
 *      unregistered.
 *
 * Detection works from two cheap reads:
 *   - concept-db: query for known anti-pattern concepts to prime the LLM
 *     with accumulated substrate knowledge (source_type=extracted, terms
 *     cors+websocket+obsidian).
 *   - local-tools-vessel: read the first 100 lines of vessel-client.ts to
 *     inspect live plugin source without the Obsidian renderer being involved.
 *
 * Three tasks — mirrors detect-concept-db-drift's http_fetch + llm idiom:
 *   Task 1 (check_discovery_registry): GET concept-db priors → conceptPriors
 *   Task 2 (scan_plugin_source): read vessel-client.ts → pluginSourceSample
 *   Task 3 (diagnose_and_report): LLM synthesizes → obsidianVesselHealthReport
 *
 * Constitutional principle (concept_9ldsmRgqSTd5,
 * substrate_self_detection_principle): every observed bug class becomes a
 * detection template, not just a patched instance.
 */

export const DETECT_OBSIDIAN_VESSEL_HEALTH_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:detect-obsidian-vessel-health",
  name: "detect-obsidian-vessel-health",
  description:
    "Detects obsidian-vessel connectivity anti-patterns that are invisible " +
    "from substrate logs: (1) raw `fetch(` CORS calls that the Electron " +
    "renderer blocks before the request leaves the host — fix is `requestUrl` " +
    "from the obsidian package; (2) WebSocket URL doubling patterns like " +
    "`endpoint + '/ws'` applied to a URL that already ends in '/ws'. Reads " +
    "concept-db priors for accumulated substrate knowledge, samples the first " +
    "100 lines of vessel-client.ts via local-tools-vessel, and emits a " +
    "structured obsidianVesselHealthReport with cors_risk, ws_url_risk, " +
    "findings[], and recommended_fix. Detection only — no writes.",
  inputShapes: [],
  outputShapes: ["obsidianVesselHealthReport"],
  tags: [
    "obsidian-vessel",
    "detection",
    "connectivity",
    "substrate-health",
  ],
  variables: [],
  tasks: [
    {
      id: "check_discovery_registry",
      description:
        "Query concept-db for known obsidian CORS and WebSocket anti-pattern " +
        "concepts (source_type=extracted, terms: obsidian cors websocket, limit=5). " +
        "Returns accumulated substrate knowledge about this bug class to prime the " +
        "LLM synthesizer with prior evidence rather than starting cold.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "GET",
        url: "http://127.0.0.1:8260/concepts/search?source_type=extracted&query=obsidian+cors+websocket&limit=5",
        headers: { Accept: "application/json" },
      },
      outputShapes: ["conceptPriors"],
    },
    {
      id: "scan_plugin_source",
      description:
        "Read the first 100 lines of vessel-client.ts from the obsidian-vessel " +
        "source tree via local-tools-vessel's file resolver. Inspects live plugin " +
        "source without requiring the Obsidian renderer to be running. Returns the " +
        "raw file content as pluginSourceSample.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: "http://127.0.0.1:8230/resolve",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          impulse: {
            pointer: {
              type: "file",
              path: "/home/avi/documents/work/exp-repo/metabob-devbob/repos/obsidian-vessel/src/vessel-client.ts",
              limit: 100,
            },
          },
        }),
      },
      outputShapes: ["pluginSourceSample"],
    },
    {
      id: "diagnose_and_report",
      description:
        "Synthesize concept-db priors and live plugin source into a structured " +
        "obsidianVesselHealthReport. Flags CORS risk if the source contains raw " +
        "`await fetch(` calls and WebSocket URL risk if it constructs URLs with " +
        "`endpoint + '/ws'` without a guard. Produces a JSON report with " +
        "cors_risk, ws_url_risk, findings[], and recommended_fix. Output only JSON.",
      resolver: "llm",
      prompt: {
        template:
          "You are a substrate health auditor diagnosing obsidian-vessel connectivity failures.\n\n" +
          "The substrate cannot read Obsidian's DevTools console. Detection must work from " +
          "static source analysis alone. Two bug classes are in scope:\n\n" +
          "  1. CORS anti-pattern: raw `await fetch(` or `fetch(` calls inside vessel-client.ts " +
          "     target a different origin from the Obsidian renderer. The Electron browser blocks " +
          "     these before they reach the network. The fix is to replace `fetch(` with " +
          "     `requestUrl` imported from the `obsidian` package, which proxies through the " +
          "     Electron main process.\n\n" +
          "  2. WebSocket URL doubling: code that builds a WS URL via `endpoint + '/ws'` when " +
          "     `endpoint` may already end in `/ws` produces `…/ws/ws`. The handshake fails " +
          "     silently and the plugin never registers with discovery.\n\n" +
          "## Concept-db priors (accumulated substrate knowledge about this bug class)\n\n" +
          "{{check_discovery_registry_content}}\n\n" +
          "## Plugin source sample (first 100 lines of vessel-client.ts)\n\n" +
          "{{scan_plugin_source_content}}\n\n" +
          "## Instructions\n\n" +
          "1. Check if the source contains `await fetch(` or bare `fetch(` — if so, set " +
          "   cors_risk=true and add a finding.\n" +
          "2. Check for WebSocket URL construction patterns like `endpoint + '/ws'` or " +
          "   `\\`${endpoint}/ws\\`` without a guard that strips a trailing /ws first — if so, " +
          "   set ws_url_risk=true and add a finding.\n" +
          "3. Review the concept-db priors for any additional patterns they mention.\n" +
          "4. Set recommended_fix to the single most important action (prefer actionable " +
          "   one-liners referencing the obsidian package API where applicable).\n\n" +
          "Output ONLY the JSON object below — no fences, no prose:\n\n" +
          "{\n" +
          "  \"cors_risk\": <boolean>,\n" +
          "  \"ws_url_risk\": <boolean>,\n" +
          "  \"findings\": [\"<one sentence per finding, empty array if none>\"],\n" +
          "  \"recommended_fix\": \"<single most important fix, or 'no issues detected'>\"\n" +
          "}",
      },
      outputShapes: ["obsidianVesselHealthReport"],
    },
  ],
};
