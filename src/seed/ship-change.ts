import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

export const SHIP_CHANGE_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:ship-change",
  name: "ship-change",
  description: "Stage and commit changed files using development-vessel git resolvers.",
  inputShapes: ["cwd", "paths", "message"],
  outputShapes: ["commandResult"],
  tags: ["git", "ship", "commit"],
  variables: [
    { name: "cwd", description: "Repository working directory" },
    { name: "paths", description: "File paths to stage (array of strings)" },
    { name: "message", description: "Git commit message" },
  ],
  tasks: [
    {
      id: "git_add",
      description: "Stage the requested paths.",
      resolver: "git_add",
      config: { type: "git_add", paths: "{{paths}}", cwd: "{{cwd}}" },
      outputShapes: ["commandResult"],
    },
    {
      id: "git_commit",
      description: "Commit with the provided message.",
      resolver: "git_commit",
      config: { type: "git_commit", message: "{{message}}", cwd: "{{cwd}}" },
      outputShapes: ["commandResult"],
    },
    {
      id: "git_log",
      description: "Capture the resulting commit sha.",
      resolver: "git_log",
      config: { type: "git_log", cwd: "{{cwd}}", limit: 1 },
      outputShapes: ["commandResult"],
    },
  ],
};
