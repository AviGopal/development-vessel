#!/usr/bin/env bun
/**
 * development-vessel CLI
 *
 * Verbs:
 *   seed-templates          Upload all bootstrap activity templates to activity-api.
 *   call-resolver <type>    Invoke a single resolver with JSON payload from stdin or --data.
 *   run-activity <id>       (stub — full impl after §5 seed lands)
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

async function runActivity(activityId: string): Promise<void> {
  // Full impl after §5 seed lands; for now just fetch the template to confirm connectivity
  const { resolveActivityFetch } = await import("./resolvers/activity-fetch.js");
  const result = await resolveActivityFetch({ type: "activity_fetch", templateId: activityId });
  console.log("Template fetched:");
  console.log(JSON.stringify(result.body, null, 2));
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
        console.error("Usage: run-activity <id>");
        process.exit(1);
      }
      await runActivity(activityId);
      break;
    }
    default: {
      console.error(`Unknown verb: ${verb ?? "(none)"}`);
      console.error("Verbs: seed-templates | call-resolver <type> [--data '{...}'] | run-activity <id>");
      process.exit(1);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
