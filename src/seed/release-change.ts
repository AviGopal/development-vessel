import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

export const RELEASE_CHANGE_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:release-change",
  name: "release-change",
  description: "Commit a change and immediately verify the resulting branch state.",
  inputShapes: ["cwd", "paths", "message"],
  outputShapes: ["commandResult"],
  tags: ["git", "ship", "audit"],
  variables: [
    { name: "cwd", description: "Repository working directory" },
    { name: "paths", description: "File paths to stage" },
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
      id: "git_status",
      description: "Assert working tree is clean after the commit.",
      resolver: "git_status",
      config: { type: "git_status", cwd: "{{cwd}}" },
      outputShapes: ["commandResult"],
    },
    {
      id: "git_log",
      description: "Capture the last 3 commits for audit evidence.",
      resolver: "git_log",
      config: { type: "git_log", cwd: "{{cwd}}", limit: 3 },
      outputShapes: ["commandResult"],
    },
  ],
};
