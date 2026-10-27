/**
 * Quota history panel: summed main-limit headroom for the active tab, the
 * current burn rate, and a remaining / drain-rate chart over a chosen range.
 *
 * The headline sums each credential's main limit (7-day, else its longest
 * window), so "458% / 700%" reads as "4.6 of 7 accounts' weekly quota left".
 */

import { useCallback, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronUp } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { useNow } from '@/hooks/useNow';
import { formatRelativeInstant } from '@/utils/quota/relativeTime';
import { HOUR_MS, MINUTE_MS } from '@/utils/time/durations';
import type { QuotaTabId } from '../constants';
import { readQuotaUiState, writeQuotaUiState } from '../uiState';
import {
  QUOTA_HISTORY_RANGES,
  buildQuotaHistorySeries,
  credentialsForTab,
  findQuotaHistoryRange,
  type QuotaHistory,
  type QuotaHistoryMode,
  type QuotaHistoryRangeId,
} from './model';
import { formatQuotaPercent } from './format';
import { QuotaHistoryChart } from './QuotaHistoryChart';
import styles from './QuotaHistoryPanel.module.scss';

export interface QuotaHistoryPanelProps {
  history: QuotaHistory;
  tab: QuotaTabId;
  /** Display name of the active provider tab; unused for `all`. */
  providerLabel: string;
  /** Fixed clock for tests; the panel otherwise ticks once a minute on its own. */
  now?: number;
}

export function QuotaHistoryPanel(props: QuotaHistoryPanelProps) {
  const { history, tab, providerLabel } = props;
  const clock = useNow(props.now === undefined);
  const now = props.now ?? clock;
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const bodyId = useId();
  const [mode, setMode] = useState<QuotaHistoryMode>(
    () => readQuotaUiState()?.historyMode ?? 'drain'
  );
  const [rangeId, setRangeId] = useState<QuotaHistoryRangeId>(
    () => readQuotaUiState()?.historyRange ?? '24h'
  );
  const [collapsed, setCollapsed] = useState(() => readQuotaUiState()?.historyCollapsed ?? false);
  const range = findQuotaHistoryRange(rangeId);

  const credentials = useMemo(() => credentialsForTab(history, tab), [history, tab]);
  const series = useMemo(
    () => buildQuotaHistorySeries(history, credentials, range.ms, now),
    [history, credentials, range.ms, now]
  );

  const changeMode = useCallback((next: QuotaHistoryMode) => {
    setMode(next);
    writeQuotaUiState({ historyMode: next });
  }, []);
  const changeRange = useCallback((next: string) => {
    const id = findQuotaHistoryRange(next).id;
    setRangeId(id);
    writeQuotaUiState({ historyRange: id });
  }, []);
  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      writeQuotaUiState({ historyCollapsed: !current });
      return !current;
    });
  }, []);

  const rangeOptions = useMemo(
    () =>
      QUOTA_HISTORY_RANGES.map((r) => ({ value: r.id, label: t(`quota_history.range_${r.id}`) })),
    [t]
  );

  const formatTime = useCallback(
    (ms: number) =>
      new Date(ms).toLocaleString(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' }),
    [locale]
  );
  const formatTick = useCallback(
    (ms: number) =>
      range.ms > 24 * HOUR_MS
        ? new Date(ms).toLocaleDateString(locale, { weekday: 'short', day: 'numeric' })
        : new Date(ms).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }),
    [locale, range.ms]
  );

  const hasHistory = credentials.size > 0;
  const latest = series.latest;
  const drainMode = mode === 'drain';
  const unit = drainMode ? t('quota_history.unit_drain') : t('quota_history.unit_remaining');
  const rangeLabel = t(`quota_history.range_${range.id}`);
  const remainingLow = series.remaining.reduce<number | null>(
    (low, point) =>
      point.value === null || (low !== null && low <= point.value) ? low : point.value,
    null
  );

  const footer = (
    <p className={styles.foot}>
      <strong>
        {drainMode
          ? t('quota_history.peak', { value: formatQuotaPercent(series.peakDrain) })
          : t('quota_history.low', { value: formatQuotaPercent(remainingLow) })}
      </strong>
      <span>
        {tab === 'all'
          ? t('quota_history.scope_all')
          : t('quota_history.scope_provider', { provider: providerLabel })}
        {' · '}
        {t('quota_history.footnote')}
      </span>
      {history.updatedAt > 0 && (
        <span>
          {t('quota_history.updated', {
            // Never in the future, and never the countdown helper's "in 1 minute".
            time: formatRelativeInstant(Math.min(history.updatedAt, now - MINUTE_MS), now, locale),
          })}
        </span>
      )}
    </p>
  );

  return (
    <section className={styles.panel} aria-label={t('quota_history.title')}>
      <div className={styles.head}>
        <p className={styles.hero}>
          <span className={styles.heroValue}>{formatQuotaPercent(latest?.value)}%</span>
          <span className={styles.heroCapacity}>
            {t('quota_history.hero_capacity', { capacity: formatQuotaPercent(latest?.capacity) })}
          </span>
          {hasHistory && (
            <span className={styles.heroRate}>
              {t('quota_history.hero_rate', { rate: formatQuotaPercent(series.averageDrain) })}
            </span>
          )}
        </p>
        <button
          type="button"
          className={styles.collapse}
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          aria-label={collapsed ? t('quota_history.expand') : t('quota_history.collapse')}
          title={collapsed ? t('quota_history.expand') : t('quota_history.collapse')}
          onClick={toggleCollapsed}
        >
          <IconChevronUp size={18} aria-hidden="true" />
        </button>
      </div>

      {!collapsed && (
        <div className={styles.body} id={bodyId}>
          <div className={styles.modes} role="tablist" aria-label={t('quota_history.title')}>
            {(['remaining', 'drain'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                className={styles.mode}
                aria-selected={mode === value}
                onClick={() => changeMode(value)}
              >
                {t(`quota_history.mode_${value}`)}
              </button>
            ))}
          </div>

          <div className={styles.chartHead}>
            <span className={styles.legend}>
              <span className={styles.legendDot} aria-hidden="true" />
              {unit}
              <span className={styles.legendNote}>
                {drainMode ? t('quota_history.note_drain') : t('quota_history.note_remaining')}
              </span>
            </span>
            <span className={styles.range}>
              <span aria-hidden="true">{t('quota_history.range_label')}</span>
              <Select
                value={range.id}
                options={rangeOptions}
                onChange={changeRange}
                ariaLabel={t('quota_history.range_label')}
                size="sm"
              />
            </span>
          </div>

          {hasHistory ? (
            <QuotaHistoryChart
              points={drainMode ? series.drain : series.remaining}
              from={series.from}
              to={series.to}
              maxGapMs={series.maxGapMs}
              minTop={drainMode ? 1 : (latest?.capacity ?? 100)}
              unit={unit}
              ariaLabel={
                drainMode
                  ? t('quota_history.summary_drain', {
                      range: rangeLabel,
                      average: formatQuotaPercent(series.averageDrain),
                      peak: formatQuotaPercent(series.peakDrain),
                    })
                  : t('quota_history.summary_remaining', {
                      range: rangeLabel,
                      value: formatQuotaPercent(latest?.value),
                      capacity: formatQuotaPercent(latest?.capacity),
                    })
              }
              emptyText={t('quota_history.empty_range')}
              formatValue={formatQuotaPercent}
              formatTime={formatTime}
              formatTick={formatTick}
              footer={footer}
            />
          ) : (
            <div className={styles.chartEmpty}>{t('quota_history.empty_provider')}</div>
          )}
        </div>
      )}
    </section>
  );
}
