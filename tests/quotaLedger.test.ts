import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n/index';
import { QuotaGroupCard } from '../src/features/quota/components/QuotaGroupCard';
import { QuotaPoolPanel } from '../src/features/quota/history/QuotaPoolPanel';
import {
  groupQuotaEntries,
  sumQuotaWindows,
  type QuotaFileEntry,
} from '../src/features/quota/logic';
import type { QuotaHistory } from '../src/features/quota/history/model';

const MINUTE = 60_000;
let previousLanguage = '';

beforeAll(async () => {
  previousLanguage = i18n.language;
  await i18n.changeLanguage('en');
});

afterAll(async () => {
  await i18n.changeLanguage(previousLanguage);
});

const NOW = new Date(2026, 9, 27, 15, 0).getTime();

const entry = (name: string, type: QuotaFileEntry['type']): QuotaFileEntry => ({
  file: { name, type, auth_index: name },
  type,
});

describe('ledger grouping', () => {
  test('groups in first-appearance order and keeps the sort inside each group', () => {
    const entries = [entry('c1', 'claude'), entry('x1', 'codex'), entry('c2', 'claude')];
    expect(groupQuotaEntries(entries).map((g) => [g.type, g.entries.map((e) => e.file.name)])).toEqual([
      ['claude', ['c1', 'c2']],
      ['codex', ['x1']],
    ]);
  });

  test('sums each window over loaded reads, longest window first', () => {
    const quotas: Record<string, unknown> = {
      c1: {
        status: 'success',
        windows: [
          { id: 'five-hour', label: '5h', usedPercent: 10, periodHours: 5 },
          { id: 'seven-day', label: '7d', usedPercent: 40, periodHours: 168 },
        ],
      },
      c2: { status: 'success', windows: [{ id: 'seven-day', label: '7d', usedPercent: 130, periodHours: 168 }] },
      c3: { status: 'error', windows: [] },
    };
    const totals = sumQuotaWindows(
      [entry('c1', 'claude'), entry('c2', 'claude'), entry('c3', 'claude')],
      (e) => quotas[e.file.name] as { status: string }
    );
    expect(totals.map((total) => [total.id, total.remaining, total.count])).toEqual([
      ['seven-day', 60, 2],
      ['five-hour', 90, 1],
    ]);
  });
});

describe('ledger rendering', () => {
  test('group card lists totals and exposes the rows toggle', () => {
    const markup = renderToStaticMarkup(
      createElement(QuotaGroupCard, {
        type: 'claude',
        count: 7,
        totals: [{ id: 'seven-day-fable', label: '7-day Fable', remaining: 686, count: 7 }],
        resolvedTheme: 'dark',
        collapsed: false,
        rowsId: 'rows-claude',
        onToggle: () => {},
      })
    );
    expect(markup).toContain('Claude');
    expect(markup).toContain('7 credentials');
    expect(markup).toContain('7-day Fable<b>686%</b>');
    expect(markup).toContain('aria-controls="rows-claude"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('>Hide</button>');
  });

  test('row layout is a class on the same card, styled side by side', () => {
    const card = readFileSync('src/features/quota/components/QuotaCard.tsx', 'utf8');
    const styles = readFileSync('src/features/quota/components/QuotaCard.module.scss', 'utf8');
    expect(card).toContain("layout === 'row' ? styles.row : ''");
    expect(styles).toMatch(/\.row \{[^}]*grid-template-columns: minmax\(140px, 200px\) minmax\(0, 1fr\) auto;/);
    const page = readFileSync('src/features/quota/QuotaPage.tsx', 'utf8');
    expect(page).toContain("renderCard(entry, pageItems.indexOf(entry), 'row')");
    expect(page).toContain('hidden={collapsed}');
  });

  test('row layout lets reset telemetry wrap inside its window column', () => {
    const body = readFileSync('src/features/quota/components/QuotaBody.module.scss', 'utf8');
    const rowBlock = body.slice(body.indexOf(":global([data-quota-layout='row'])"));
    // A non-shrinking meta keeps its max-content width and spills into the next column.
    expect(rowBlock).toMatch(/\.quotaMeta \{[^}]*flex-shrink: 1;[^}]*min-width: 0;/);
  });
});

describe('quota pool panel rendering', () => {
  const history: QuotaHistory = {
    intervalSeconds: 600,
    updatedAt: NOW - 4 * MINUTE,
    credentials: { a: { provider: 'claude' }, b: { provider: 'claude' } },
    samples: Array.from({ length: 13 }, (_, index) => ({
      t: NOW - (120 - index * 10) * MINUTE,
      v: { a: { 'seven-day': 70 - index }, b: { 'seven-day': 90 } },
    })),
  };
  const entries = [entry('a', 'claude'), entry('b', 'claude'), entry('k', 'kimi')];
  const quotaFor = (item: QuotaFileEntry) =>
    item.file.name === 'a'
      ? ({
          status: 'success',
          windows: [
            {
              id: 'seven-day',
              usedPercent: 42,
              resetAtMs: NOW + 30 * 60 * MINUTE,
              periodHours: 168,
            },
          ],
        } as unknown as ReturnType<Parameters<typeof QuotaPoolPanel>[0]['quotaFor']>)
      : undefined;

  const render = (tab: Parameters<typeof QuotaPoolPanel>[0]['tab']) =>
    renderToStaticMarkup(
      createElement(QuotaPoolPanel, {
        history,
        tab,
        entries,
        quotaFor,
        resolvedTheme: 'dark',
        now: NOW,
      })
    );

  test('shows the pool headline, forecast stats and recorded/projected chart', () => {
    const markup = render('claude');
    // a is live at 58 %, b falls back to its last recorded 90 %.
    expect(markup).toContain('148%');
    expect(markup).toContain('of 200%');
    expect(markup).toContain('2 accounts');
    expect(markup).toContain('Pool empty');
    expect(markup).toContain('First empty');
    expect(markup).toContain('Next reset');
    expect(markup).toContain('Burn, last 3h');
    // a loses 1 % per 10 minutes = 6 %/h; b is flat.
    expect(markup).toContain('6%/h');
    // a runs dry in 9h 40m, so its reset 30 h out refills the full 100 %.
    expect(markup).toContain('in 9h 40m');
    expect(markup).toContain('+100%');
    expect(markup).not.toMatch(/<td>--<\/td><td>projected/);
    expect(markup).toContain('Recorded');
    expect(markup).toContain('Projected');
    expect(markup).toContain('>Now<');
    expect(markup).toContain('quota-sensitive');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('<path d="M');
  });

  test('renders nothing on a tab without pool history', () => {
    expect(render('kimi')).toBe('');
  });
});

describe('quota page sections', () => {
  test('leaves the quota windows timeline off the page; the pool forecast replaces it', () => {
    const source = readFileSync('src/features/quota/QuotaPage.tsx', 'utf8');
    expect(source).not.toContain('QuotaTimeline');
    expect(source).toContain('<QuotaPoolPanel');
  });
});
