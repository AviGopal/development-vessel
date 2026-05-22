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
  for (const template of SEED_TEMPLATES) {
    try {
      const result = await resolveActivityCreateVariant({
        type: "activity_create_variant",
        template,
      });
      const variantId = (result.body as { variantId: string }).variantId;
      results.push({ name: (template as { name?: string }).name ?? template.id, variantId });
      console.log(`  ✓ ${(template as { name?: string }).name ?? template.id} → ${variantId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${(template as { name?: string }).name ?? template.id}: ${msg}`);
    }
  }
  console.log(JSON.stringify({ seed_results: results }, null, 2));
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

async function runActivity(activityId: string, vars: Record<string, string>): Promise<void> {
  const { resolveActivityFetch } = await import("./resolvers/activity-fetch.js");
  const fetchResult = await resolveActivityFetch({ type: "activity_fetch", templateId: activityId });
  if (fetchResult.shape !== "activity_template") {
    console.error(JSON.stringify(fetchResult, null, 2));
    process.exit(1);
  }

  const template = fetchResult.body as { tasks?: Array<{ id: string; resolver: string; config?: Record<string, unknown> }> };
  const tasks = template.tasks ?? [];
  const taskResults: Array<{ taskId: string; result: unknown }> = [];

  for (const task of tasks) {
    const config = (interpolateVars(task.config ?? {}, vars) as Record<string, unknown>);
    config["type"] = task.resolver;
    const result = await resolveDispatch(config as { type: string } & Record<string, unknown>);
    taskResults.push({ taskId: task.id, result });
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
    default: {
      console.error(`Unknown verb: ${verb ?? "(none)"}`);
      console.error("Verbs: seed-templates | call-resolver <type> [--data '{...}'] | run-activity <id> [--var key=val ...]");
      process.exit(1);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
