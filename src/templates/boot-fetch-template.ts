import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

/**
 * boot-fetch-template — the only ActivityTemplate that lives in vessel code.
 *
 * All other templates are stored in activity-api and fetched at runtime.
 * This one is irreducible: it is the template used to FETCH templates.
 * Without it, the vessel has no way to bootstrap itself.
 *
 * Shape contract:
 *   input:  templateId (string, carried as a variable interpolated into config)
 *   output: activityTemplate
 */
export const BOOT_FETCH_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:boot-fetch-template",
  name: "boot-fetch-template",
  description: "Fetch a single activity template by id from activity-api.",
  inputShapes: ["templateId"],
  outputShapes: ["activityTemplate"],
  tags: ["bootstrap", "fetch"],
  tasks: [
    {
      id: "fetch-template",
      description: "Fetch the target template from activity-api by id.",
      resolver: "activity_fetch",
      inputShapes: ["templateId"],
      outputShapes: ["activityTemplate"],
      config: {
        templateId: "{{templateId}}",
      },
    },
  ],
};
