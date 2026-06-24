/**
 * gap-landability-types.ts
 *
 * Shared types for the gap landability backward model.
 */

import type { GapRecord } from "../resolvers/gap-landability-model";

/** Feature subset of a gap fed to the backward landability model. */
export type GapFeatures = Pick<
  GapRecord,
  "category" | "remediationAlreadyPresent" | "singleFile"
>;

/** Minimal Gap shape – extend with fields already present in the codebase */
export interface Gap {
  id: string;
  category?: string;
  status: "open" | "closed" | "churned";
  createdAt: string; // ISO-8601
  remediationPresent?: boolean;
  affectedFiles?: string[];
  linkedPR?: string | null;
}

/** Observed outcome for a closed/churned gap */
export type GapOutcome = "landed" | "churned";

/** Landability prediction for a single open gap */
export interface LandabilityScore {
  gapId: string;
  landabilityScore: number; // [0,1] — probability of landing
  isUnlanding: boolean;     // true when score < threshold
  modelSource: "backward_logistic" | "heuristic";
  features: GapFeatures;
}

/** Full result returned by runLandabilityModel */
export interface LandabilityModelResult {
  scores: LandabilityScore[];
  /** Gap IDs recommended for auto-close (residual detector output) */
  autoCloseRecommendations: string[];
  modelAvailable: boolean;
  trainingAccuracy: number | null;
  trainingSamples: number;
  threshold: number;
}
