// THE DRAFTER WORKER REACHES THE RUNTIME TREE.
//
// feature_compose runs each open drafter entry point in a Worker it spawns from a URL next to its own module. The
// runtime tree is not the clone: the deploy mirror (scripts/substrate/mirror-to-live.sh in the super-repo) copies only
// src/, sql/, scripts/, tracked */dist/ dirs and the root tsconfig.json, index.ts and package.json. A Worker entry
// outside those never exists at runtime, so every compose fails the spawn with ModuleNotFound and drafts with the floor
// (drafter.fell_back "worker_failed: ...") while every clone-side test stays green.
//   MUST-FAIL: stage this vessel the way the mirror does and the entry the code spawns (captured through the
//     workerFactory seam, never restated) exists there and answers a real request with its own imports resolved.
//   CONTROL: the same entry exists in the clone; a worker that errors for another reason still drafts with the floor
//     and records worker_failed.
import { afterAll, describe, expect, it } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isolateRuntimeRoot } from "../helpers/runtime-root.js";

await isolateRuntimeRoot("drafter-worker-staged", { superRepo: true, who: "test/resolvers/feature-compose-drafter-worker-staged.test.ts" });
const fc = await import("../../src/resolvers/feature-compose.ts");

const ROOT = join(import.meta.dir, "..", "..");
/** What the mirror carries (dv commits no dist/ dir). Anything else stays in the clone. */
const MIRRORED_DIRS = ["src", "sql", "scripts"];
const MIRRORED_FILES = ["tsconfig.json", "index.ts", "package.json"];

const ex: Parameters<typeof fc.validateDrafterContext>[1] = {
  targets: [], netNew: [], targetContents: {}, ceiling: 24,
  prompts: () => ({ decompose: "", refine: "" }), mandatory: [], floorPrompt: "",
};
const completeFacts = {
  floorContext: { grounding: "", targetWindows: {}, priorFeedback: "", principles: "", composeLessons: "", netNewTargets: [], opBudgetHint: 24, journal: [], version: "drafter-v1" },
  spec: "", gapSummary: "", directed: false, gapMeta: {}, regionHint: "", lineHint: null,
  targets: { files: [], ownCheckAdded: [], ownCheckReadonly: [], netNew: [] },
  verifyVessels: [], listing: {}, contents: {}, ownCheck: null, lineageLessons: [], ancestors: [], parentCheck: null,
  lessonSource: "none", lessonHits: [], lessonJsonlTail: [], fileLessonsTail: [], principles: "", contracts: "",
  existingSymbols: "", symbolDecls: "", safeAnchors: "", opCeiling: 24, opCeilingDeclared: false,
};

/** One compose through the production path whose Worker errors on its first message; returns the URL it was spawned from. */
async function composeWithErroringWorker(): Promise<{ url: URL | null; result: Awaited<ReturnType<typeof fc.draftContextThroughOpenModule>> }> {
  let url: URL | null = null;
  const result = await fc.draftContextThroughOpenModule({
    facts: completeFacts,
    scope: { verifyVessels: [], targets: [], checkPaths: [] },
    expect: ex,
    floorBudget: 24,
    readFile: async () => null,
    readGapRow: async () => null,
    lessonRows: async () => [],
    ancestorStart: "",
    selfId: "self",
    variant: "drafter-v1",
    mode: "default",
    workerVariant: "drafter-v1",
    workerFactory: (u) => {
      url = u;
      let onerror: ((ev: ErrorEvent) => void) | null = null;
      const facade = {
        set onmessage(_h: unknown) { /* never answers */ },
        set onerror(h: ((ev: ErrorEvent) => void) | null) { onerror = h; },
        postMessage(): void { queueMicrotask(() => onerror?.({ message: "injected spawn failure" } as ErrorEvent)); },
        terminate(): void { /* nothing spawned */ },
      };
      return facade as unknown as Worker;
    },
  });
  return { url, result };
}

/** A copy of this vessel holding only what the mirror carries (plus the dependencies the runtime installs). */
function stageLikeTheMirror(): string {
  const dst = mkdtempSync(join(tmpdir(), "drafter-worker-staged-tree-"));
  for (const d of MIRRORED_DIRS) if (existsSync(join(ROOT, d))) cpSync(join(ROOT, d), join(dst, d), { recursive: true });
  for (const f of MIRRORED_FILES) if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(dst, f));
  if (existsSync(join(ROOT, "node_modules"))) symlinkSync(join(ROOT, "node_modules"), join(dst, "node_modules"));
  return dst;
}

/** Post one request to a Worker and settle on its reply or error (explicit then/catch: no rejects-assertion on a worker promise). */
function ask(entry: string, msg: unknown, timeoutMs = 8000): Promise<{ reply?: unknown; error?: string }> {
  return new Promise((resolve) => {
    const w = new Worker(entry);
    const done = (out: { reply?: unknown; error?: string }): void => { clearTimeout(t); w.terminate(); resolve(out); };
    const t = setTimeout(() => done({ error: "timeout" }), timeoutMs);
    w.onmessage = (ev: MessageEvent) => done({ reply: ev.data });
    w.onerror = (ev: ErrorEvent) => done({ error: String(ev.message ?? ev) });
    w.postMessage(msg);
  });
}

const staged: string[] = [];
afterAll(() => { for (const d of staged) rmSync(d, { recursive: true, force: true }); });

describe("the drafter worker the composer spawns is in the mirrored runtime tree", () => {
  it("MUST-FAIL: the spawned entry exists in a tree staged the way the mirror stages it", async () => {
    const { url } = await composeWithErroringWorker();
    expect(url).not.toBeNull();
    const rel = relative(ROOT, fileURLToPath(url!));
    const tree = stageLikeTheMirror();
    staged.push(tree);
    expect({ rel, inStagedTree: existsSync(join(tree, rel)) }).toEqual({ rel, inStagedTree: true });
  }, 30_000);

  it("MUST-FAIL: from the staged tree the entry loads, imports the shipped drafter and answers a real request", async () => {
    const { url } = await composeWithErroringWorker();
    const rel = relative(ROOT, fileURLToPath(url!));
    const tree = stageLikeTheMirror();
    staged.push(tree);
    const entry = join(tree, rel);
    const out = existsSync(entry) ? await ask(entry, { variant: "drafter-v1", entry: "planDrafterReads", facts: completeFacts }) : { error: `not in the staged tree: ${rel}` };
    expect(out.error).toBeUndefined();
    expect((out.reply as { ok?: unknown } | undefined)?.ok).toBe(true);
  }, 30_000);

  it("CONTROL: the spawned entry exists in the clone", async () => {
    const { url } = await composeWithErroringWorker();
    expect(url).not.toBeNull();
    expect(existsSync(fileURLToPath(url!))).toBe(true);
  });

  it("CONTROL: a worker that errors for another reason still drafts with the floor and records worker_failed", async () => {
    const { result } = await composeWithErroringWorker();
    expect(result.ctx).toBeNull();
    expect(result.record.variant).toBe("drafter-v1");
    expect(result.record.fell_back ?? "").toMatch(/^worker_failed: drafter worker error: injected spawn failure/);
    expect(result.budget).toBe(24);
  });
});
