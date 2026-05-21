import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

export const BRANCH_HEALTH_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:branch-health",
  name: "branch-health",
  description: "Probe working-tree state and recent commits; emit a branch health snapshot.",
  inputShapes: ["cwd"],
  outputShapes: ["commandResult"],
  tags: ["git", "health", "audit"],
  variables: [
    { name: "cwd", description: "Repository working directory" },
  ],
  tasks: [
    {
      id: "git_status",
      description: "Capture working-tree changes (porcelain).",
      resolver: "git_status",
      config: { type: "git_status", cwd: "{{cwd}}" },
      outputShapes: ["commandResult"],
    },
    {
      id: "git_diff",
      description: "Capture cumulative diff stat vs HEAD.",
      resolver: "git_diff",
      config: { type: "git_diff", cwd: "{{cwd}}", stat: true },
      outputShapes: ["commandResult"],
    },
    {
      id: "git_log",
      description: "Capture the last 5 commit subjects.",
      resolver: "git_log",
      config: { type: "git_log", cwd: "{{cwd}}", limit: 5 },
      outputShapes: ["commandResult"],
    },
  ],
};
