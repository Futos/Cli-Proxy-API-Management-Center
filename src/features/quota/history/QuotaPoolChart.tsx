/**
 * Pool chart: recorded history (solid) up to now, the projection (dashed)
 * after it, over a two-week span.
 *
 * Same anatomy as the dashboard throughput chart: HTML axes and labels placed
 * in percent around a stretched SVG plot, so nothing needs measuring. Markers,
 * labels, crosshair and tooltip are HTML — a circle inside a non-uniformly
 * scaled SVG would turn into an ellipse.
 */

import {
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Collapsible } from '@/components/ui/Collapsible';
import { axisMax } from '@/features/dashboard/utils';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';
import { formatQuotaPercent } from './format';
import {
  spanDays,
  valueAt,
  type PoolAccount,
  type PoolForecast,
  type PoolMode,
  type PoolPoint,
  type PoolRecorded,
  type PoolResetMark,
} from './pool';
import { QUOTA_SENSITIVE_CLASS } from '../constants';
import styles from './QuotaPoolPanel.module.scss';

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 100;
/** Reset labels closer than this (percent of width / height) are dropped, not stacked. */
const LABEL_MIN_DX = 3.5;
const LABEL_MIN_DY = 9;
const MIN_LABEL_DELTA = 1;

const clampUnit = (value: number) => Math.min(1, Math.max(0, value));

export interface QuotaPoolChartProps {
  mode: PoolMode;
  span: { startMs: number; endMs: number };
  now: number;
  capacity: number;
  recorded: PoolRecorded;
  forecast: PoolForecast;
  accounts: PoolAccount[];
  showAccounts: boolean;
  formatWhen: (ms: number) => string;
  ariaLabel: string;
}

interface Hover {
  t: number;
  value: number | null;
  projected: boolean;
  accounts: { name: string; value: number | null }[];
}

/** Value of a set of runs at `t`, or null inside a gap. */
function runsAt(runs: PoolPoint[][], t: number): number | null {
  for (const run of runs) {
    if (run.length === 0 || t < run[0].t || t > run[run.length - 1].t) continue;
    return valueAt(run, t);
  }
  return null;
}

export function QuotaPoolChart(props: QuotaPoolChartProps) {
  const { mode, span, now, capacity, recorded, forecast, accounts, showAccounts } = props;
  const { formatWhen, ariaLabel } = props;
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const gradientId = useId();
  const projectedGradientId = useId();
  const [hoverT, setHoverT] = useState<number | null>(null);

  const drainMode = mode === 'drain';
  const width = Math.max(1, span.endMs - span.startMs);
  const inSpan = (ms: number) => ms >= span.startMs && ms <= span.endMs;
  const xRatio = (ms: number) => (ms - span.startMs) / width;

  const recordedRuns = drainMode ? recorded.drain : recorded.segments;
  // Not trimmed to the span: the SVG clips, and lookups past the edge still need the tail.
  const projected = drainMode ? forecast.drain : forecast.points;
  const accountLines = !drainMode && showAccounts;

  const top = useMemo(() => {
    let peak = 0;
    const consider = (point: PoolPoint) => {
      if (point.t >= span.startMs && point.t <= span.endMs && point.value > peak) {
        peak = point.value;
      }
    };
    recordedRuns.forEach((run) => run.forEach(consider));
    projected.forEach(consider);
    if (drainMode) return axisMax(Math.max(peak, 1), 2);
    return Math.max(capacity, peak, 1);
  }, [recordedRuns, projected, drainMode, capacity, span.startMs, span.endMs]);

  const yRatio = (value: number) => clampUnit(value / top);
  const path = (points: PoolPoint[]) =>
    points.length === 0
      ? ''
      : `M${points
          .map(
            (point) =>
              `${(xRatio(point.t) * VIEW_WIDTH).toFixed(2)} ${(
                VIEW_HEIGHT -
                yRatio(point.value) * VIEW_HEIGHT
              ).toFixed(2)}`
          )
          .join(' L')}`;
  const area = (points: PoolPoint[]) => {
    if (points.length < 2) return '';
    const first = (xRatio(points[0].t) * VIEW_WIDTH).toFixed(2);
    const last = (xRatio(points[points.length - 1].t) * VIEW_WIDTH).toFixed(2);
    return `${path(points)} L${last} ${VIEW_HEIGHT} L${first} ${VIEW_HEIGHT} Z`;
  };

  const days = useMemo(() => spanDays(span.startMs, span.endMs), [span.startMs, span.endMs]);
  const ticks = [top, top / 2, 0];
  const nowVisible = inSpan(now);
  const nowValue = drainMode ? (forecast.drain[0]?.value ?? null) : forecast.current;

  const resetLabels = useMemo(() => {
    if (drainMode) return [];
    const spanWidth = Math.max(1, span.endMs - span.startMs);
    const marks: (PoolResetMark & { projected: boolean })[] = [
      ...recorded.resets.map((mark) => ({ ...mark, projected: false })),
      ...forecast.resets
        .filter((mark) => mark.t > now)
        .map((mark) => ({ ...mark, projected: true })),
    ].filter(
      (mark) => mark.delta >= MIN_LABEL_DELTA && mark.t >= span.startMs && mark.t <= span.endMs
    );
    const placed: { x: number; y: number; mark: (typeof marks)[number] }[] = [];
    for (const mark of marks.sort((a, b) => a.t - b.t)) {
      const x = ((mark.t - span.startMs) / spanWidth) * 100;
      const y = (1 - clampUnit(mark.value / top)) * 100;
      const clash = placed.some(
        (other) => Math.abs(other.x - x) < LABEL_MIN_DX && Math.abs(other.y - y) < LABEL_MIN_DY
      );
      if (!clash) placed.push({ x, y, mark });
    }
    return placed;
  }, [drainMode, recorded.resets, forecast.resets, now, span.startMs, span.endMs, top]);

  const emptyAt =
    !drainMode && forecast.poolEmptyAt !== null && inSpan(forecast.poolEmptyAt)
      ? forecast.poolEmptyAt
      : null;

  const hover = useMemo<Hover | null>(() => {
    if (hoverT === null) return null;
    const isProjected = hoverT > now;
    const value = isProjected ? valueAt(projected, hoverT) : runsAt(recordedRuns, hoverT);
    const perAccount = accountLines
      ? accounts.map((account) => ({
          name: account.name,
          value: isProjected
            ? valueAt(forecast.accounts[account.authIndex] ?? [], hoverT)
            : runsAt(recorded.accounts[account.authIndex] ?? [], hoverT),
        }))
      : [];
    return { t: hoverT, value, projected: isProjected, accounts: perAccount };
  }, [hoverT, now, projected, recordedRuns, accountLines, accounts, forecast, recorded]);

  const handlePointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    const ratio = clampUnit((event.clientX - box.left) / box.width);
    setHoverT(span.startMs + ratio * width);
  };
  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? DAY_MS : HOUR_MS;
    const base = hoverT ?? (nowVisible ? now : span.startMs);
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = base - step;
    else if (event.key === 'ArrowRight') next = base + step;
    else if (event.key === 'Home') next = span.startMs;
    else if (event.key === 'End') next = span.endMs;
    else if (event.key === 'Escape') {
      setHoverT(null);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    setHoverT(Math.min(span.endMs, Math.max(span.startMs, next)));
  };

  const formatValue = (value: number) =>
    drainMode
      ? t('quota_pool.rate', { value: formatQuotaPercent(value) })
      : `${formatQuotaPercent(value)}%`;
  const formatDay = (ms: number) => {
    const date = new Date(ms);
    return `${date.toLocaleDateString(locale, { weekday: 'short' })} ${date.getDate()}`;
  };

  const tableRows = days.map((day) => {
    const at = day + DAY_MS / 2;
    const projectedRow = at > now;
    const value = projectedRow ? valueAt(projected, at) : runsAt(recordedRuns, at);
    return { at, value, projected: projectedRow };
  });

  let tooltip: ReactNode = null;
  if (hover) {
    const left = xRatio(hover.t) * 100;
    const source = hover.projected
      ? t('quota_pool.source_projected')
      : t('quota_pool.source_recorded');
    tooltip = (
      <div
        className={styles.tooltip}
        role="status"
        style={{
          left: `${left}%`,
          transform:
            left > 70
              ? 'translateX(calc(-100% - 10px))'
              : left < 30
                ? 'translateX(10px)'
                : 'translateX(-50%)',
        }}
      >
        <span>
          {hover.value === null
            ? t('quota_pool.tooltip_gap', { time: formatWhen(hover.t) })
            : t(drainMode ? 'quota_pool.tooltip_drain' : 'quota_pool.tooltip_remaining', {
                time: formatWhen(hover.t),
                value: formatQuotaPercent(hover.value),
                source,
              })}
        </span>
        {hover.accounts.map((account) => (
          <span key={account.name} className={styles.tooltipAccount}>
            <span className={`${styles.tooltipName} ${QUOTA_SENSITIVE_CLASS}`}>{account.name}</span>
            <span>{account.value === null ? '--' : `${formatQuotaPercent(account.value)}%`}</span>
          </span>
        ))}
      </div>
    );
  }

  const recordedPaths = recordedRuns.filter((run) => run.length > 0);

  return (
    <figure className={styles.chart}>
      <div className={styles.plot}>
        <div className={styles.yAxis} aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick} className={styles.yTick} style={{ top: `${(1 - tick / top) * 100}%` }}>
              {formatValue(tick)}
            </span>
          ))}
        </div>
        <div
          className={styles.canvas}
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
          onPointerMove={handlePointer}
          onPointerLeave={() => setHoverT(null)}
          onKeyDown={handleKey}
          onBlur={() => setHoverT(null)}
        >
          <div className={styles.grid} aria-hidden="true">
            {ticks.map((tick) => (
              <span
                key={tick}
                className={styles.gridRow}
                style={{ top: `${(1 - tick / top) * 100}%` }}
              />
            ))}
            {days.slice(1).map((day) => (
              <span
                key={day}
                className={styles.gridColumn}
                style={{ left: `${xRatio(day) * 100}%` }}
              />
            ))}
          </div>

          <svg
            className={styles.svg}
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--pool-color)" stopOpacity="0.3" />
                <stop offset="100%" stopColor="var(--pool-color)" stopOpacity="0.02" />
              </linearGradient>
              <linearGradient id={projectedGradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--pool-color)" stopOpacity="0.14" />
                <stop offset="100%" stopColor="var(--pool-color)" stopOpacity="0.01" />
              </linearGradient>
            </defs>

            {accountLines &&
              accounts.map((account) => (
                <g key={account.authIndex} className={styles.accountLine}>
                  {(recorded.accounts[account.authIndex] ?? []).map((run) => (
                    <path
                      key={run[0].t}
                      d={path(run)}
                      fill="none"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                  <path
                    d={path(forecast.accounts[account.authIndex] ?? [])}
                    fill="none"
                    strokeDasharray="4 4"
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              ))}

            {recordedPaths.map((run) => (
              <g key={run[0].t}>
                <path d={area(run)} fill={`url(#${gradientId})`} stroke="none" />
                <path
                  d={path(run)}
                  className={styles.line}
                  fill="none"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            ))}

            {projected.length > 1 && (
              <>
                <path d={area(projected)} fill={`url(#${projectedGradientId})`} stroke="none" />
                <path
                  d={path(projected)}
                  className={styles.projectedLine}
                  fill="none"
                  vectorEffect="non-scaling-stroke"
                />
              </>
            )}
          </svg>

          {recordedPaths
            .filter((run) => run.length === 1)
            .map((run) => (
              <span
                key={run[0].t}
                className={styles.single}
                style={{
                  left: `${xRatio(run[0].t) * 100}%`,
                  top: `${(1 - yRatio(run[0].value)) * 100}%`,
                }}
                aria-hidden="true"
              />
            ))}

          {nowVisible && (
            <>
              <span
                className={styles.nowLine}
                style={{ left: `${xRatio(now) * 100}%` }}
                aria-hidden="true"
              >
                <span className={styles.nowLabel}>{t('quota_pool.now_marker')}</span>
              </span>
              {nowValue !== null && (
                <span
                  className={styles.dot}
                  style={{
                    left: `${xRatio(now) * 100}%`,
                    top: `${(1 - yRatio(nowValue)) * 100}%`,
                  }}
                  aria-hidden="true"
                />
              )}
            </>
          )}

          {resetLabels.map(({ x, y, mark }) => (
            <span
              key={`${mark.t}:${mark.projected}`}
              className={styles.resetLabel}
              style={{ left: `${x}%`, top: `${y}%` }}
              aria-hidden="true"
            >
              +{formatQuotaPercent(mark.delta)}%
            </span>
          ))}

          {emptyAt !== null && (
            <>
              <span
                className={styles.emptyMarker}
                style={{ left: `${xRatio(emptyAt) * 100}%` }}
                aria-hidden="true"
              />
              <span
                className={styles.emptyLabel}
                style={{ left: `${xRatio(emptyAt) * 100}%` }}
                aria-hidden="true"
              >
                {t('quota_pool.empty_marker', { time: formatWhen(emptyAt) })}
              </span>
            </>
          )}

          {hover && (
            <>
              <span
                className={styles.crosshair}
                style={{ left: `${xRatio(hover.t) * 100}%` }}
                aria-hidden="true"
              />
              {hover.value !== null && (
                <span
                  className={styles.dot}
                  style={{
                    left: `${xRatio(hover.t) * 100}%`,
                    top: `${(1 - yRatio(hover.value)) * 100}%`,
                  }}
                  aria-hidden="true"
                />
              )}
            </>
          )}
          {tooltip}
        </div>
      </div>

      <div className={styles.xAxis} aria-hidden="true">
        {days.map((day, index) => (
          <span
            key={day}
            className={styles.xTick}
            data-odd={index % 2 === 1 ? 'true' : undefined}
            style={{ left: `${xRatio(day + DAY_MS / 2) * 100}%` }}
          >
            {formatDay(day)}
          </span>
        ))}
      </div>

      <div className={styles.legend}>
        <span className={styles.legendTitle}>{t('quota_pool.legend_pool')}</span>
        <span className={styles.legendItem}>
          <span className={styles.swatchSolid} aria-hidden="true" />
          {t('quota_pool.legend_recorded')}
        </span>
        <span className={styles.legendItem}>
          <span className={styles.swatchDashed} aria-hidden="true" />
          {t('quota_pool.legend_projected')}
        </span>
        {accountLines && (
          <span className={styles.legendItem}>
            <span className={styles.swatchAccount} aria-hidden="true" />
            {t('quota_pool.legend_accounts')}
          </span>
        )}
      </div>

      <Collapsible className={styles.tableToggle} label={t('quota_pool.table')}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('quota_pool.table_time')}</th>
              <th scope="col">
                {drainMode ? t('quota_pool.mode_drain') : t('quota_pool.mode_remaining')}
              </th>
              <th scope="col">{t('quota_pool.table_source')}</th>
            </tr>
          </thead>
          <tbody>
            {tableRows.map((row) => (
              <tr key={row.at}>
                <th scope="row">{formatWhen(row.at)}</th>
                <td>{row.value === null ? '--' : formatValue(row.value)}</td>
                <td>
                  {row.projected
                    ? t('quota_pool.source_projected')
                    : t('quota_pool.source_recorded')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Collapsible>
    </figure>
  );
}
