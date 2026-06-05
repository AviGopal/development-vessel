import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * validate-obsidian-vessel-interaction — full-stack self-test for obsidian-vessel.
 *
 * Drives obsidian-vessel over HTTP and observes the results to verify the plugin
 * is working and identify missing capabilities. The substrate cannot introspect
 * Obsidian's renderer directly; this template exercises the vessel's external
 * surface from inside the substrate container and synthesizes a structured report.
 *
 * Five-task interaction loop:
 *   Task 1 (check_health): GET /health — confirms the vessel is reachable and
 *     responding. If port 27183 is unreachable (Obsidian not running), this task
 *     returns a connection-refused error; the LLM synthesis task still runs and
 *     reports "Obsidian not running" as its primary finding.
 *   Task 2 (check_status): GET /observations/status — retrieves the vault sync
 *     status. This endpoint may not yet exist; a 404 is noted as a missing
 *     capability rather than a failure.
 *   Task 3 (trigger_sync): POST /actions/sync — initiates a vault sync cycle.
 *     This endpoint may not yet exist; a 404 is noted accordingly.
 *   Task 4 (check_concept_status): GET /observations/concept-status — retrieves
 *     concept-graph coverage metrics (total notes, withEdges, avgRelevance). This
 *     endpoint may not yet exist.
 *   Task 5 (synthesize_report): LLM receives all four prior task outputs and
 *     produces a structured obsidianVesselInteractionReport with:
 *       { healthy, missing_endpoints, concept_coverage, missing_capabilities, recommendations }
 *
 * All http_fetch tasks use timeoutMs: 5000 to avoid hanging when Obsidian is closed.
 */

export const VALIDATE_OBSIDIAN_VESSEL_INTERACTION_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:validate-obsidian-vessel-interaction",
  name: "validate-obsidian-vessel-interaction",
  description:
    "Full-stack self-test for obsidian-vessel. Drives the plugin over HTTP " +
    "(GET /health, GET /observations/status, POST /actions/sync, " +
    "GET /observations/concept-status) and synthesizes a structured " +
    "obsidianVesselInteractionReport identifying which endpoints are live, " +
    "which are missing (404), concept-graph coverage metrics, and " +
    "recommendations for the next implementation step. Handles gracefully " +
    "when Obsidian is not running — health check failure routes to the LLM " +
    "synthesizer which reports the vessel as unreachable.",
  inputShapes: [],
  outputShapes: ["obsidianVesselInteractionReport"],
  tags: ["obsidian-vessel", "validation", "self-test", "interaction"],
  variables: [],
  tasks: [
    {
      id: "check_health",
      description:
        "GET http://127.0.0.1:27183/health to confirm obsidian-vessel is running " +
        "and responsive. Uses a 5-second timeout so a closed Obsidian window " +
        "produces a clear connection-refused error rather than a hang. The " +
        "response body (or error text) is forwarded as obsidianVesselHealth to " +
        "the synthesizer. A connection failure here is expected when Obsidian is " +
        "not open; the remaining tasks still execute and the synthesizer reports " +
        "'Obsidian not running' as the primary finding.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "GET",
        url: "http://127.0.0.1:27183/health",
        headers: { Accept: "application/json" },
        timeoutMs: 5000,
      },
      outputShapes: ["obsidianVesselHealth"],
    },
    {
      id: "check_status",
      description:
        "GET http://127.0.0.1:27183/observations/status to retrieve the current " +
        "vault sync status from obsidian-vessel. This endpoint is being added in " +
        "parallel with this template; a 404 response indicates it has not yet been " +
        "implemented. The response body (HTTP status + body, or error text) is " +
        "forwarded as obsidianVesselStatus to the synthesizer, which records the " +
        "endpoint as missing_endpoint if 404.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "GET",
        url: "http://127.0.0.1:27183/observations/status",
        headers: { Accept: "application/json" },
        timeoutMs: 5000,
      },
      outputShapes: ["obsidianVesselStatus"],
    },
    {
      id: "trigger_sync",
      description:
        "POST http://127.0.0.1:27183/actions/sync with an empty body to trigger " +
        "a vault sync cycle. This endpoint is being added in parallel with this " +
        "template; a 404 response indicates it has not yet been implemented. The " +
        "response (HTTP status + body, or error text) is forwarded as " +
        "obsidianSyncResult to the synthesizer.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "POST",
        url: "http://127.0.0.1:27183/actions/sync",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({}),
        timeoutMs: 5000,
      },
      outputShapes: ["obsidianSyncResult"],
    },
    {
      id: "check_concept_status",
      description:
        "GET http://127.0.0.1:27183/observations/concept-status to retrieve " +
        "concept-graph coverage metrics: total notes, how many have edges in the " +
        "concept graph, and average relevance score. This endpoint is being added " +
        "in parallel with this template; a 404 response indicates it has not yet " +
        "been implemented. The response (HTTP status + body, or error text) is " +
        "forwarded as obsidianConceptStatus to the synthesizer.",
      resolver: "http_fetch",
      config: {
        type: "http_fetch",
        method: "GET",
        url: "http://127.0.0.1:27183/observations/concept-status",
        headers: { Accept: "application/json" },
        timeoutMs: 5000,
      },
      outputShapes: ["obsidianConceptStatus"],
    },
    {
      id: "synthesize_report",
      description:
        "Receive the four HTTP probe results and synthesize a structured " +
        "obsidianVesselInteractionReport. Assesses health, records which " +
        "endpoints returned 404 (missing_endpoints), extracts concept-graph " +
        "coverage metrics, lists missing_capabilities, and proposes " +
        "recommendations ordered by priority. Output is a single JSON object.",
      resolver: "llm",
      prompt: {
        template:
          "You are a substrate self-test synthesizer evaluating obsidian-vessel's " +
          "external HTTP surface.\n\n" +
          "obsidian-vessel runs inside Obsidian on port 27183 and exposes:\n" +
          "  - GET  /health                      — always present when running\n" +
          "  - GET  /manifest                    — capability advertisement\n" +
          "  - POST /resolve                     — impulse resolution\n" +
          "  - GET  /observations/status         — vault sync status (may be 404)\n" +
          "  - GET  /observations/concept-status — concept-graph coverage (may be 404)\n" +
          "  - POST /actions/sync                — trigger vault sync (may be 404)\n" +
          "  - POST /actions/rebuild             — rebuild concept graph (may be 404)\n" +
          "  - POST /actions/open-note           — open a note in Obsidian (may be 404)\n\n" +
          "## Health probe result\n\n" +
          "{{check_health_content}}\n\n" +
          "## /observations/status probe result\n\n" +
          "{{check_status_content}}\n\n" +
          "## /actions/sync probe result\n\n" +
          "{{trigger_sync_content}}\n\n" +
          "## /observations/concept-status probe result\n\n" +
          "{{check_concept_status_content}}\n\n" +
          "## Instructions\n\n" +
          "1. Assess whether obsidian-vessel is running and healthy:\n" +
          "   - If the health probe shows a connection error (ECONNREFUSED, timeout, or " +
          "     similar), set healthy=false and note 'Obsidian not running' as the primary " +
          "     finding. The remaining assessment still applies to what was probed.\n" +
          "   - If the health probe returned HTTP 200, set healthy=true.\n\n" +
          "2. Identify missing endpoints: for each of the four probed endpoints " +
          "   (/observations/status, /actions/sync, /observations/concept-status, " +
          "   and implicitly /actions/rebuild and /actions/open-note), record the endpoint " +
          "   path in missing_endpoints if the response was a 404 or a connection error " +
          "   that is specifically endpoint-absence rather than vessel-absence.\n\n" +
          "3. Extract concept coverage from /observations/concept-status:\n" +
          "   - If the endpoint returned a valid JSON body, extract total, withEdges, " +
          "     and avgRelevance. Set concept_coverage accordingly.\n" +
          "   - If the endpoint returned 404 or an error, set concept_coverage to " +
          "     {total: null, withEdges: null, avgRelevance: null}.\n\n" +
          "4. Identify missing_capabilities: capabilities that obsidian-vessel should " +
          "   provide but are not yet reachable based on the probe results. " +
          "   Examples: 'vault sync trigger', 'concept coverage query', 'rebuild graph'.\n\n" +
          "5. Produce recommendations ordered by priority (most impactful first). " +
          "   Each recommendation should reference a specific endpoint path or code change.\n\n" +
          "Output ONLY the JSON object below — no fences, no prose:\n\n" +
          "{\n" +
          "  \"healthy\": <boolean>,\n" +
          "  \"missing_endpoints\": [\"<endpoint path>\"],\n" +
          "  \"concept_coverage\": {\n" +
          "    \"total\": <number | null>,\n" +
          "    \"withEdges\": <number | null>,\n" +
          "    \"avgRelevance\": <number | null>\n" +
          "  },\n" +
          "  \"missing_capabilities\": [\"<capability description>\"],\n" +
          "  \"recommendations\": [\"<actionable recommendation>\"]\n" +
          "}",
      },
      outputShapes: ["obsidianVesselInteractionReport"],
    },
  ],
};
