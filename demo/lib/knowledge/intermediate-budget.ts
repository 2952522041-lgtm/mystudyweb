import { SYNTHESIS_BUDGET } from './hierarchical-synthesis.ts';

export interface IntermediateBudgetMeasurement {
  contentBytes: number;
  fullBytes: number;
  inputBytes?: number;
}

/**
 * Keep the 10 KB model-content target while permitting metadata-heavy output
 * only when it is guaranteed to produce a smaller next request.
 */
export function intermediateOutputFitsBudget({
  contentBytes,
  fullBytes,
  inputBytes,
}: IntermediateBudgetMeasurement): boolean {
  const validMeasurement = (value: number): boolean => Number.isFinite(value) && value >= 0;
  if (!validMeasurement(contentBytes) || !validMeasurement(fullBytes)) return false;
  if (inputBytes !== undefined && !validMeasurement(inputBytes)) return false;
  if (fullBytes > SYNTHESIS_BUDGET.payload) return false;
  if (contentBytes <= SYNTHESIS_BUDGET.intermediate) return true;
  return inputBytes !== undefined
    && inputBytes > 0
    && fullBytes < inputBytes;
}
