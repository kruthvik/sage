import { REVIEW_FIRST_DAYS } from "./pedagogy.config.ts";

// v3 transparent baseline (owner decision Q1; RM-14, ED-20): first review after 2 days, ×2 after a delayed success, reset after a failure, capped by the horizon.
export function nextIntervalDays(previous: number | undefined, delayedSuccess: boolean | undefined, horizonDays?: number): number {
  const next = previous === undefined || delayedSuccess === false ? REVIEW_FIRST_DAYS : delayedSuccess ? previous * 2 : previous;
  return horizonDays ? Math.max(1, Math.min(next, horizonDays)) : next;
}
export const addDays = (iso: string, days: number) => new Date(Date.parse(iso) + days * 86_400_000).toISOString();
