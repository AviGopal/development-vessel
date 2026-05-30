#!/usr/bin/env bun
/**
 * development-vessel CLI
 *
 * Verbs:
 *   seed-templates          Upload all bootstrap activity templates to activity-api.
 *   call-resolver <type>    Invoke a single resolver with JSON payload from stdin or --data.
 *   run-activity <id>       Fetch template and execute each task sequentially. --var key=val interpolates {{key}}.
 */

import { resolveDispatch } from "./routes/impulses.js";

async function seedTemplates(): Promise<void> {
  // Lazy import so the CLI can boot without §5 seed files during early phases
  const { SEED_TEMPLATES } = await import("./seed/index.js");
  const { resolveActivityCreateVariant } = await import("./resolvers/activity-create-variant.js");
  console.log(`Uploading ${SEED_TEMPLATES.length} bootstrap templates...`);
  const results: Array<{ name: string; variantId: string }> = [];
  const failures: Array<{ name: string; detail: string }> = [];
  for (const template of SEED_TEMPLATES) {
    const label = (template as { name?: string }).name ?? template.id;
    try {
      // Seed templates are operator-authored starting points — always active (proposed=false).
      // Pass the template with proposed=false explicitly so ExecStartPost restarts don't
      // reset all seed templates to proposed=true via the substrate-authoring path.
      // Also pass org_id explicitly: activity-api's POST /v2/activities/templates derives
      // org_id from JWT/session auth context, but the development-vessel API key path does
      // not populate session.org_id, so the SCHEMAFULL `org_id` field on the `activity`
      // table fails with "Found NONE for field org_id". Setting it in the body is the
      // documented workaround until auth-context derivation is fixed in activity-api.
      const seedTemplate = typeof template === "object" && template !== null
        ? { ...(template as Record<string, unknown>), proposed: false, org_id: "organizations:substrate" }
        : template;
      const result = await resolveActivityCreateVariant({
        type: "activity_create_variant",
        template: seedTemplate,
      });
      // Surface resolver-side failures rather than silently logging ✓ with undefined.
      // The resolver returns shape="structuredError" on non-2xx from activity-api
      // (auth failure, validation reject, schema error). Treat that as a failure.
      if (result.shape === "structuredError") {
        const detail = JSON.stringify(result.body);
        failures.push({ name: label, detail });
        console.error(`  ✗ ${label}: ${detail}`);
        continue;
      }
      const variantId = (result.body as { variantId?: string }).variantId;
      if (!variantId) {
        const detail = `resolver returned shape=${result.shape} without variantId: ${JSON.stringify(result.body).slice(0, 200)}`;
        failures.push({ name: label, detail });
        console.error(`  ✗ ${label}: ${detail}`);
        continue;
      }
      results.push({ name: label, variantId });
      console.log(`  ✓ ${label} → ${variantId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ name: label, detail: msg });
      console.error(`  ✗ ${label}: ${msg}`);
    }
  }
  console.log(JSON.stringify({ seed_results: results, seed_failures: failures }, null, 2));
  if (failures.length > 0) {
    console.error(`\n${failures.length} of ${SEED_TEMPLATES.length} seed templates failed to upload.`);
    process.exit(1);
  }
}

async function callResolver(pointerType: string, rawData: string): Promise<void> {
  let pointer: Record<string, unknown>;
  try {
    pointer = JSON.parse(rawData) as Record<string, unknown>;
  } catch {
    throw new Error(`--data must be valid JSON`);
  }
  pointer["type"] = pointerType;
  const result = await resolveDispatch(pointer as { type: string } & Record<string, unknown>);
  console.log(JSON.stringify(result, null, 2));
}

function interpolateVars(obj: unknown, vars: Record<string, string>): unknown {
  if (typeof obj === "string") {
    // If the entire string is one {{var}}, return the var value and JSON-parse if valid.
    // This allows array vars like paths='["a.ts","b.ts"]' to become actual arrays.
    const exact = /^\{\{(\w+)\}\}$/.exec(obj);
    if (exact) {
      const val = vars[exact[1]!];
      if (val === undefined) return obj;
      try { return JSON.parse(val); } catch { return val; }
    }
    return obj.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? `{{${k}}}`);
  }
  if (Array.isArray(obj)) return obj.map((v) => interpolateVars(v, vars));
  if (obj && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, interpolateVars(v, vars)])
    );
  }
  return obj;
}

async function runActivity(activityId: string, vars: Record<string, string>, localTemplate?: unknown): Promise<void> {
  let templateBody: unknown;
  if (localTemplate !== undefined) {
    templateBody = localTemplate;
  } else {
    const { resolveActivityFetch } = await import("./resolvers/activity-fetch.js");
    const fetchResult = await resolveActivityFetch({ type: "activity_fetch", templateId: activityId });
    if (fetchResult.shape !== "activity_template") {
      console.error(JSON.stringify(fetchResult, null, 2));
      process.exit(1);
    }
    templateBody = fetchResult.body;
  }

  const template = templateBody as { tasks?: Array<{ id: string; resolver: string; config?: Record<string, unknown> }> };
  const tasks = template.tasks ?? [];
  const taskResults: Array<{ taskId: string; result: unknown }> = [];

  for (const task of tasks) {
    const config = (interpolateVars(task.config ?? {}, vars) as Record<string, unknown>);
    config["type"] = task.resolver;
    const result = await resolveDispatch(config as { type: string } & Record<string, unknown>);
    taskResults.push({ taskId: task.id, result });
    // Propagate task result body as a variable for subsequent tasks.
    const body = (result as { shape?: string; body?: unknown }).body;
    if (body !== undefined) {
      vars[task.id] = typeof body === "string" ? body : JSON.stringify(body);
      if (body && typeof body === "object") {
        for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
          if (typeof v === "string") {
            vars[`${task.id}_${k}`] = v;
            // Canonical aliases for backward compat with older templates.
            if (task.id === "read_scenario" && k === "content") vars["scenario_json"] = v;
            // llm_completion_result: expose stripped text as draft_via_llm_result.
            if (task.id === "draft_via_llm" && k === "text") {
              vars["draft_via_llm_result"] = v.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();
            }
          }
        }
      }
    }
  }

  console.log(JSON.stringify({ activityId, taskResults }, null, 2));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const verb = args[0];

  switch (verb) {
    case "seed-templates": {
      await seedTemplates();
      break;
    }
    case "call-resolver": {
      const resolverType = args[1];
      if (!resolverType) {
        console.error("Usage: call-resolver <type> [--data '{...}']");
        process.exit(1);
      }
      const dataFlag = args.indexOf("--data");
      const rawData = dataFlag !== -1 && args[dataFlag + 1] ? args[dataFlag + 1]! : "{}";
      await callResolver(resolverType, rawData);
      break;
    }
    case "run-activity": {
      const activityId = args[1];
      if (!activityId) {
        console.error("Usage: run-activity <id> [--var key=value ...]");
        process.exit(1);
      }
      const vars: Record<string, string> = { cwd: process.cwd() };
      for (let i = 2; i < args.length - 1; i++) {
        if (args[i] === "--var" && args[i + 1]) {
          const [k, ...rest] = (args[i + 1]!).split("=");
          if (k) vars[k] = rest.join("=");
          i++;
        }
      }
      await runActivity(activityId, vars);
      break;
    }
    case "run-local-seed": {
      // Run a seed template directly from the in-memory seed registry — bypasses activity-api
      // fetch so the latest local template is always used (useful during bootstrap).
      const seedId = args[1];
      if (!seedId) {
        console.error("Usage: run-local-seed <seed-id> [--var key=value ...]");
        process.exit(1);
      }
      const { SEED_TEMPLATES } = await import("./seed/index.js");
      const seedTemplate = SEED_TEMPLATES.find(
        (t) => (t as { id?: string }).id === seedId || (t as { name?: string }).name === seedId,
      );
      if (!seedTemplate) {
        console.error(`Seed template not found: ${seedId}`);
        console.error(`Available: ${SEED_TEMPLATES.map((t) => (t as { id?: string }).id ?? (t as { name?: string }).name).join(", ")}`);
        process.exit(1);
      }
      const localVars: Record<string, string> = { cwd: process.cwd() };
      for (let i = 2; i < args.length - 1; i++) {
        if (args[i] === "--var" && args[i + 1]) {
          const [k, ...rest] = (args[i + 1]!).split("=");
          if (k) localVars[k] = rest.join("=");
          i++;
        }
      }
      await runActivity(seedId, localVars, seedTemplate);
      break;
    }
    default: {
      console.error(`Unknown verb: ${verb ?? "(none)"}`);
      console.error("Verbs: seed-templates | call-resolver <type> [--data '{...}'] | run-activity <id> [--var key=val ...] | run-local-seed <seed-id> [--var key=val ...]");
      process.exit(1);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
