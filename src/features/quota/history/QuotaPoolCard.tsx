/**
 * One provider's pool: headline remaining, the forecast numbers, and the chart.
 */

import { useCallback, useMemo, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { ResolvedTheme } from '@/types';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { DAY_MS, MINUTE_MS } from '@/utils/time/durations';
import { QUOTA_SENSITIVE_CLASS } from '../constants';
import { formatQuotaPercent } from './format';
import { maxSampleGapMs, type QuotaHistory } from './model';
import {
  POOL_FORECAST_MS,
  accountReadings,
  buildPoolAccounts,
  buildPoolRecorded,
  burnRate,
  futureUsageFactor,
  projectPool,
  type PoolAccountInput,
  type PoolFutureUsage,
  type PoolMode,
  type PoolProvider,
} from './pool';
import { QuotaPoolChart } from './QuotaPoolChart';
import styles from './QuotaPoolPanel.module.scss';

const POOL_COLORS: Record<PoolProvider, string> = {
  claude: 'var(--viz-quota)',
  codex: 'var(--viz-quota-codex)',
};

export interface QuotaPoolCardProps {
  provider: PoolProvider;
  inputs: PoolAccountInput[];
  history: QuotaHistory;
  mode: PoolMode;
  burnWindowMs: number;
  burnWindowHours: number;
  futureUsage: PoolFutureUsage;
  showAccounts: boolean;
  span: { startMs: number; endMs: number };
  now: number;
  resolvedTheme: ResolvedTheme;
}

export function QuotaPoolCard(props: QuotaPoolCardProps) {
  const { provider, inputs, history, mode, burnWindowMs, burnWindowHours, futureUsage } = props;
  const { showAccounts, span, now, resolvedTheme } = props;
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const label = getTypeLabel(t, provider);
  const icon = getAuthFileIcon(provider, resolvedTheme);

  const maxGapMs = maxSampleGapMs(history);
  const readings = useMemo(
    () =>
      accountReadings(
        history,
        inputs.map((input) => input.authIndex),
        now
      ),
    [history, inputs, now]
  );
  const accounts = useMemo(() => buildPoolAccounts(inputs, readings), [inputs, readings]);
  const rates = useMemo(
    () =>
      new Map(
        accounts.map((account) => [
          account.authIndex,
          burnRate(readings.get(account.authIndex) ?? [], now, burnWindowMs, maxGapMs),
        ])
      ),
    [accounts, readings, now, burnWindowMs, maxGapMs]
  );
  const burn = useMemo(() => {
    let total: number | null = null;
    for (const account of accounts) {
      const rate = rates.get(account.authIndex);
      if (rate === null || rate === undefined) continue;
      total = (total ?? 0) + rate * account.weight;
    }
    return total;
  }, [accounts, rates]);

  const horizon = now + POOL_FORECAST_MS;
  const forecast = useMemo(
    () =>
      projectPool(
        accounts,
        rates,
        futureUsageFactor(futureUsage),
        now,
        Math.max(span.endMs, horizon)
      ),
    [accounts, rates, futureUsage, now, span.endMs, horizon]
  );
  const recorded = useMemo(
    () =>
      buildPoolRecorded(history, accounts, span.startMs, Math.min(span.endMs, now), burnWindowMs),
    [history, accounts, span.startMs, span.endMs, now, burnWindowMs]
  );

  const formatWhen = useCallback(
    (ms: number) =>
      new Date(ms).toLocaleString(
        locale,
        Math.abs(ms - now) > 6 * DAY_MS
          ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
          : { weekday: 'short', hour: 'numeric', minute: '2-digit' }
      ),
    [locale, now]
  );
  const formatDate = useCallback(
    (ms: number) => new Date(ms).toLocaleDateString(locale, { month: 'short', day: 'numeric' }),
    [locale]
  );
  const formatDuration = useCallback(
    (ms: number) => {
      const minutes = Math.max(1, Math.floor(ms / MINUTE_MS));
      const days = Math.floor(minutes / (24 * 60));
      const hours = Math.floor((minutes % (24 * 60)) / 60);
      if (days > 0) return t('quota_pool.duration_dh', { d: days, h: hours });
      if (hours > 0) return t('quota_pool.duration_hm', { h: hours, m: minutes % 60 });
      return t('quota_pool.duration_m', { m: minutes });
    },
    [t]
  );

  const nameOf = useMemo(
    () => new Map(accounts.map((account) => [account.authIndex, account.name])),
    [accounts]
  );
  const notBy = t('quota_pool.not_by', { date: formatDate(horizon) });
  const poolEmptyAt =
    forecast.poolEmptyAt !== null && forecast.poolEmptyAt <= horizon ? forecast.poolEmptyAt : null;
  const firstEmpty =
    forecast.firstEmpty && forecast.firstEmpty.t <= horizon ? forecast.firstEmpty : null;
  const nextReset = forecast.nextReset;
  const weightNotes = [
    ...new Set(
      accounts
        .filter((account) => account.weight !== 1)
        .map((account) =>
          t('quota_pool.weight_note', {
            plan: provider === 'codex' ? t('codex_quota.plan_pro') : label,
            weight: account.weight,
          })
        )
    ),
  ];

  const poolEmptyText = poolEmptyAt === null ? notBy : formatWhen(poolEmptyAt);
  const nextResetText = nextReset
    ? t('quota_pool.reset_value', {
        value: formatQuotaPercent(nextReset.delta),
        time: formatWhen(nextReset.t),
      })
    : '--';
  const burnText = burn === null ? '--' : t('quota_pool.rate', { value: formatQuotaPercent(burn) });
  const firstEmptyWhen = firstEmpty
    ? firstEmpty.t <= now + MINUTE_MS
      ? t('quota_pool.now')
      : t('quota_pool.in_duration', { duration: formatDuration(firstEmpty.t - now) })
    : null;

  const color = { '--pool-color': POOL_COLORS[provider] } as CSSProperties;
  const countText =
    accounts.length === inputs.length
      ? t('quota_pool.accounts_count', { count: accounts.length })
      : t('quota_pool.accounts_partial', { count: accounts.length, total: inputs.length });

  return (
    <article className={styles.card} style={color} aria-label={label}>
      <header className={styles.cardHead}>
        <span
          className={styles.iconWrap}
          style={
            isThemeSurfaceIconProvider(provider)
              ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
              : undefined
          }
          aria-hidden="true"
        >
          {icon ? (
            <img src={icon} alt="" className={styles.icon} />
          ) : (
            <span>{label.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        <h3 className={styles.cardTitle}>{label}</h3>
        <span className={styles.cardCount}>{countText}</span>
      </header>

      {accounts.length === 0 ? (
        <div className={styles.empty}>{t('quota_pool.empty_card')}</div>
      ) : (
        <>
          <div className={styles.summary}>
            <p className={styles.hero}>
              <span className={styles.heroValue}>{formatQuotaPercent(forecast.current)}%</span>
              <span className={styles.heroCapacity}>
                {t('quota_pool.of_capacity', { capacity: formatQuotaPercent(forecast.capacity) })}
              </span>
              {weightNotes.map((note) => (
                <span key={note} className={styles.heroNote}>
                  {note}
                </span>
              ))}
            </p>
            <dl className={styles.stats}>
              <div className={styles.stat}>
                <dt>{t('quota_pool.stat_pool_empty')}</dt>
                <dd>{poolEmptyText}</dd>
              </div>
              <div className={styles.stat}>
                <dt>{t('quota_pool.stat_first_empty')}</dt>
                <dd>
                  {firstEmpty ? (
                    <>
                      <span className={`${styles.statName} ${QUOTA_SENSITIVE_CLASS}`}>
                        {nameOf.get(firstEmpty.authIndex)}
                      </span>{' '}
                      {firstEmptyWhen}
                    </>
                  ) : (
                    notBy
                  )}
                </dd>
              </div>
              <div className={styles.stat}>
                <dt>{t('quota_pool.stat_next_reset')}</dt>
                <dd>{nextResetText}</dd>
              </div>
              <div className={styles.stat}>
                <dt>{t('quota_pool.stat_burn', { hours: burnWindowHours })}</dt>
                <dd>{burnText}</dd>
              </div>
            </dl>
          </div>

          <QuotaPoolChart
            mode={mode}
            span={span}
            now={now}
            capacity={forecast.capacity}
            recorded={recorded}
            forecast={forecast}
            accounts={accounts}
            showAccounts={showAccounts}
            formatWhen={formatWhen}
            ariaLabel={t('quota_pool.summary', {
              provider: label,
              value: formatQuotaPercent(forecast.current),
              capacity: formatQuotaPercent(forecast.capacity),
              poolEmpty: poolEmptyText,
              nextReset: nextResetText,
              burn: burnText,
            })}
          />
          <p className={styles.note}>
            {t('quota_pool.note', { hours: burnWindowHours })}
            {burn === null && ` ${t('quota_pool.note_no_burn', { hours: burnWindowHours })}`}
          </p>
        </>
      )}
    </article>
  );
}
