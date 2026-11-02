/**
 * Quota history: snapshots, merging, and the remaining / drain-rate series.
 *
 * Pure functions — no React, no storage, no clock of their own (`now` is always
 * passed in). Samples come from two places: the browser records every quota read
 * the page performs, and an optional server-side recorder fills the hours the
 * page was closed. Both use the same shape, keyed by auth index, so they merge
 * without knowing about each other.
 */

import { HOUR_MS, MINUTE_MS } from '@/utils/time/durations';
import type { QuotaProviderType } from '../providers/types';

/** Remaining percent (0..100) per window id, per auth index. */
export type QuotaHistoryValues = Record<string, Record<string, number>>;

export interface QuotaHistorySample {
  /** Observation instant, epoch ms. */
  t: number;
  v: QuotaHistoryValues;
}

export interface QuotaHistory {
  /** Expected spacing between recorder samples; sizes the gap tolerance. */
  intervalSeconds: number;
  credentials: Record<string, { provider: string }>;
  samples: QuotaHistorySample[];
  /** Newest write, epoch ms; 0 when nothing was ever recorded. */
  updatedAt: number;
}

export const QUOTA_HISTORY_PROVIDERS: ReadonlySet<QuotaProviderType> = new Set(['claude', 'codex']);

/** Eight days: a week back from the chart's lead-in, plus its first day's burn window. */
export const QUOTA_HISTORY_RETENTION_MS = 8 * 24 * HOUR_MS;
const MAX_SAMPLES = 4000;
const DEFAULT_INTERVAL_SECONDS = 600;
/** Re-reading a quota within this span replaces the previous local sample. */
const SAMPLE_MERGE_MS = MINUTE_MS;

export const emptyQuotaHistory = (): QuotaHistory => ({
  intervalSeconds: DEFAULT_INTERVAL_SECONDS,
  credentials: {},
  samples: [],
  updatedAt: 0,
});

/* ------------------------------------------------------------ snapshots */

interface WindowLike {
  id?: string;
  usedPercent?: number | null;
}

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

/**
 * Remaining percent per window for one successful quota read, or null.
 * Claude and Codex both store percent USED on `windows[]`.
 */
export function quotaHistoryWindows(
  provider: QuotaProviderType,
  quota: { status?: string } | undefined
): Record<string, number> | null {
  if (!QUOTA_HISTORY_PROVIDERS.has(provider) || !quota || quota.status !== 'success') return null;
  const windows = (quota as { windows?: WindowLike[] }).windows ?? [];
  const values: Record<string, number> = {};
  for (const window of windows) {
    if (!window.id || typeof window.usedPercent !== 'number') continue;
    if (!Number.isFinite(window.usedPercent)) continue;
    values[window.id] = Math.round(clampPercent(100 - window.usedPercent) * 100) / 100;
  }
  return Object.keys(values).length > 0 ? values : null;
}

export interface QuotaHistoryObservation {
  authIndex: string;
  provider: QuotaProviderType;
  values: Record<string, number>;
}

/** Record fresh reads; a re-read within a minute replaces that credential's last value. */
export function appendQuotaObservations(
  history: QuotaHistory,
  observations: QuotaHistoryObservation[],
  now: number
): QuotaHistory {
  if (observations.length === 0) return history;
  const credentials = { ...history.credentials };
  const values: QuotaHistoryValues = {};
  for (const observation of observations) {
    credentials[observation.authIndex] = { provider: observation.provider };
    values[observation.authIndex] = observation.values;
  }
  const samples = history.samples.filter((s) => s.t >= now - QUOTA_HISTORY_RETENTION_MS);
  const last = samples[samples.length - 1];
  if (last && now - last.t <= SAMPLE_MERGE_MS) {
    samples[samples.length - 1] = { t: last.t, v: { ...last.v, ...values } };
  } else {
    samples.push({ t: now, v: values });
  }
  return {
    ...history,
    credentials,
    samples: samples.slice(-MAX_SAMPLES),
    updatedAt: now,
  };
}

/* ------------------------------------------------------------- parsing */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseValues(raw: unknown): QuotaHistoryValues | null {
  if (!isRecord(raw)) return null;
  const values: QuotaHistoryValues = {};
  for (const [authIndex, windows] of Object.entries(raw)) {
    if (!isRecord(windows)) continue;
    const parsed: Record<string, number> = {};
    for (const [id, value] of Object.entries(windows)) {
      if (typeof value === 'number' && Number.isFinite(value)) parsed[id] = clampPercent(value);
    }
    if (Object.keys(parsed).length > 0) values[authIndex] = parsed;
  }
  return values;
}

/**
 * Narrow stored or downloaded history. Accepts the recorder's snake_case file
 * and the browser's own camelCase copy; anything malformed is dropped, not thrown.
 */
export function parseQuotaHistory(raw: unknown): QuotaHistory | null {
  if (!isRecord(raw) || !Array.isArray(raw.samples)) return null;
  const interval = Number(raw.intervalSeconds ?? raw.interval_seconds);
  const credentials: QuotaHistory['credentials'] = {};
  if (isRecord(raw.credentials)) {
    for (const [authIndex, meta] of Object.entries(raw.credentials)) {
      if (isRecord(meta) && typeof meta.provider === 'string') {
        credentials[authIndex] = { provider: meta.provider };
      }
    }
  }
  const samples: QuotaHistorySample[] = [];
  for (const sample of raw.samples) {
    if (!isRecord(sample) || typeof sample.t !== 'number' || !Number.isFinite(sample.t)) continue;
    const values = parseValues(sample.v);
    if (values && Object.keys(values).length > 0) samples.push({ t: sample.t, v: values });
  }
  samples.sort((a, b) => a.t - b.t);
  const updatedAt = Number(raw.updatedAt ?? raw.updated_at);
  return {
    intervalSeconds:
      Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL_SECONDS,
    credentials,
    samples,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : (samples[samples.length - 1]?.t ?? 0),
  };
}

/** Union of both sources; samples at the same instant combine per credential. */
export function mergeQuotaHistories(...sources: (QuotaHistory | null)[]): QuotaHistory {
  const present = sources.filter((source): source is QuotaHistory => source !== null);
  if (present.length === 0) return emptyQuotaHistory();
  if (present.length === 1) return present[0];
  const byTime = new Map<number, QuotaHistoryValues>();
  for (const source of present) {
    for (const sample of source.samples) {
      byTime.set(sample.t, { ...byTime.get(sample.t), ...sample.v });
    }
  }
  return {
    intervalSeconds: Math.max(...present.map((source) => source.intervalSeconds)),
    credentials: Object.assign({}, ...present.map((source) => source.credentials)),
    samples: [...byTime].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v })),
    updatedAt: Math.max(...present.map((source) => source.updatedAt)),
  };
}

/* --------------------------------------------------------------- series */

/** Known window lengths in hours; unknown ids fall back to an `<n>h` suffix. */
export function windowHours(id: string): number {
  if (id === 'five-hour') return 5;
  if (id === 'weekly' || id.startsWith('seven-day')) return 168;
  if (id === 'monthly') return 720;
  return Number(/^(\d+)h$/.exec(id)?.[1] ?? 0);
}

export const MAIN_WINDOW_IDS = ['seven-day', 'weekly'];

/**
 * The window each credential is measured by: the account-wide weekly limit,
 * else its longest window (a Codex team seat may only report a monthly one).
 */
export function mainWindows(samples: QuotaHistorySample[]): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  for (const sample of samples) {
    for (const [authIndex, windows] of Object.entries(sample.v)) {
      const ids = seen.get(authIndex) ?? new Set<string>();
      Object.keys(windows).forEach((id) => ids.add(id));
      seen.set(authIndex, ids);
    }
  }
  const main = new Map<string, string>();
  for (const [authIndex, ids] of seen) {
    const preferred = MAIN_WINDOW_IDS.find((id) => ids.has(id));
    main.set(authIndex, preferred ?? [...ids].sort((a, b) => windowHours(b) - windowHours(a))[0]);
  }
  return main;
}

/** Samples further apart than this are a gap, not a slow interval. */
export const maxSampleGapMs = (history: QuotaHistory) =>
  Math.max(2.5 * history.intervalSeconds * 1000, 25 * MINUTE_MS);
