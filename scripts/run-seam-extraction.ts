/**
 * Parity-gated seam extraction runner — the deterministic executable face of
 * src/maintenance/{seam-extraction,parity-gate}.ts, so the family can run as a
 * traced activity (shellResult task) instead of an operator hand-invocation.
 *
 * Usage:
 *   bun scripts/run-seam-extraction.ts --project <dir> --file <rel-path> [--land]
 *
 * Without --land: propose + apply in-memory + gate; print the seamExtraction and
 * parityVerdict as JSON; exit 0 on PARITY PASS, 2 on no-proposal, 3 on FAIL.
 * Nothing is written.
 *
 * With --land: additionally save the transformed files to disk and stage them
 * (git add) — committing is left to the caller so the commit message can carry
 * the verdict. --land refuses unless the gate verdict is PASS.
 */
import { Project } from "ts-morph";
import { proposeSeamExtraction, applySeamExtraction } from "../src/maintenance/seam-extraction.js";
import { captureBaseline, verifyParity } from "../src/maintenance/parity-gate.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const projectDir = arg("project");
const relFile = arg("file");
const land = process.argv.includes("--land");
if (!projectDir || !relFile) {
  console.error("usage: bun scripts/run-seam-extraction.ts --project <dir> --file <rel-path> [--land]");
  process.exit(64);
}

const project = new Project({ tsConfigFilePath: `${projectDir}/tsconfig.json` });
const filePath = `${projectDir}/${relFile}`;

const seam = proposeSeamExtraction(project, filePath);
if (!seam) {
  console.log(JSON.stringify({ result: "no_proposal", file: relFile }));
  process.exit(2);
}

const baseline = captureBaseline(project, filePath);
applySeamExtraction(project, seam);
const verdict = await verifyParity(project, baseline, seam.targetModule);

const report = {
  result: verdict.verdict ? "PARITY_PASS" : "PARITY_FAIL",
  seam: { file: seam.file, targetModule: seam.targetModule, symbols: seam.symbols, rationale: seam.rationale },
  verdict,
  landed: false,
};

if (verdict.verdict && land) {
  await project.save();
  const rel = (p: string) => p.startsWith(projectDir) ? p.slice(projectDir.length + 1) : p;
  const p = Bun.spawn(["git", "add", rel(seam.file), rel(seam.targetModule)], { cwd: projectDir });
  await p.exited;
  report.landed = true;
}

console.log(JSON.stringify(report, null, 2));
process.exit(verdict.verdict ? 0 : 3);
