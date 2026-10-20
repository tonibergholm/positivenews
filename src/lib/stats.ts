/** Pending articles have no verdict and do not contribute to the rejection rate. */
export function rejectionRateForCounts(total: number, positive: number, pending: number): number {
  const decided = total - pending;
  return decided > 0 ? Math.round(((decided - positive) / decided) * 100) : 0;
}
