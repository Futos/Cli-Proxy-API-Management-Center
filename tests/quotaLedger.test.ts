import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n/index';
import { QuotaGroupCard } from '../src/features/quota/components/QuotaGroupCard';
import { QuotaHistoryPanel } from '../src/features/quota/history/QuotaHistoryPanel';
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
});

describe('quota history panel rendering', () => {
  const history: QuotaHistory = {
    intervalSeconds: 600,
    updatedAt: NOW - 4 * MINUTE,
    credentials: { a: { provider: 'claude' }, b: { provider: 'claude' } },
    samples: Array.from({ length: 13 }, (_, index) => ({
      t: NOW - (120 - index * 10) * MINUTE,
      v: { a: { 'seven-day': 70 - index }, b: { 'seven-day': 90 } },
    })),
  };

  test('shows the summed headroom, burn rate and the drain chart', () => {
    const markup = renderToStaticMarkup(
      createElement(QuotaHistoryPanel, { history, tab: 'claude', providerLabel: 'Claude', now: NOW })
    );
    expect(markup).toContain('148%');
    expect(markup).toContain('/ 200% remaining');
    expect(markup).toContain('~6% per hour');
    expect(markup).toContain('Peak 6 % per hour');
    expect(markup).toContain('All Claude accounts');
    expect(markup).toContain('Gaps mean missing history');
    expect(markup).toContain('role="tablist"');
    expect(markup).toMatch(/aria-label="Drain rate, Last 24 hours: average 6 % per hour/);
    expect(markup).toContain('<path d="M');
  });

  test('explains an empty tab instead of drawing a flat line', () => {
    const markup = renderToStaticMarkup(
      createElement(QuotaHistoryPanel, { history, tab: 'xai', providerLabel: 'xAI', now: NOW })
    );
    expect(markup).toContain('--%');
    expect(markup).toContain('No quota history for this tab yet');
    expect(markup).not.toContain('<svg class');
  });
});
