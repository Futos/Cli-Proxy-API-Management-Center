import { describe, expect, test } from 'bun:test';
import {
  appendQuotaObservations,
  emptyQuotaHistory,
  mainWindows,
  mergeQuotaHistories,
  parseQuotaHistory,
  quotaHistoryWindows,
} from '../src/features/quota/history/model';
import { formatQuotaPercent } from '../src/features/quota/history/format';

const MINUTE = 60_000;
const NOW = new Date(2026, 9, 27, 15, 0).getTime();

describe('quota history main windows', () => {
  test('measures a credential by its weekly window, else its longest one', () => {
    const samples = [
      { t: NOW - 10 * MINUTE, v: { m: { monthly: 72, 'five-hour': 90 } } },
      { t: NOW, v: { m: { monthly: 71 }, s: { 'seven-day': 40, 'five-hour': 10 } } },
    ];
    expect(mainWindows(samples).get('m')).toBe('monthly');
    expect(mainWindows(samples).get('s')).toBe('seven-day');
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
    const old = { ...emptyQuotaHistory(), samples: [{ t: NOW - 9 * 24 * 60 * MINUTE, v: { a: { x: 1 } } }] };
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
