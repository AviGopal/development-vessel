/**
 * Spliceability scoring for the parity-gate detect-spliceability weight.
 * Weight derives from realized drafter no_op/failed-edit pressure, NOT a
 * line-count lint.
 */
export interface SpliceabilityGap {
  file: string;
  weight: number;
  size_over_ceiling: number;
  failed_edit_frequency: number;
}

export function scoreSpliceability(
  file: string,
  fileLines: number,
  spliceCeiling: number,
  recentFailedEdits: number,
): SpliceabilityGap {
  const size_over_ceiling = Math.max(0, fileLines - spliceCeiling);
  const weight = (size_over_ceiling / spliceCeiling) * (1 + recentFailedEdits);
  return {
    file,
    weight,
    size_over_ceiling,
    failed_edit_frequency: recentFailedEdits,
  };
}
