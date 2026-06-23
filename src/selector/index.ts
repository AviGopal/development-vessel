/**
 * Selector public API.
 */
export { recommend } from "./recommend.ts";
export type { Candidate, ScoredCandidate } from "./recommend.ts";
export { thompsonScore, recordToParams, sampleBeta } from "./thompson-score.ts";
export type { BetaParams, ThompsonRecord } from "./thompson-score.ts";
export { getRecord, recordOutcome, loadRecords, snapshotRecords } from "./activity-shape-store.ts";
