import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkInstallSurface,
  commandTexts,
  genEnvNames,
  installSurfaceExtras,
  loadInstallTruth,
  makefileTargets,
  sourceEnvReads,
  walkScripts,
} from "../../src/resolvers/docs-align-tick.js";

// A fixture tree shaped like the super-repo: gen-env.sh and the substrate Makefile
// are the truth the doc claims are checked against.
const GEN_ENV = [
  "#!/usr/bin/env bash",
  "# IDENTITY_URL appears only in this comment, which is neither a read nor an emit",
  'IDENTITY_VESSEL_URL="${IDENTITY_VESSEL_URL:-http://127.0.0.1:8101}"',
  "for v in SUBSTRATE_NAME SUBSTRATE_PORT_PREFIX; do :; done",
  "cat > /etc/substrate/env <<EOF",
  "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}",
  "EOF",
].join("\n");

const MAKEFILE = [
  ".PHONY: up verdict",
  "PORT_BASE := 18000",
  "IMAGE ?= substrate",
  "up: image",
  "\t@echo up",
  "image:",
  "\t@echo image",
  "logs-%:",
  "\t@echo $*",
].join("\n");

const README = [
  "# substrate",
  "## Overview",
  "Run `docker compose up -d` to start.",
  "## Installation",
  "```install",
  "# 1. Launch",
  "docker compose up -d",
  "```",
  "### From source",
  "```bash",
  "make -C scripts/substrate up REBUILD=1",
  "```",
  "## Usage",
  "Nothing to launch here.",
].join("\n");

const OTHER = [
  "# Federation",
  "Start the hub with `make -C scripts/substrate up`, or run deploy-hub.sh on the droplet.",
  "",
  "```bash",
  "IDENTITY_URL=http://127.0.0.1:18101 docker compose -f docker-compose.yml up -d",
  "KEY_ID=$(curl -s localhost/keys | jq -r .id)",
  "ANTHROPIC_API_KEY=sk-... make -C scripts/substrate run-live-obsidian",
  "make logs-goal-host",
  "PORT=9001 DISCOVERY_ENABLED=false bun run dev",
  "```",
  "Set `IDENTITY_VESSEL_URL=http://hub:18101` for a spoke.",
  "A hook honours `SUBSTRATE_ALLOW_DIRECT_EDIT=1` for a one-off edit; prose names it, it does not set it.",
  "This does not make up for a missing key; docker compose brings it up.",
].join("\n");

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "docs-align-install-"));
  await mkdir(join(root, "scripts", "substrate"), { recursive: true });
  await writeFile(join(root, "scripts", "substrate", "gen-env.sh"), GEN_ENV);
  await writeFile(join(root, "scripts", "substrate", "Makefile"), MAKEFILE);
  // A vessel whose own configuration reads LOG_LEVEL and CORS_ORIGINS.
  await mkdir(join(root, "repos", "activity-api", "src"), { recursive: true });
  await writeFile(
    join(root, "repos", "activity-api", "src", "config.ts"),
    "export const c = { logLevel: process.env.LOG_LEVEL || 'info', cors: process.env['CORS_ORIGINS'], port: env(\"PORT\", 8080) };",
  );
});

/** Truth read from the fixture only (never the host's /vessels or push clones). */
function truth(at: string = root) {
  return loadInstallTruth(at, { vesselSourceRoots: [join(at, "repos")] });
}
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("install-surface truth", () => {
  it("reads gen-env names from code lines only", () => {
    const n = genEnvNames(GEN_ENV);
    expect(n.has("IDENTITY_VESSEL_URL")).toBe(true);
    expect(n.has("SUBSTRATE_PORT_PREFIX")).toBe(true);
    expect(n.has("ANTHROPIC_API_KEY")).toBe(true);
    expect(n.has("IDENTITY_URL")).toBe(false);
  });
  it("reads Makefile rule heads and .PHONY, not variable assignments", () => {
    const t = makefileTargets(MAKEFILE);
    expect([...t].sort()).toEqual(["image", "logs-%", "up", "verdict"]);
  });
});

describe("checkInstallSurface", () => {
  const docs = [
    { id: "README.md", source: "README.md", body: README },
    { id: "docs/FEDERATION.md", source: "docs/FEDERATION.md", body: OTHER },
  ];

  it("flags launch commands outside README § Installation only", () => {
    const { findings } = checkInstallSurface(docs, truth());
    const launch = findings.filter((f) => f.invariant === "install_single_source");
    expect(launch.map((f) => `${f.doc_id}|${f.evidence}`)).toEqual([
      "README.md|Run `docker compose up -d` to start.",
      "docs/FEDERATION.md|Start the hub with `make -C scripts/substrate up`, or run deploy-hub.sh on the droplet.",
      "docs/FEDERATION.md|IDENTITY_URL=http://127.0.0.1:18101 docker compose -f docker-compose.yml up -d",
      "docs/FEDERATION.md|ANTHROPIC_API_KEY=sk-... make -C scripts/substrate run-live-obsidian",
    ]);
    // Every finding carries a source, or the bridge drops it.
    expect(findings.every((f) => typeof f.source === "string" && f.source.length > 0)).toBe(true);
  });

  it("flags IDENTITY_URL, which gen-env neither reads nor emits, and nothing gen-env knows", () => {
    const { findings } = checkInstallSurface(docs, truth());
    const env = findings.filter((f) => f.invariant === "env_var_unread");
    expect(env.length).toBe(1);
    expect(env[0]!.suggested_repair).toContain("IDENTITY_URL");
    expect(env[0]!.doc_id).toBe("docs/FEDERATION.md");
  });

  it("flags make targets the Makefile does not define, honouring pattern rules", () => {
    const { findings } = checkInstallSurface(docs, truth());
    const make = findings.filter((f) => f.invariant === "make_target_missing");
    expect(make.length).toBe(1);
    expect(make[0]!.suggested_repair).toContain('"run-live-obsidian"');
  });

  it("reports a check it could not run instead of passing it", () => {
    const { findings, skipped } = checkInstallSurface(docs, truth(join(root, "absent")));
    expect(findings.some((f) => f.invariant === "env_var_unread")).toBe(false);
    expect(skipped.some((s) => s.startsWith("env_var_unread"))).toBe(true);
    expect(skipped.some((s) => s.startsWith("make_target_missing"))).toBe(true);
  });
});

// Lines taken from correct docs that an earlier version of this check flagged. Each
// would have become a documentation_drift gap filed against a doc that is right.
describe("mentions are not restatements", () => {
  const MENTIONS = [
    "# Substrate",
    "The compose",
    "manifest (and `make up`, which wraps it) is the *bootstrap* tier only: the",
    "",
    "**Lanes removed.** These are commands and processes, not names; nothing warns about them.",
    "",
    "| Retired | Replacement |",
    "|---|---|",
    "| `make run-live`, `run`, `run-detach`, `run-live-obsidian`, raw `docker run` recipes, `configure-local.sh`, the host deploy scripts | the install page's sequences |",
    "| `deploy-hub.sh` | the install page's sequence B |",
    "",
    "| Command | Does |",
    "|---|---|",
    "| `docker compose up -d` | starts the fleet |",
    "",
    "**Environment Variables:**",
    "```bash",
    "LOG_LEVEL=INFO",
    "CORS_ORIGINS=*",
    "IDENTITY_URL=http://identity:8101",
    "```",
  ].join("\n");

  it("reads neither prose mentions nor retired-table rows as commands; a command table still counts", () => {
    const { findings } = checkInstallSurface([{ id: "docs/SUBSTRATE.md", source: "docs/SUBSTRATE.md", body: MENTIONS }], truth());
    expect(findings.map((f) => `${f.invariant}|${f.evidence}`)).toEqual([
      "install_single_source|| `docker compose up -d` | starts the fleet |",
      "env_var_unread|IDENTITY_URL=http://identity:8101",
    ]);
  });

  it("a code span is a command when it opens the line, a list item, a table cell or a prompt", () => {
    expect(commandTexts("- `make up` then wait", false)).toEqual(["make up"]);
    expect(commandTexts("1. `make up`", false)).toEqual(["make up"]);
    expect(commandTexts("> `make up`", false)).toEqual(["make up"]);
    expect(commandTexts("| `make up` | x |", false)).toEqual(["make up"]);
    expect(commandTexts("run `$ make up` now", false)).toEqual(["make up"]);
    expect(commandTexts("manifest (and `make up`, which wraps it)", false)).toEqual([]);
  });

  it("exempts a vessel's own settings from env_var_unread, and skips the check when no vessel source is readable", () => {
    expect([...sourceEnvReads("process.env.LOG_LEVEL; process.env['CORS_ORIGINS']; Bun.env.X_Y; env(\"PORT\", 1)")].sort())
      .toEqual(["CORS_ORIGINS", "LOG_LEVEL", "PORT", "X_Y"]);
    const doc = [{ id: "d.md", source: "d.md", body: "```bash\nLOG_LEVEL=INFO\n```" }];
    expect(checkInstallSurface(doc, truth()).findings).toEqual([]);
    const blind = loadInstallTruth(root, { vesselSourceRoots: [join(root, "no-such-dir")] });
    const r = checkInstallSurface(doc, blind);
    expect(r.findings).toEqual([]);
    expect(r.skipped.some((x) => x.startsWith("env_var_unread: no vessel source"))).toBe(true);
  });
});

describe("the wider install-surface corpus", () => {
  let tree: string;
  beforeAll(async () => {
    tree = await mkdtemp(join(tmpdir(), "docs-align-extras-"));
    await mkdir(join(tree, ".claude", "skills", "deploy"), { recursive: true });
    await mkdir(join(tree, ".claude", "skills", "empty"), { recursive: true });
    await writeFile(join(tree, ".claude", "skills", "deploy", "SKILL.md"), "# Deploy\n\n```bash\nmake -C scripts/substrate up\n```\n");
    await writeFile(join(tree, "docker-compose.yml"), [
      "# Launch manifest.",
      "#   docker compose up -d",
      "# Setup commands live in README § Installation.",
      "services:",
      "  substrate:",
      "    # docker compose up here is not the header",
      "    image: x",
    ].join("\n"));
  });
  afterAll(async () => {
    await rm(tree, { recursive: true, force: true });
  });

  it("reads skills and the compose header, and finds a launch command restated in each", () => {
    const extras = installSurfaceExtras(tree);
    expect(extras.map((d) => d.id)).toEqual([".claude/skills/deploy/SKILL.md", "docker-compose.yml#header"]);
    expect(extras[1]!.body).not.toContain("not the header");
    const { findings } = checkInstallSurface(extras, truth());
    expect(findings.filter((f) => f.invariant === "install_single_source").map((f) => f.doc_id)).toEqual([
      ".claude/skills/deploy/SKILL.md",
      "docker-compose.yml#header",
    ]);
  });
});

describe("script walk", () => {
  it("does not spend its cap inside node_modules", async () => {
    const tree = await mkdtemp(join(tmpdir(), "docs-align-walk-"));
    try {
      // A vendored tree larger than the cap, sorted ahead of the real script.
      const vendored = join(tree, "scripts", "a-relay", "node_modules", "pkg");
      await mkdir(vendored, { recursive: true });
      for (let i = 0; i < 30; i++) await writeFile(join(vendored, `f${i}.js`), "");
      await mkdir(join(tree, "scripts", "substrate"), { recursive: true });
      await writeFile(join(tree, "scripts", "substrate", "gen-env.sh"), "");
      const found = walkScripts(join(tree, "scripts"), 10, tree);
      expect(found).toContain("scripts/substrate/gen-env.sh");
      expect(found.some((f) => f.includes("node_modules"))).toBe(false);
    } finally {
      await rm(tree, { recursive: true, force: true });
    }
  });
});
