/** Whole numbers from 10 up, one decimal below — "2.3% per hour", "458%". */
export function formatQuotaPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  if (Math.abs(value) >= 10) return String(Math.round(value));
  return String(Math.round(value * 10) / 10);
}
