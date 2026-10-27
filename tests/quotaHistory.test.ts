import { describe, expect, test } from 'bun:test';
import {
  appendQuotaObservations,
  buildQuotaHistorySeries,
  credentialsForTab,
  emptyQuotaHistory,
  mainWindows,
  mergeQuotaHistories,
  parseQuotaHistory,
  quotaHistoryWindows,
  type QuotaHistory,
} from '../src/features/quota/history/model';
import { formatQuotaPercent } from '../src/features/quota/history/format';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = new Date(2026, 9, 27, 15, 0).getTime();
const DAY_RANGE = 24 * HOUR;

/** Samples every 10 minutes up to NOW; `value` returns remaining % or null for a gap. */
function history(
  minutes: number,
  value: (authIndex: string, ago: number) => number | null,
  credentials: Record<string, string> = { a: 'claude', b: 'codex' }
): QuotaHistory {
  const samples = [];
  for (let ago = minutes; ago >= 0; ago -= 10) {
    const v: Record<string, Record<string, number>> = {};
    for (const authIndex of Object.keys(credentials)) {
      const remaining = value(authIndex, ago);
      if (remaining !== null) v[authIndex] = { 'seven-day': remaining, 'five-hour': 50 };
    }
    if (Object.keys(v).length > 0) samples.push({ t: NOW - ago * MINUTE, v });
  }
  return {
    intervalSeconds: 600,
    updatedAt: NOW,
    samples,
    credentials: Object.fromEntries(
      Object.entries(credentials).map(([authIndex, provider]) => [authIndex, { provider }])
    ),
  };
}

describe('quota history series', () => {
  test('steady usage gives a constant hourly drain rate and the summed headroom', () => {
    // a loses 1 % every 10 minutes = 6 % per hour; b stays flat.
    const data = history(180, (id, ago) => (id === 'a' ? 50 + ago / 10 : 80));
    const series = buildQuotaHistorySeries(data, credentialsForTab(data, 'all'), DAY_RANGE, NOW);
    expect(series.averageDrain).toBeCloseTo(6, 6);
    expect(series.peakDrain).toBeCloseTo(6, 6);
    expect(series.latest).toEqual({ t: NOW, value: 130, capacity: 200 });
    expect(series.mainWindowIds).toEqual(['seven-day']);
  });

  test('excludes resets and filters by provider tab', () => {
    // a refills from 10 % to 100 % half an hour ago; nothing is used.
    const data = history(120, (id, ago) => (id === 'a' ? (ago > 30 ? 10 : 100) : 70));
    const claude = buildQuotaHistorySeries(data, credentialsForTab(data, 'claude'), DAY_RANGE, NOW);
    expect(claude.averageDrain).toBe(0);
    expect(claude.latest?.value).toBe(100);
    const codex = buildQuotaHistorySeries(data, credentialsForTab(data, 'codex'), DAY_RANGE, NOW);
    expect(codex.latest?.value).toBe(70);
    expect(credentialsForTab(data, 'xai').size).toBe(0);
  });

  test('leaves gaps for missing history instead of inventing values', () => {
    // Nothing recorded between 300 and 100 minutes ago.
    const data = history(400, (_id, ago) => (ago < 100 || ago > 300 ? 90 : null));
    const series = buildQuotaHistorySeries(data, credentialsForTab(data, 'all'), DAY_RANGE, NOW);
    const afterGap = series.drain.find((point) => NOW - point.t < 100 * MINUTE);
    expect(afterGap?.value).toBeNull();
    expect(series.drain.some((point) => point.value === 0)).toBe(true);
    const gapPoint = series.remaining.find((point) => NOW - point.t === 200 * MINUTE);
    expect(gapPoint).toBeUndefined();
  });

  test('pairs each credential with its own previous reading across sparse samples', () => {
    // Browser samples (a only) interleave with recorder samples (a and b).
    const data: QuotaHistory = {
      ...emptyQuotaHistory(),
      credentials: { a: { provider: 'claude' }, b: { provider: 'claude' } },
      samples: [
        { t: NOW - 60 * MINUTE, v: { a: { 'seven-day': 90 }, b: { 'seven-day': 90 } } },
        { t: NOW - 45 * MINUTE, v: { a: { 'seven-day': 88 } } },
        { t: NOW - 40 * MINUTE, v: { a: { 'seven-day': 87 }, b: { 'seven-day': 84 } } },
      ],
    };
    const series = buildQuotaHistorySeries(data, credentialsForTab(data, 'all'), HOUR, NOW);
    // a used 3 %, b used 6 % over 20 observed minutes = 27 % per hour.
    expect(series.averageDrain).toBeCloseTo(27, 6);
    expect(series.latest).toMatchObject({ value: 171, capacity: 200 });
  });

  test('measures a credential without a weekly window by its longest one', () => {
    const samples = [
      { t: NOW - 10 * MINUTE, v: { m: { monthly: 72, 'five-hour': 90 } } },
      { t: NOW, v: { m: { monthly: 71 } } },
    ];
    expect(mainWindows(samples).get('m')).toBe('monthly');
    const data = { ...emptyQuotaHistory(), credentials: { m: { provider: 'codex' } }, samples };
    const series = buildQuotaHistorySeries(data, new Set(['m']), DAY_RANGE, NOW);
    expect(series.latest?.value).toBe(71);
    expect(mainWindows([{ t: 0, v: { c: { weekly: 1, monthly: 2 } } }]).get('c')).toBe('weekly');
  });
});

describe('quota history records and sources', () => {
  test('captures remaining percent from successful Claude and Codex reads only', () => {
    const quota = {
      status: 'success',
      windows: [
        { id: 'five-hour', usedPercent: 2 },
        { id: 'seven-day', usedPercent: 114 },
        { id: 'seven-day-fable', usedPercent: null },
      ],
    };
    expect(quotaHistoryWindows('claude', quota)).toEqual({ 'five-hour': 98, 'seven-day': 0 });
    expect(quotaHistoryWindows('codex', { ...quota, status: 'error' })).toBeNull();
    expect(quotaHistoryWindows('kimi', quota)).toBeNull();
  });

  test('a re-read within a minute replaces the last sample instead of adding one', () => {
    const first = appendQuotaObservations(
      emptyQuotaHistory(),
      [{ authIndex: 'a', provider: 'claude', values: { 'seven-day': 80 } }],
      NOW
    );
    const reread = appendQuotaObservations(
      first,
      [{ authIndex: 'b', provider: 'codex', values: { weekly: 50 } }],
      NOW + 30_000
    );
    expect(reread.samples).toEqual([
      { t: NOW, v: { a: { 'seven-day': 80 }, b: { weekly: 50 } } },
    ]);
    const later = appendQuotaObservations(
      reread,
      [{ authIndex: 'a', provider: 'claude', values: { 'seven-day': 79 } }],
      NOW + 10 * MINUTE
    );
    expect(later.samples).toHaveLength(2);
    expect(later.credentials).toEqual({ a: { provider: 'claude' }, b: { provider: 'codex' } });
  });

  test('drops samples beyond retention when recording', () => {
    const old = { ...emptyQuotaHistory(), samples: [{ t: NOW - 9 * DAY_RANGE, v: { a: { x: 1 } } }] };
    const next = appendQuotaObservations(
      old,
      [{ authIndex: 'a', provider: 'claude', values: { 'seven-day': 1 } }],
      NOW
    );
    expect(next.samples.map((sample) => sample.t)).toEqual([NOW]);
  });

  test('parses the recorder file and ignores malformed entries', () => {
    const parsed = parseQuotaHistory({
      version: 1,
      interval_seconds: 600,
      updated_at: NOW,
      credentials: { a: { provider: 'claude' }, bad: 'x' },
      samples: [
        { t: NOW, v: { a: { 'seven-day': 86, junk: 'x' } } },
        { t: 'later', v: {} },
        { t: NOW - MINUTE, v: { a: { 'five-hour': 120 } } },
      ],
    });
    expect(parsed).toEqual({
      intervalSeconds: 600,
      updatedAt: NOW,
      credentials: { a: { provider: 'claude' } },
      samples: [
        { t: NOW - MINUTE, v: { a: { 'five-hour': 100 } } },
        { t: NOW, v: { a: { 'seven-day': 86 } } },
      ],
    });
    expect(parseQuotaHistory({ samples: 'nope' })).toBeNull();
    expect(parseQuotaHistory(null)).toBeNull();
  });

  test('merges browser and recorder samples by instant', () => {
    const local = {
      ...emptyQuotaHistory(),
      updatedAt: NOW,
      credentials: { a: { provider: 'claude' } },
      samples: [{ t: NOW, v: { a: { 'seven-day': 80 } } }],
    };
    const server = {
      ...emptyQuotaHistory(),
      updatedAt: NOW - MINUTE,
      credentials: { b: { provider: 'codex' } },
      samples: [
        { t: NOW - MINUTE, v: { b: { weekly: 60 } } },
        { t: NOW, v: { b: { weekly: 59 } } },
      ],
    };
    const merged = mergeQuotaHistories(local, server);
    expect(merged.samples).toEqual([
      { t: NOW - MINUTE, v: { b: { weekly: 60 } } },
      { t: NOW, v: { a: { 'seven-day': 80 }, b: { weekly: 59 } } },
    ]);
    expect(Object.keys(merged.credentials).sort()).toEqual(['a', 'b']);
    expect(merged.updatedAt).toBe(NOW);
    expect(mergeQuotaHistories(local, null)).toBe(local);
  });

  test('formats percentages like the screenshot headline', () => {
    expect(formatQuotaPercent(458.4)).toBe('458');
    expect(formatQuotaPercent(2.34)).toBe('2.3');
    expect(formatQuotaPercent(0)).toBe('0');
    expect(formatQuotaPercent(null)).toBe('--');
  });
});
