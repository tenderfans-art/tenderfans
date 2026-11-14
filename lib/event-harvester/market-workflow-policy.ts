// Shared scheduler timing. Per-item execution budgets remain unchanged.
export const MARKET_WORKFLOW_ADMISSION_MS = 20 * 60_000;
export const MARKET_WORK_ITEM_BUDGET_MS = 30 * 60_000;
export const MARKET_WORKFLOW_SETTLEMENT_MS = 5 * 60_000;
export const MARKET_WORKFLOW_LIFETIME_MS =
  MARKET_WORKFLOW_ADMISSION_MS +
  MARKET_WORK_ITEM_BUDGET_MS +
  MARKET_WORKFLOW_SETTLEMENT_MS;

export function marketWorkflowTiming(reservedAt: string) {
  const startedAt = Date.parse(reservedAt);
  if (!Number.isFinite(startedAt)) {
    throw new Error("Invalid reservation start time");
  }
  return {
    admissionClosesAt: startedAt + MARKET_WORKFLOW_ADMISSION_MS,
    cancellationAt: startedAt + MARKET_WORKFLOW_LIFETIME_MS,
  };
}
