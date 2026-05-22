import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

export const RELEASE_AND_VALIDATE_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:release-and-validate",
  name: "release-and-validate",
  description:
    "Commit changes, validate branch health, and refresh vessel registration. Cross-vessel composition demonstrating ship-change + branch-health + discovery refresh.",
  inputShapes: ["cwd"],
  outputShapes: ["releaseValidatedReport"],
  tags: ["release", "validation", "git", "cross-vessel"],
  variables: [
    { name: "cwd", description: "Repository working directory" },
    { name: "message", description: "Commit message" },
    { name: "paths", description: "JSON array of paths to commit" },
    {
      name: "expectedHealthBranch",
      description: "Expected branch name after commit",
    },
  ],
  tasks: [
    {
      id: "ship_change",
      description: "Commit changes using the ship-change activity",
      resolver: "activity_fetch",
      config: {
        type: "activity_fetch",
        templateId: "development-vessel:ship-change",
      },
      outputShapes: ["activity_template"],
    },
    {
      id: "branch_health",
      description: "Validate branch health after commit",
      resolver: "activity_fetch",
      config: {
        type: "activity_fetch",
        templateId: "development-vessel:branch-health",
      },
      outputShapes: ["activity_template"],
    },
    {
      id: "refresh_registration",
      description: "Refresh vessel registration with discovery",
      resolver: "vessel_register_passthrough",
      config: {
        type: "vessel_register_passthrough",
        vesselId: "{{VESSEL_ID}}",
        shapes: [],
        resolverContract: {
          resolve_endpoint: "/v2/impulses/resolve",
          resolve_request_format: "pointer",
          auth_scheme: "ApiKey",
          resolve_timeout_ms: 10000,
        },
      },
      outputShapes: ["registrationResult"],
    },
  ],
};
