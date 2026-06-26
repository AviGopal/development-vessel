import { writeFile, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import type { ResolverResult } from "./types.js";

/**
 * activate_substrate_script (2026-06-26) — SELF-ACTIVATION primitive.
 *
 * The substrate's timer units (scripts/substrate/*.ts) historically ran
 * directly from the read-only, stale-after-mount host bind path
 * (/home/.../scripts/substrate/<name>.ts). A Docker-Desktop bind only
 * refreshes on a full container restart, so a substrate-authored new version
 * of a timer script could NOT take effect without an operator
 * `docker restart` — the autonomy loop's authored output never went live.
 *
 * The fix is a writable run-dir on the substrate-workspace volume
 * (/workspace/active-scripts/), seeded fresh from the bind at every boot by
 * substrate-active-scripts-seed.service, and a repointed unit ExecStart that
 * runs the script from the run-dir. This resolver is the write half: any
 * self-dev authoring flow that produces a new script version calls it with
 * { script, content } to overwrite the run-dir copy, and the change is live
 * on the NEXT timer firing — no restart.
 *
 * Path safety (a substrate-callable resolver that writes executable timer
 * source is high blast-radius — guard hard):
 *   - `script` is reduced to its basename (no path traversal, no leading /).
 *   - must end in `.ts`.
 *   - the target file MUST already exist in the run-dir. We never create a new
 *     file: the run-dir is the seeded known-script set, so activation can only
 *     REPLACE the content of an existing timer script, never introduce an
 *     arbitrary new executable.
 *   - optional `base_sha` guard: if supplied, the current run-dir content's
 *     sha256 must match before we overwrite (optimistic-concurrency / stale-
 *     author protection). Mismatch → refused, nothing written.
 */

const DEFAULT_RUN_DIR = "/workspace/active-scripts";

export interface ActivateSubstrateScriptPointer {
  type: "activate_substrate_script";
  /** Basename of the timer script, e.g. "compose-teacher.ts". */
  script?: string;
  /** Full TypeScript source to make live. */
  content?: string;
  /** Optional sha256 of the CURRENT run-dir content; overwrite only if it matches. */
  base_sha?: string;
  /** Override run-dir (tests). Default /workspace/active-scripts. */
  runDir?: string;
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

export async function resolveActivateSubstrateScript(
  pointer: ActivateSubstrateScriptPointer,
): Promise<ResolverResult> {
  const runDir = pointer.runDir ?? DEFAULT_RUN_DIR;
  const rawScript = pointer.script;
  const content = pointer.content;

  // --- input validation -------------------------------------------------
  if (typeof rawScript !== "string" || !rawScript.trim()) {
    return {
      shape: "structuredError",
      body: { error: "script (basename, *.ts) is required", activated: false },
    };
  }
  if (typeof content !== "string") {
    return {
      shape: "structuredError",
      body: { error: "content (full TS source string) is required", activated: false },
    };
  }

  // --- path safety: basename only, must end .ts -------------------------
  const name = basename(rawScript);
  if (name !== rawScript || name.includes("/") || name.includes("\\") || name.startsWith(".")) {
    return {
      shape: "structuredError",
      body: { error: `path traversal / non-basename script rejected: ${rawScript}`, activated: false },
    };
  }
  if (!name.endsWith(".ts")) {
    return {
      shape: "structuredError",
      body: { error: `script must end in .ts: ${name}`, activated: false },
    };
  }

  const target = join(runDir, name);

  // --- existence gate: only REPLACE a known seeded script ---------------
  let prevContent: string;
  try {
    const st = await stat(target);
    if (!st.isFile()) {
      return {
        shape: "structuredError",
        body: { error: `target is not a regular file: ${target}`, activated: false },
      };
    }
    prevContent = await readFile(target, "utf-8");
  } catch {
    return {
      shape: "structuredError",
      body: {
        error:
          `script not present in run-dir (${target}) — activation only replaces ` +
          `an existing seeded timer script, it never creates new executables`,
        activated: false,
      },
    };
  }

  // --- optional base_sha optimistic-concurrency guard -------------------
  if (typeof pointer.base_sha === "string" && pointer.base_sha) {
    const cur = sha256(prevContent);
    if (cur !== pointer.base_sha) {
      return {
        shape: "structuredError",
        body: {
          error: "base_sha mismatch — run-dir content changed since author read it",
          activated: false,
          script: name,
          expected_base_sha: pointer.base_sha,
          actual_base_sha: cur,
        },
      };
    }
  }

  // --- write ------------------------------------------------------------
  try {
    await writeFile(target, content, "utf-8");
  } catch (err) {
    return {
      shape: "structuredError",
      body: {
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
        activated: false,
        script: name,
      },
    };
  }

  const bytes = Buffer.byteLength(content, "utf-8");
  return {
    shape: "substrateScriptActivation",
    body: {
      activated: true,
      script: name,
      run_dir: runDir,
      path: target,
      bytes,
      sha256: sha256(content),
      prev_sha256: sha256(prevContent),
      changed: prevContent !== content,
      at: new Date().toISOString(),
    },
  };
}
