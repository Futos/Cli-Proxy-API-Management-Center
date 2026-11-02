import { describe, expect, test } from 'bun:test';
import { emptyQuotaHistory, type QuotaHistory } from '../src/features/quota/history/model';
import {
  buildPoolAccounts,
  buildPoolRecorded,
  burnRate,
  liveMainWindow,
  nextResetAfter,
  planWeight,
  poolSpan,
  projectPool,
  valueAt,
  type PoolAccount,
} from '../src/features/quota/history/pool';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 9, 27, 15, 0).getTime();
const MAX_GAP = 25 * MINUTE;

const account = (overrides: Partial<PoolAccount> & { authIndex: string }): PoolAccount => ({
  name: overrides.authIndex,
  weight: 1,
  current: 100,
  resetAtMs: null,
  periodHours: null,
  ...overrides,
});

describe('burn rate', () => {
  test('steady usage gives its hourly rate; resets never count as negative usage', () => {
    // 1 % every 10 minutes for 3 hours, with a refill 90 minutes ago.
    const readings = Array.from({ length: 19 }, (_, index) => ({
      t: NOW - (180 - index * 10) * MINUTE,
      value: index === 9 ? 100 : 80 - index,
    }));
    const rate = burnRate(readings, NOW, 3 * HOUR, MAX_GAP);
    // 18 intervals: 16 lose 1 %, the refill and the drop right after it are a
    // +91 rise (ignored) and a 100 → 70 fall (counted). 16 + 30 = 46 over 3 h.
    expect(rate).toBeCloseTo(46 / 3, 6);
  });

  test('needs 15 observed minutes and ignores pairs further apart than the gap', () => {
    const sparse = [
      { t: NOW - 2 * HOUR, value: 90 },
      { t: NOW, value: 60 },
    ];
    expect(burnRate(sparse, NOW, 3 * HOUR, MAX_GAP)).toBeNull();
    const short = [
      { t: NOW - 10 * MINUTE, value: 90 },
      { t: NOW, value: 89 },
    ];
    expect(burnRate(short, NOW, 3 * HOUR, MAX_GAP)).toBeNull();
  });

  test('counts a pair straddling the window start proportionally', () => {
    const readings = [
      { t: NOW - 70 * MINUTE, value: 50 },
      { t: NOW - 50 * MINUTE, value: 46 },
      { t: NOW - 30 * MINUTE, value: 42 },
      { t: NOW - 10 * MINUTE, value: 38 },
      { t: NOW, value: 36 },
    ];
    // Inside the last hour: half of the first 4 % drop, then 4 + 4 + 2 = 12 % over 60 min.
    expect(burnRate(readings, NOW, HOUR, MAX_GAP)).toBeCloseTo(12, 6);
  });
});

describe('pool projection', () => {
  test('drains, empties and refills one account at its weekly reset', () => {
    const forecast = projectPool(
      [account({ authIndex: 'a', current: 50, resetAtMs: NOW + 10 * HOUR, periodHours: 168 })],
      new Map([['a', 10]]),
      1,
      NOW,
      NOW + 14 * DAY
    );
    expect(forecast.capacity).toBe(100);
    expect(forecast.current).toBe(50);
    expect(forecast.firstEmpty).toEqual({ t: NOW + 5 * HOUR, authIndex: 'a' });
    expect(forecast.poolEmptyAt).toBe(NOW + 5 * HOUR);
    expect(forecast.nextReset).toEqual({ t: NOW + 10 * HOUR, delta: 100, value: 100 });
    expect(forecast.resets.map((mark) => mark.t)).toEqual([NOW + 10 * HOUR, NOW + 178 * HOUR]);
    expect(valueAt(forecast.points, NOW + 2 * HOUR)).toBeCloseTo(30, 6);
    expect(valueAt(forecast.points, NOW + 10 * HOUR)).toBe(100);
    expect(valueAt(forecast.points, NOW + 12 * HOUR)).toBeCloseTo(80, 6);
  });

  test("moves an exhausted account's demand to the accounts that still have quota", () => {
    const forecast = projectPool(
      [account({ authIndex: 'a', current: 10 }), account({ authIndex: 'b', current: 100 })],
      new Map([
        ['a', 10],
        ['b', 0],
      ]),
      1,
      NOW,
      NOW + 14 * DAY
    );
    expect(forecast.firstEmpty).toEqual({ t: NOW + HOUR, authIndex: 'a' });
    // b picks up a's 10 %/h once a is out, so the pool keeps draining linearly.
    expect(forecast.poolEmptyAt).toBe(NOW + 11 * HOUR);
    expect(valueAt(forecast.points, NOW + 6 * HOUR)).toBeCloseTo(50, 6);
    expect(valueAt(forecast.drain, NOW + 6 * HOUR)).toBe(10);
    expect(valueAt(forecast.drain, NOW + 12 * HOUR)).toBe(0);
  });

  test('scales future usage and treats no usage as a flat line', () => {
    const accounts = [account({ authIndex: 'a', current: 60 })];
    const rates = new Map([['a', 10]]);
    expect(projectPool(accounts, rates, 2, NOW, NOW + DAY).poolEmptyAt).toBe(NOW + 3 * HOUR);
    const idle = projectPool(accounts, rates, 0, NOW, NOW + DAY);
    expect(idle.poolEmptyAt).toBeNull();
    expect(idle.firstEmpty).toBeNull();
    expect(valueAt(idle.points, NOW + 20 * HOUR)).toBe(60);
  });

  test('merges resets that land together into one step', () => {
    const forecast = projectPool(
      [
        account({ authIndex: 'a', current: 40, resetAtMs: NOW + 5 * HOUR, periodHours: 168 }),
        account({
          authIndex: 'b',
          current: 70,
          resetAtMs: NOW + 5 * HOUR + 10 * MINUTE,
          periodHours: 168,
        }),
      ],
      new Map(),
      1,
      NOW,
      NOW + DAY
    );
    expect(forecast.resets).toEqual([{ t: NOW + 5 * HOUR + 10 * MINUTE, delta: 90, value: 200 }]);
    // The stat names the first refill, not the merged label.
    expect(forecast.nextReset).toEqual({ t: NOW + 5 * HOUR, delta: 60, value: 170 });
  });

  test('rolls a stale reset anchor forward by whole periods', () => {
    expect(nextResetAfter(NOW - HOUR, 5, NOW)).toBe(NOW + 4 * HOUR);
    expect(nextResetAfter(NOW - 5 * HOUR, 5, NOW)).toBe(NOW + 5 * HOUR);
    expect(nextResetAfter(NOW - HOUR, null, NOW)).toBeNull();
    expect(nextResetAfter(NOW + HOUR, 5, NOW)).toBe(NOW + HOUR);
  });
});

describe('pool accounts', () => {
  test('reads the weekly window from live quota and weights Codex Pro', () => {
    const quota = {
      status: 'success',
      planType: 'pro',
      windows: [
        { id: 'five-hour', usedPercent: 90, resetAtMs: NOW + HOUR, periodHours: 5 },
        { id: 'weekly', usedPercent: 30, resetAtMs: NOW + DAY, periodHours: 168 },
      ],
    };
    expect(liveMainWindow(quota)).toEqual({
      id: 'weekly',
      remaining: 70,
      resetAtMs: NOW + DAY,
      periodHours: 168,
    });
    expect(planWeight('codex', 'pro')).toBe(2.5);
    expect(planWeight('codex', 'plus')).toBe(1);
    expect(planWeight('claude', 'pro')).toBe(1);

    const accounts = buildPoolAccounts(
      [
        { authIndex: 'x', name: 'x.json', provider: 'codex', quota },
        { authIndex: 'y', name: 'y.json', provider: 'codex', quota: undefined },
        { authIndex: 'z', name: 'z.json', provider: 'codex', quota: undefined },
      ],
      new Map([['y', [{ t: NOW - HOUR, value: 40 }]]])
    );
    expect(accounts.map((a) => [a.authIndex, a.weight, a.current, a.resetAtMs])).toEqual([
      ['x', 2.5, 70, NOW + DAY],
      ['y', 1, 40, null],
    ]);
    // A newer recorder reading beats an older cached live read.
    const fresher = buildPoolAccounts(
      [{ authIndex: 'x', name: 'x.json', provider: 'codex', quota }],
      new Map([['x', [{ t: NOW, value: 55 }]]])
    );
    expect(fresher[0]).toMatchObject({ current: 55, resetAtMs: NOW + DAY, weight: 2.5 });

    const forecast = projectPool(accounts, new Map(), 1, NOW, NOW + HOUR);
    expect(forecast.capacity).toBe(350);
    expect(forecast.current).toBe(215);
  });
});

describe('recorded pool', () => {
  const history: QuotaHistory = {
    ...emptyQuotaHistory(),
    credentials: { a: { provider: 'claude' }, b: { provider: 'claude' } },
    samples: [
      { t: NOW - 3 * HOUR, v: { a: { 'seven-day': 30 } } },
      { t: NOW - 3 * HOUR + 10 * MINUTE, v: { a: { 'seven-day': 28 } } },
      // b is first read here; it is held at this value back to the start.
      { t: NOW - 3 * HOUR + 20 * MINUTE, v: { a: { 'seven-day': 26 }, b: { 'seven-day': 80 } } },
      // Gap of 100 minutes, then a refilled.
      { t: NOW - HOUR, v: { a: { 'seven-day': 100 }, b: { 'seven-day': 78 } } },
      { t: NOW - 50 * MINUTE, v: { a: { 'seven-day': 99 } } },
    ],
  };

  test('back-fills late accounts, holds readings and splits at gaps', () => {
    const recorded = buildPoolRecorded(
      history,
      [
        { authIndex: 'a', weight: 1 },
        { authIndex: 'b', weight: 2 },
      ],
      NOW - 6 * HOUR,
      NOW,
      3 * HOUR
    );
    expect(recorded.segments.map((run) => run.map((point) => point.value))).toEqual([
      [190, 188, 186],
      [256, 255],
    ]);
    expect(recorded.resets).toEqual([{ t: NOW - HOUR, delta: 74, value: 256 }]);
    expect(Object.keys(recorded.accounts).sort()).toEqual(['a', 'b']);
    expect(recorded.drain[0].length).toBeGreaterThan(0);
  });
});

describe('pool span', () => {
  test('starts three days before today and moves a week at a time', () => {
    const today = new Date(NOW);
    today.setHours(0, 0, 0, 0);
    const span = poolSpan(0, NOW);
    expect(new Date(span.startMs).getDate()).toBe(24);
    expect(span.startMs).toBeLessThan(today.getTime());
    expect(new Date(span.endMs).getDate()).toBe(7);
    expect(new Date(poolSpan(-1, NOW).startMs).getDate()).toBe(17);
    expect(new Date(poolSpan(1, NOW).startMs).getDate()).toBe(31);
  });
});
