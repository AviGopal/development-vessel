import { Hono } from "hono";
import { resolveGitStatus } from "../resolvers/git-status.js";
import { resolveGitAdd } from "../resolvers/git-add.js";
import { resolveGitCommit } from "../resolvers/git-commit.js";
import { resolveGitDiff } from "../resolvers/git-diff.js";
import { resolveGitLog } from "../resolvers/git-log.js";
import { resolveFsRead } from "../resolvers/fs-read.js";
import { resolveFsWrite } from "../resolvers/fs-write.js";
import { resolveFsEdit } from "../resolvers/fs-edit.js";
import { resolveActivityFetch } from "../resolvers/activity-fetch.js";
import { resolveActivityCreateVariant } from "../resolvers/activity-create-variant.js";
import { resolveVesselRegisterPassthrough } from "../resolvers/vessel-register-passthrough.js";
import { resolveCodeIntrospect } from "../resolvers/code-introspect.js";
import { resolvePropagateJudgment } from "../resolvers/propagate-judgment.js";

export const impulsesRouter = new Hono();

impulsesRouter.post("/v2/impulses/resolve", async (c) => {
  let body: { impulse?: { type?: string; pointer?: { type?: string } } };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "invalid JSON body" }, 400);
  }

  const pointer = body?.impulse?.pointer ?? body?.impulse;
  const pointerType = pointer?.type ?? body?.impulse?.type;

  if (!pointerType) {
    return c.json({ success: false, error: "pointer.type is required" }, 400);
  }

  try {
    let result: { shape: string; body: unknown };
    switch (pointerType) {
      case "git_status":
        result = await resolveGitStatus(pointer as Parameters<typeof resolveGitStatus>[0]);
        break;
      case "git_add":
        result = await resolveGitAdd(pointer as Parameters<typeof resolveGitAdd>[0]);
        break;
      case "git_commit":
        result = await resolveGitCommit(pointer as Parameters<typeof resolveGitCommit>[0]);
        break;
      case "git_diff":
        result = await resolveGitDiff(pointer as Parameters<typeof resolveGitDiff>[0]);
        break;
      case "git_log":
        result = await resolveGitLog(pointer as Parameters<typeof resolveGitLog>[0]);
        break;
      case "fs_read":
        result = await resolveFsRead(pointer as Parameters<typeof resolveFsRead>[0]);
        break;
      case "fs_write":
        result = await resolveFsWrite(pointer as Parameters<typeof resolveFsWrite>[0]);
        break;
      case "fs_edit":
        result = await resolveFsEdit(pointer as Parameters<typeof resolveFsEdit>[0]);
        break;
      case "activity_fetch":
        result = await resolveActivityFetch(pointer as Parameters<typeof resolveActivityFetch>[0]);
        break;
      case "activity_create_variant":
        result = await resolveActivityCreateVariant(pointer as Parameters<typeof resolveActivityCreateVariant>[0]);
        break;
      case "vessel_register_passthrough":
        result = await resolveVesselRegisterPassthrough(pointer as Parameters<typeof resolveVesselRegisterPassthrough>[0]);
        break;
      case "code_introspect":
        result = await resolveCodeIntrospect(pointer as Parameters<typeof resolveCodeIntrospect>[0]);
        break;
      case "propagate_judgment":
        result = await resolvePropagateJudgment(pointer as Parameters<typeof resolvePropagateJudgment>[0]);
        break;
      default:
        return c.json({ success: false, error: `unknown shape: ${pointerType}` }, 400);
    }
    return c.json({ success: true, shape: result.shape, body: result.body });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, error: message }, 500);
  }
});
