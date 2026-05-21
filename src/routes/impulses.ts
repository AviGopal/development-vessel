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
import type { ResolverResult } from "../resolvers/types.js";

type AnyPointer = { type: string } & Record<string, unknown>;

/** Shared dispatch logic — used by both the HTTP route and the CLI. */
export async function resolveDispatch(pointer: AnyPointer): Promise<ResolverResult> {
  const p = pointer as unknown;
  switch (pointer.type) {
    case "git_status":
      return resolveGitStatus(p as Parameters<typeof resolveGitStatus>[0]);
    case "git_add":
      return resolveGitAdd(p as Parameters<typeof resolveGitAdd>[0]);
    case "git_commit":
      return resolveGitCommit(p as Parameters<typeof resolveGitCommit>[0]);
    case "git_diff":
      return resolveGitDiff(p as Parameters<typeof resolveGitDiff>[0]);
    case "git_log":
      return resolveGitLog(p as Parameters<typeof resolveGitLog>[0]);
    case "fs_read":
      return resolveFsRead(p as Parameters<typeof resolveFsRead>[0]);
    case "fs_write":
      return resolveFsWrite(p as Parameters<typeof resolveFsWrite>[0]);
    case "fs_edit":
      return resolveFsEdit(p as Parameters<typeof resolveFsEdit>[0]);
    case "activity_fetch":
      return resolveActivityFetch(p as Parameters<typeof resolveActivityFetch>[0]);
    case "activity_create_variant":
      return resolveActivityCreateVariant(p as Parameters<typeof resolveActivityCreateVariant>[0]);
    case "vessel_register_passthrough":
      return resolveVesselRegisterPassthrough(p as Parameters<typeof resolveVesselRegisterPassthrough>[0]);
    case "code_introspect":
      return resolveCodeIntrospect(p as Parameters<typeof resolveCodeIntrospect>[0]);
    case "propagate_judgment":
      return resolvePropagateJudgment(p as Parameters<typeof resolvePropagateJudgment>[0]);
    default:
      throw new Error(`unknown shape: ${pointer.type}`);
  }
}

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
    const result = await resolveDispatch({ ...(pointer as Record<string, unknown>), type: pointerType });
    return c.json({ success: true, shape: result.shape, body: result.body });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("unknown shape:")) {
      return c.json({ success: false, error: message }, 400);
    }
    return c.json({ success: false, error: message }, 500);
  }
});
