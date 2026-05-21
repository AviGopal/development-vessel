import type { ActivityTemplate } from "@avigopal/ias-executor-ts";

export const ADD_RESOLVER_TO_VESSEL_TEMPLATE: ActivityTemplate = {
  id: "development-vessel:add-resolver-to-vessel",
  name: "add-resolver-to-vessel",
  description: "Read a source file, apply an edit to add a new resolver, then commit the result.",
  inputShapes: ["path", "oldString", "newString", "cwd", "message"],
  outputShapes: ["fileEditResult", "commandResult"],
  tags: ["fs", "git", "vessel", "modify"],
  variables: [
    { name: "path", description: "File path to edit (resolver source file)" },
    { name: "oldString", description: "Exact string to replace" },
    { name: "newString", description: "Replacement string" },
    { name: "cwd", description: "Repository working directory" },
    { name: "message", description: "Git commit message" },
  ],
  tasks: [
    {
      id: "fs_read",
      description: "Read the current resolver file for context.",
      resolver: "fs_read",
      config: { type: "fs_read", path: "{{path}}" },
      outputShapes: ["fileContent"],
    },
    {
      id: "fs_edit",
      description: "Apply the resolver edit (must match exactly once).",
      resolver: "fs_edit",
      config: { type: "fs_edit", path: "{{path}}", oldString: "{{oldString}}", newString: "{{newString}}" },
      outputShapes: ["fileEditResult"],
    },
    {
      id: "git_add",
      description: "Stage the edited resolver file.",
      resolver: "git_add",
      config: { type: "git_add", paths: ["{{path}}"], cwd: "{{cwd}}" },
      outputShapes: ["commandResult"],
    },
    {
      id: "git_commit",
      description: "Commit the new resolver.",
      resolver: "git_commit",
      config: { type: "git_commit", message: "{{message}}", cwd: "{{cwd}}" },
      outputShapes: ["commandResult"],
    },
  ],
};
