/**
 * project_plan — Project-thread planner: reads a #project Obsidian note (via discovery, probing which vault peer actually holds the note path), parses its ## To do checkboxes into work items, classifies each item by resolver class (substrate_authorable | obsidian_feature | human_or_llm_question), and emits a projectPlanReport with peer_routing evidence. Dry-run by default; no vault writes..
 * Input shapes (closure linkage): obsidian:note
 * Output shape: projectPlanReport
 */

import type { ResolverResult } from "./types.js";

export interface ProjectPlanPointer {
  type: "project_plan";
  [key: string]: unknown;
}

export async function resolveProjectPlan(pointer: ProjectPlanPointer): Promise<ResolverResult> {
  // TODO: implement. Stub returns an empty, well-formed result.
  return { shape: "projectPlanReport", body: { authored: true, pointer_type: pointer.type } };
}
