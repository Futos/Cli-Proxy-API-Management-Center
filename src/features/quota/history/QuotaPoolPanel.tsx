/**
 * Quota pool panel: one forecast card per provider with recorded history, the
 * projection after now, and the four numbers that matter — when the pool runs
 * dry, which account runs out first, the next refill, and the current burn.
 *
 * The toolbar is shared by every card: chart mode, the window the burn rate is
 * measured over, how future usage compares with now, per-account lines, and the
 * visible two-week span.
 */

import { useCallback, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronLeft, IconChevronRight } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { useNow } from '@/hooks/useNow';
import type { ResolvedTheme } from '@/types';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';
import type { QuotaTabId } from '../constants';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import { readQuotaUiState, writeQuotaUiState } from '../uiState';
import type { QuotaHistory } from './model';
import {
  POOL_BURN_WINDOWS,
  POOL_FUTURE_USAGE,
  POOL_OFFSET_MAX,
  POOL_OFFSET_MIN,
  POOL_PROVIDERS,
  isPoolProvider,
  poolSpan,
  type PoolBurnWindow,
  type PoolFutureUsage,
  type PoolMode,
  type PoolProvider,
} from './pool';
import { QuotaPoolCard } from './QuotaPoolCard';
import styles from './QuotaPoolPanel.module.scss';

export interface QuotaPoolPanelProps {
  history: QuotaHistory;
  tab: QuotaTabId;
  entries: QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  resolvedTheme: ResolvedTheme;
  /** Fixed clock for tests; the panel otherwise ticks once a minute on its own. */
  now?: number;
}

export function QuotaPoolPanel(props: QuotaPoolPanelProps) {
  const { history, tab, entries, quotaFor, resolvedTheme } = props;
  const clock = useNow(props.now === undefined);
  const now = props.now ?? clock;
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const burnLabelId = useId();

  const [mode, setMode] = useState<PoolMode>(() => readQuotaUiState()?.poolMode ?? 'remaining');
  const [burnWindow, setBurnWindow] = useState<PoolBurnWindow>(
    () => readQuotaUiState()?.poolBurnWindow ?? 3
  );
  const [futureUsage, setFutureUsage] = useState<PoolFutureUsage>(
    () => readQuotaUiState()?.poolFutureUsage ?? 'same'
  );
  const [showAccounts, setShowAccounts] = useState(
    () => readQuotaUiState()?.poolShowAccounts ?? false
  );
  const [offset, setOffset] = useState(0);

  const changeMode = useCallback((next: PoolMode) => {
    setMode(next);
    writeQuotaUiState({ poolMode: next });
  }, []);
  const changeBurnWindow = useCallback((next: PoolBurnWindow) => {
    setBurnWindow(next);
    writeQuotaUiState({ poolBurnWindow: next });
  }, []);
  const changeFutureUsage = useCallback((next: string) => {
    const option = POOL_FUTURE_USAGE.find((candidate) => candidate.id === next);
    if (!option) return;
    setFutureUsage(option.id);
    writeQuotaUiState({ poolFutureUsage: option.id });
  }, []);
  const toggleAccounts = useCallback(() => {
    setShowAccounts((current) => {
      writeQuotaUiState({ poolShowAccounts: !current });
      return !current;
    });
  }, []);

  const futureOptions = useMemo(
    () =>
      POOL_FUTURE_USAGE.map((option) => ({
        value: option.id,
        label: t(`quota_pool.future_${option.id}`),
      })),
    [t]
  );

  /** Pool members per provider, in tab order; disabled credentials are not in rotation. */
  const pools = useMemo(() => {
    const providers: PoolProvider[] =
      tab === 'all' ? [...POOL_PROVIDERS] : isPoolProvider(tab) ? [tab] : [];
    return providers
      .map((provider) => ({
        provider,
        inputs: entries
          .filter((entry) => entry.type === provider && !entry.file.disabled)
          .map((entry) => ({
            authIndex: normalizeAuthIndex(entry.file['auth_index'] ?? entry.file.authIndex) ?? '',
            name: entry.file.name,
            provider,
            quota: quotaFor(entry),
          }))
          .filter((input) => input.authIndex !== ''),
      }))
      .filter((pool) => pool.inputs.length > 0);
  }, [entries, quotaFor, tab]);

  const span = useMemo(() => poolSpan(offset, now), [offset, now]);
  const formatDate = useCallback(
    (ms: number) => new Date(ms).toLocaleDateString(locale, { month: 'short', day: 'numeric' }),
    [locale]
  );

  if (pools.length === 0) return null;

  const rangeLabel = t('quota_pool.range', {
    from: formatDate(span.startMs),
    to: formatDate(span.endMs - DAY_MS / 2),
  });

  return (
    <section className={styles.panel} aria-label={t('quota_pool.title')}>
      <div className={styles.toolbar}>
        <div className={styles.segmented} role="group" aria-label={t('quota_pool.mode_label')}>
          {(['remaining', 'drain'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={styles.segment}
              aria-pressed={mode === value}
              onClick={() => changeMode(value)}
            >
              {t(`quota_pool.mode_${value}`)}
            </button>
          ))}
        </div>

        <div className={styles.field}>
          <span className={styles.fieldLabel} id={burnLabelId}>
            {t('quota_pool.burn_label')}
          </span>
          <div className={styles.segmented} role="group" aria-labelledby={burnLabelId}>
            {POOL_BURN_WINDOWS.map((hours) => (
              <button
                key={hours}
                type="button"
                className={styles.segment}
                aria-pressed={burnWindow === hours}
                onClick={() => changeBurnWindow(hours)}
              >
                {t('quota_pool.hours_short', { hours })}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.field}>
          <span className={styles.fieldLabel} aria-hidden="true">
            {t('quota_pool.future_label')}
          </span>
          <div className={styles.select}>
            <Select
              value={futureUsage}
              options={futureOptions}
              onChange={changeFutureUsage}
              ariaLabel={t('quota_pool.future_label')}
              size="sm"
            />
          </div>
        </div>

        <button
          type="button"
          className={styles.toggle}
          aria-pressed={showAccounts}
          onClick={toggleAccounts}
        >
          {t('quota_pool.accounts')}
        </button>

        <div className={styles.range}>
          <span className={styles.rangeLabel} aria-live="polite">
            {rangeLabel}
          </span>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => setOffset((value) => Math.max(POOL_OFFSET_MIN, value - 1))}
            disabled={offset <= POOL_OFFSET_MIN}
            aria-label={t('quota_pool.prev')}
            title={t('quota_pool.prev')}
          >
            <IconChevronLeft size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.today}
            onClick={() => setOffset(0)}
            aria-pressed={offset === 0}
          >
            {t('quota_pool.today')}
          </button>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => setOffset((value) => Math.min(POOL_OFFSET_MAX, value + 1))}
            disabled={offset >= POOL_OFFSET_MAX}
            aria-label={t('quota_pool.next')}
            title={t('quota_pool.next')}
          >
            <IconChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      </div>

      {pools.map((pool) => (
        <QuotaPoolCard
          key={pool.provider}
          provider={pool.provider}
          inputs={pool.inputs}
          history={history}
          mode={mode}
          burnWindowMs={burnWindow * HOUR_MS}
          burnWindowHours={burnWindow}
          futureUsage={futureUsage}
          showAccounts={showAccounts}
          span={span}
          now={now}
          resolvedTheme={resolvedTheme}
        />
      ))}
    </section>
  );
}
