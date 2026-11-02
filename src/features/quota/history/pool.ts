/**
 * Quota pool forecast: what a provider's accounts have left, what they burned,
 * and when the pool runs dry or refills.
 *
 * Pure functions — no React, no storage, no clock of their own (`now` is always
 * passed in). Values are in "pool percent": each account contributes 100 % of
 * its main limit times its plan weight, so six Claude accounts make a 600 % pool.
 *
 * The projection is event-driven and exact between events: every account drains
 * linearly at its own recent burn rate, an empty account's demand moves to the
 * accounts that still have quota (the proxy routes around an exhausted account),
 * and each reset refills an account to its full limit.
 */

import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';
import { normalizePlanType } from '@/utils/quota/parsers';
import type { QuotaProviderType } from '../providers/types';
import {
  MAIN_WINDOW_IDS,
  mainWindows,
  maxSampleGapMs,
  windowHours,
  type QuotaHistory,
} from './model';

export const POOL_PROVIDERS = ['claude', 'codex'] as const satisfies readonly QuotaProviderType[];
export type PoolProvider = (typeof POOL_PROVIDERS)[number];

export const isPoolProvider = (value: string): value is PoolProvider =>
  (POOL_PROVIDERS as readonly string[]).includes(value);

export type PoolMode = 'remaining' | 'drain';

/** Trailing window the burn rate is measured over, in hours. */
export const POOL_BURN_WINDOWS = [1, 3, 6] as const;
export type PoolBurnWindow = (typeof POOL_BURN_WINDOWS)[number];

/** How usage after now compares with the measured burn rate. */
export const POOL_FUTURE_USAGE = [
  { id: 'same', factor: 1 },
  { id: 'half', factor: 0.5 },
  { id: 'double', factor: 2 },
  { id: 'none', factor: 0 },
] as const;
export type PoolFutureUsage = (typeof POOL_FUTURE_USAGE)[number]['id'];

export const futureUsageFactor = (id: PoolFutureUsage) =>
  POOL_FUTURE_USAGE.find((option) => option.id === id)?.factor ?? 1;

/** The chart shows two weeks, starting three days before today. */
export const POOL_SPAN_DAYS = 14;
const POOL_LEAD_DAYS = 3;
/** Navigation moves a week at a time, one week back (history retention) or ahead. */
export const POOL_OFFSET_MIN = -1;
export const POOL_OFFSET_MAX = 1;
/** "Pool empty" and "First empty" look this far ahead regardless of the visible span. */
export const POOL_FORECAST_MS = 14 * DAY_MS;

/** A burn rate needs at least this much observed time inside its window. */
const MIN_BURN_COVERAGE_MS = 15 * MINUTE_MS;
/** Resets closer together than this share one chart label. */
const RESET_LABEL_MERGE_MS = 45 * MINUTE_MS;
/** An increase of at least this many points between two readings is a reset. */
const RESET_MIN_RISE = 1;
const EPSILON = 1e-6;
const MAX_EVENTS = 20_000;

/* ---------------------------------------------------------------- span */

/** Visible span for an offset in weeks; date arithmetic keeps days whole across DST. */
export function poolSpan(offset: number, now: number): { startMs: number; endMs: number } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - POOL_LEAD_DAYS + offset * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + POOL_SPAN_DAYS);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

/** Local midnights from start to end, inclusive of the start. */
export function spanDays(startMs: number, endMs: number): number[] {
  const days: number[] = [];
  const cursor = new Date(startMs);
  while (cursor.getTime() < endMs && days.length < 64) {
    days.push(cursor.getTime());
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

/* ------------------------------------------------------------- accounts */

/** One credential in a pool. Percentages here are unweighted (0..100). */
export interface PoolAccount {
  authIndex: string;
  name: string;
  /** Plan multiplier: how many standard accounts this one's limit is worth. */
  weight: number;
  /** Remaining percent of the main limit now; null when never read. */
  current: number | null;
  resetAtMs: number | null;
  periodHours: number | null;
}

/**
 * Plan weights relative to a standard account. Codex Pro (plan `pro`) carries
 * a larger weekly limit than Plus, so it counts as 2.5 accounts in the pool.
 */
export function planWeight(provider: QuotaProviderType, planType: unknown): number {
  if (provider === 'codex' && normalizePlanType(planType) === 'pro') return 2.5;
  return 1;
}

interface LiveWindowLike {
  id?: string;
  usedPercent?: number | null;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

/**
 * The live main window of one successful read: the account-wide weekly limit,
 * else the longest window — the same choice `mainWindows` makes for history.
 */
export function liveMainWindow(
  quota: { status?: string } | undefined
): { id: string; remaining: number; resetAtMs: number | null; periodHours: number | null } | null {
  if (!quota || quota.status !== 'success') return null;
  const windows = ((quota as { windows?: LiveWindowLike[] }).windows ?? []).filter(
    (window): window is LiveWindowLike & { id: string; usedPercent: number } =>
      typeof window.id === 'string' &&
      typeof window.usedPercent === 'number' &&
      Number.isFinite(window.usedPercent)
  );
  if (windows.length === 0) return null;
  const hours = (window: LiveWindowLike & { id: string }) =>
    typeof window.periodHours === 'number' && window.periodHours > 0
      ? window.periodHours
      : windowHours(window.id);
  const preferred = MAIN_WINDOW_IDS.map((id) => windows.find((w) => w.id === id)).find(Boolean);
  const chosen = preferred ?? [...windows].sort((a, b) => hours(b) - hours(a))[0];
  const resetAtMs =
    typeof chosen.resetAtMs === 'number' && Number.isFinite(chosen.resetAtMs)
      ? chosen.resetAtMs
      : null;
  const periodHours = hours(chosen);
  return {
    id: chosen.id,
    remaining: Math.min(100, Math.max(0, 100 - chosen.usedPercent)),
    resetAtMs,
    periodHours: periodHours > 0 ? periodHours : null,
  };
}

export interface PoolAccountInput {
  authIndex: string;
  name: string;
  provider: QuotaProviderType;
  quota: { status?: string } | undefined;
}

/**
 * Pool members: live reads first, else the last recorded reading. Accounts
 * with neither are left out — the hero then says how many of them count.
 */
export function buildPoolAccounts(
  inputs: PoolAccountInput[],
  readings: Map<string, Reading[]>
): PoolAccount[] {
  const accounts: PoolAccount[] = [];
  for (const input of inputs) {
    const live = liveMainWindow(input.quota);
    const recorded = readings.get(input.authIndex);
    const last = recorded && recorded.length > 0 ? recorded[recorded.length - 1].value : null;
    // Every live read is also recorded, so the newest reading is never older
    // than the live one; the recorder may have a newer one still.
    const current = last ?? live?.remaining ?? null;
    if (current === null) continue;
    accounts.push({
      authIndex: input.authIndex,
      name: input.name,
      weight: planWeight(
        input.provider,
        (input.quota as { planType?: unknown } | undefined)?.planType
      ),
      current,
      resetAtMs: live?.resetAtMs ?? null,
      periodHours: live?.periodHours ?? null,
    });
  }
  return accounts;
}

/* ------------------------------------------------------------- readings */

export interface Reading {
  t: number;
  value: number;
}

/** Each account's main-limit readings, oldest first, up to `until`. */
export function accountReadings(
  history: QuotaHistory,
  authIndexes: Iterable<string>,
  until: number
): Map<string, Reading[]> {
  const main = mainWindows(history.samples);
  const wanted = new Set(authIndexes);
  const readings = new Map<string, Reading[]>();
  wanted.forEach((authIndex) => readings.set(authIndex, []));
  for (const sample of history.samples) {
    if (sample.t > until) break;
    for (const [authIndex, windows] of Object.entries(sample.v)) {
      if (!wanted.has(authIndex)) continue;
      const id = main.get(authIndex);
      const value = id === undefined ? undefined : windows[id];
      if (typeof value === 'number') readings.get(authIndex)?.push({ t: sample.t, value });
    }
  }
  return readings;
}

/** First index with t >= target. */
function lowerBound(readings: Reading[], target: number): number {
  let low = 0;
  let high = readings.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (readings[mid].t < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Burn rate in unweighted percent per hour over (end - windowMs, end].
 *
 * Only time between two readings at most `maxGapMs` apart counts as observed;
 * rises are resets and never count as negative usage. Pairs straddling the
 * window start count proportionally. Null without 15 observed minutes.
 */
export function burnRate(
  readings: Reading[],
  end: number,
  windowMs: number,
  maxGapMs: number
): number | null {
  const start = end - windowMs;
  let index = Math.max(1, lowerBound(readings, start));
  let observed = 0;
  let used = 0;
  for (; index < readings.length && readings[index].t <= end; index += 1) {
    const previous = readings[index - 1];
    const current = readings[index];
    const dt = current.t - previous.t;
    if (dt <= 0 || dt > maxGapMs) continue;
    const inside = Math.min(end, current.t) - Math.max(start, previous.t);
    if (inside <= 0) continue;
    observed += inside;
    if (previous.value > current.value) used += ((previous.value - current.value) * inside) / dt;
  }
  if (observed < MIN_BURN_COVERAGE_MS) return null;
  return used / (observed / HOUR_MS);
}

/* ------------------------------------------------------------- recorded */

export interface PoolPoint {
  t: number;
  value: number;
}

export interface PoolResetMark {
  t: number;
  /** Pool percent restored. */
  delta: number;
  /** Pool value right after the reset. */
  value: number;
}

export interface PoolRecorded {
  /** Weighted pool sum, broken into runs at gaps. */
  segments: PoolPoint[][];
  /** Weighted per-account runs, keyed by auth index. */
  accounts: Record<string, PoolPoint[][]>;
  /** Pool burn rate at each recorded instant, broken at gaps. */
  drain: PoolPoint[][];
  resets: PoolResetMark[];
}

function splitAtGaps(points: PoolPoint[], maxGapMs: number): PoolPoint[][] {
  const runs: PoolPoint[][] = [];
  let run: PoolPoint[] = [];
  for (const point of points) {
    if (run.length > 0 && point.t - run[run.length - 1].t > maxGapMs) {
      runs.push(run);
      run = [];
    }
    run.push(point);
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/** Merge resets close together into one label at the later instant. */
export function mergeResetMarks(marks: PoolResetMark[]): PoolResetMark[] {
  const merged: PoolResetMark[] = [];
  for (const mark of [...marks].sort((a, b) => a.t - b.t)) {
    const last = merged[merged.length - 1];
    if (last && mark.t - last.t <= RESET_LABEL_MERGE_MS) {
      merged[merged.length - 1] = { t: mark.t, delta: last.delta + mark.delta, value: mark.value };
    } else {
      merged.push({ ...mark });
    }
  }
  return merged;
}

/**
 * The recorded side of the chart for [from, to].
 *
 * Each account holds its last reading until the next one, and before its first
 * reading it is assumed at that first value, so a credential read later than
 * the others does not show up as a sudden jump in the pool.
 */
export function buildPoolRecorded(
  history: QuotaHistory,
  accounts: Pick<PoolAccount, 'authIndex' | 'weight'>[],
  from: number,
  to: number,
  burnWindowMs: number
): PoolRecorded {
  const maxGapMs = maxSampleGapMs(history);
  const weights = new Map(accounts.map((account) => [account.authIndex, account.weight]));
  const readings = accountReadings(history, weights.keys(), to);
  const members = [...readings].filter(([, list]) => list.length > 0);
  const empty: PoolRecorded = { segments: [], accounts: {}, drain: [], resets: [] };
  if (members.length === 0 || !(to > from)) return empty;

  const lookback = from - maxGapMs;
  const times = new Set<number>();
  for (const [, list] of members) {
    for (const reading of list) {
      if (reading.t >= lookback && reading.t <= to) times.add(reading.t);
    }
  }
  const instants = [...times].sort((a, b) => a - b);

  const cursor = new Map<string, number>();
  const pool: PoolPoint[] = [];
  const drain: PoolPoint[] = [];
  for (const t of instants) {
    let sum = 0;
    let rate = 0;
    let rated = false;
    for (const [authIndex, list] of members) {
      let index = cursor.get(authIndex) ?? 0;
      while (index + 1 < list.length && list[index + 1].t <= t) index += 1;
      cursor.set(authIndex, index);
      const weight = weights.get(authIndex) ?? 1;
      sum += weight * list[index].value;
      const accountRate = burnRate(list, t, burnWindowMs, maxGapMs);
      if (accountRate !== null) {
        rate += weight * accountRate;
        rated = true;
      }
    }
    pool.push({ t, value: sum });
    if (rated) drain.push({ t, value: rate });
  }

  const resets: PoolResetMark[] = [];
  const perAccount: Record<string, PoolPoint[][]> = {};
  for (const [authIndex, list] of members) {
    const weight = weights.get(authIndex) ?? 1;
    const visible = list.filter((reading) => reading.t >= lookback);
    perAccount[authIndex] = splitAtGaps(
      visible.map((reading) => ({ t: reading.t, value: weight * reading.value })),
      maxGapMs
    );
    for (let index = 1; index < list.length; index += 1) {
      const rise = list[index].value - list[index - 1].value;
      if (rise < RESET_MIN_RISE || list[index].t < from) continue;
      resets.push({ t: list[index].t, delta: weight * rise, value: 0 });
    }
  }
  const poolAt = (t: number) => pool.find((point) => point.t >= t)?.value ?? 0;
  const merged = mergeResetMarks(resets).map((mark) => ({ ...mark, value: poolAt(mark.t) }));

  return {
    segments: splitAtGaps(pool, maxGapMs),
    accounts: perAccount,
    drain: splitAtGaps(drain, maxGapMs),
    resets: merged,
  };
}

/* ----------------------------------------------------------- projection */

export interface PoolForecast {
  /** Weighted pool sum; a reset repeats its instant with the refilled value. */
  points: PoolPoint[];
  accounts: Record<string, PoolPoint[]>;
  /** Pool burn rate as a step function: each change repeats its instant. */
  drain: PoolPoint[];
  resets: PoolResetMark[];
  /** The first account to run out, or null when none does before `until`. */
  firstEmpty: { t: number; authIndex: string } | null;
  /** When every account is out at once, or null. */
  poolEmptyAt: number | null;
  nextReset: PoolResetMark | null;
  /** Pool capacity: 100 % per account, times its weight. */
  capacity: number;
  /** Weighted pool value now. */
  current: number;
}

/** The first reset after `now`, rolling a stale anchor forward by whole periods. */
export function nextResetAfter(
  resetAtMs: number | null,
  periodHours: number | null,
  now: number
): number | null {
  if (resetAtMs === null || !Number.isFinite(resetAtMs)) return null;
  if (resetAtMs > now) return resetAtMs;
  if (!periodHours || periodHours <= 0) return null;
  const period = periodHours * HOUR_MS;
  return resetAtMs + (Math.floor((now - resetAtMs) / period) + 1) * period;
}

interface SimAccount {
  authIndex: string;
  capacity: number;
  remaining: number;
  /** Weighted percent per hour this account's users ask for. */
  demand: number;
  periodMs: number | null;
  nextReset: number | null;
}

/**
 * Project the pool from `now` to `until`.
 *
 * `rates` are unweighted percent per hour per account (missing or null means
 * no measured usage); `factor` scales them for the future-usage setting.
 */
export function projectPool(
  accounts: PoolAccount[],
  rates: Map<string, number | null>,
  factor: number,
  now: number,
  until: number
): PoolForecast {
  const sim: SimAccount[] = accounts
    .filter((account) => account.current !== null)
    .map((account) => ({
      authIndex: account.authIndex,
      capacity: 100 * account.weight,
      remaining: (account.current as number) * account.weight,
      demand: Math.max(0, (rates.get(account.authIndex) ?? 0) * account.weight * factor),
      periodMs: account.periodHours ? account.periodHours * HOUR_MS : null,
      nextReset: nextResetAfter(account.resetAtMs, account.periodHours, now),
    }));

  const capacity = sim.reduce((total, account) => total + account.capacity, 0);
  const totalOf = () => sim.reduce((total, account) => total + account.remaining, 0);
  const points: PoolPoint[] = [];
  const perAccount: Record<string, PoolPoint[]> = {};
  sim.forEach((account) => (perAccount[account.authIndex] = []));
  const drain: PoolPoint[] = [];
  const resets: PoolResetMark[] = [];
  let firstEmpty: PoolForecast['firstEmpty'] = null;
  let poolEmptyAt: number | null = null;

  const record = (t: number) => {
    points.push({ t, value: totalOf() });
    sim.forEach((account) => perAccount[account.authIndex].push({ t, value: account.remaining }));
  };
  const demandTotal = sim.reduce((total, account) => total + account.demand, 0);
  const noteEmpty = (t: number) => {
    if (sim.length === 0) return;
    if (!firstEmpty) {
      const out = sim.find((account) => account.remaining <= EPSILON);
      if (out) firstEmpty = { t, authIndex: out.authIndex };
    }
    if (poolEmptyAt === null && sim.every((account) => account.remaining <= EPSILON)) {
      poolEmptyAt = t;
    }
  };

  let t = now;
  record(t);
  noteEmpty(t);

  for (let step = 0; step < MAX_EVENTS && t < until && sim.length > 0; step += 1) {
    // Rates for this stretch: empty accounts hand their demand to the rest,
    // proportionally to what those already burn (evenly if they burn nothing).
    const active = sim.filter((account) => account.remaining > EPSILON);
    const activeDemand = active.reduce((total, account) => total + account.demand, 0);
    const effective = new Map<SimAccount, number>();
    for (const account of active) {
      effective.set(
        account,
        activeDemand > 0
          ? (account.demand * demandTotal) / activeDemand
          : demandTotal / active.length
      );
    }
    const poolRate = active.length > 0 ? demandTotal : 0;

    let next = until;
    for (const account of sim) {
      if (account.nextReset !== null && account.nextReset < next) next = account.nextReset;
      const rate = effective.get(account) ?? 0;
      if (rate > 0) next = Math.min(next, t + (account.remaining / rate) * HOUR_MS);
    }
    next = Math.max(next, t);

    drain.push({ t, value: poolRate }, { t: next, value: poolRate });
    for (const account of sim) {
      const rate = effective.get(account) ?? 0;
      account.remaining = Math.max(0, account.remaining - (rate * (next - t)) / HOUR_MS);
      if (account.remaining <= EPSILON) account.remaining = 0;
    }
    t = next;
    record(t);
    noteEmpty(t);
    if (t >= until) break;

    let delta = 0;
    for (const account of sim) {
      if (account.nextReset === null || account.nextReset > t) continue;
      delta += account.capacity - account.remaining;
      account.remaining = account.capacity;
      account.nextReset = account.periodMs !== null ? account.nextReset + account.periodMs : null;
    }
    if (delta > 0) {
      record(t);
      resets.push({ t, delta, value: totalOf() });
    }
  }

  const merged = mergeResetMarks(resets);
  return {
    points,
    accounts: perAccount,
    drain,
    resets: merged,
    firstEmpty,
    poolEmptyAt,
    // The stat names the first refill; merging is only for chart labels.
    nextReset: resets.find((mark) => mark.t > now && mark.delta >= 0.5) ?? null,
    capacity,
    current: points[0]?.value ?? 0,
  };
}

/** Linear value of a polyline at `t`; after a repeated instant, the later value wins. */
export function valueAt(points: PoolPoint[], t: number): number | null {
  if (points.length === 0 || t < points[0].t || t > points[points.length - 1].t) return null;
  let index = lowerBound(points as Reading[], t);
  while (index + 1 < points.length && points[index + 1].t === t) index += 1;
  const after = points[index];
  if (after.t === t || index === 0) return after.value;
  const before = points[index - 1];
  const span = after.t - before.t;
  return span > 0
    ? before.value + ((after.value - before.value) * (t - before.t)) / span
    : after.value;
}
