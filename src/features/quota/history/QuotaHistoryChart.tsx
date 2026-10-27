/**
 * Single-series area chart for the quota history panel.
 *
 * Same anatomy as the dashboard throughput chart: HTML axes positioned in
 * percent around a stretched SVG plot, so nothing needs measuring. Markers,
 * crosshair and tooltip are HTML too — a circle inside a non-uniformly scaled
 * SVG would turn into an ellipse. One series, so no legend box; the panel
 * header names it.
 */

import { useId, useMemo, useState, type PointerEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Collapsible } from '@/components/ui/Collapsible';
import { axisMax } from '@/features/dashboard/utils';
import { seriesSegments, type QuotaHistoryPoint } from './model';
import styles from './QuotaHistoryPanel.module.scss';

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 100;
const TICK_COUNT = 5;
const X_TICKS = 5;
const MAX_TABLE_ROWS = 48;

const clampUnit = (value: number) => Math.min(1, Math.max(0, value));

export interface QuotaHistoryChartProps {
  points: QuotaHistoryPoint[];
  from: number;
  to: number;
  maxGapMs: number;
  /** Smallest top of the value axis, e.g. the summed capacity. */
  minTop: number;
  unit: string;
  ariaLabel: string;
  emptyText: string;
  formatValue: (value: number) => string;
  formatTime: (ms: number) => string;
  formatTick: (ms: number) => string;
  /** Caption under the axis (peak, scope, freshness), above the data table. */
  footer?: ReactNode;
}

export function QuotaHistoryChart(props: QuotaHistoryChartProps) {
  const { points, from, to, maxGapMs, minTop, unit, ariaLabel, emptyText } = props;
  const { formatValue, formatTime, formatTick, footer } = props;
  const { t } = useTranslation();
  const gradientId = useId();
  const [active, setActive] = useState<number | null>(null);

  const valid = useMemo(
    () =>
      points.filter(
        (point): point is QuotaHistoryPoint & { value: number } => point.value !== null
      ),
    [points]
  );
  const top = useMemo(
    () => axisMax(Math.max(minTop, ...valid.map((point) => point.value)), TICK_COUNT - 1),
    [minTop, valid]
  );
  const span = Math.max(1, to - from);
  const xRatio = (ms: number) => clampUnit((ms - from) / span);
  const yRatio = (value: number) => clampUnit(value / top);

  const segments = useMemo(() => seriesSegments(points, maxGapMs), [points, maxGapMs]);
  const paths = useMemo(
    () =>
      segments
        .filter((segment) => segment.length > 1)
        .map((segment) => {
          const x = (ms: number) => (clampUnit((ms - from) / span) * VIEW_WIDTH).toFixed(2);
          const y = (value: number) =>
            (VIEW_HEIGHT - clampUnit(value / top) * VIEW_HEIGHT).toFixed(2);
          const line = `M${segment.map((point) => `${x(point.t)} ${y(point.value)}`).join(' L')}`;
          const first = x(segment[0].t);
          const last = x(segment[segment.length - 1].t);
          return { line, area: `${line} L${last} ${VIEW_HEIGHT} L${first} ${VIEW_HEIGHT} Z` };
        }),
    [segments, from, span, top]
  );
  const singles = segments.filter((segment) => segment.length === 1).map((segment) => segment[0]);

  const ticks = Array.from({ length: TICK_COUNT }, (_, index) => (top * index) / (TICK_COUNT - 1));
  const xTicks = Array.from(
    { length: X_TICKS },
    (_, index) => from + (span * index) / (X_TICKS - 1)
  );

  const tableRows = useMemo(() => {
    const step = Math.max(1, Math.ceil(valid.length / MAX_TABLE_ROWS));
    return valid.filter((_, index) => index % step === 0 || index === valid.length - 1);
  }, [valid]);

  if (valid.length === 0) {
    return (
      <>
        <div className={styles.chartEmpty}>{emptyText}</div>
        {footer}
      </>
    );
  }

  const handlePointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    const ms = from + ((event.clientX - box.left) / box.width) * span;
    let best = 0;
    for (let index = 1; index < valid.length; index += 1) {
      if (Math.abs(valid[index].t - ms) < Math.abs(valid[best].t - ms)) best = index;
    }
    setActive(best);
  };

  const activePoint = active === null ? null : (valid[active] ?? null);
  const activeLeft = activePoint ? xRatio(activePoint.t) * 100 : 0;

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
          onPointerMove={handlePointer}
          onPointerLeave={() => setActive(null)}
        >
          <div className={styles.gridlines} aria-hidden="true">
            {ticks.map((tick) => (
              <span
                key={tick}
                className={styles.gridline}
                style={{ top: `${(1 - tick / top) * 100}%` }}
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
                <stop offset="0%" stopColor="var(--viz-quota)" stopOpacity="0.28" />
                <stop offset="100%" stopColor="var(--viz-quota)" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            {paths.map((path) => (
              <g key={path.line}>
                <path d={path.area} fill={`url(#${gradientId})`} stroke="none" />
                <path
                  d={path.line}
                  className={styles.line}
                  fill="none"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            ))}
          </svg>
          {singles.map((point) => (
            <span
              key={point.t}
              className={styles.single}
              style={{
                left: `${xRatio(point.t) * 100}%`,
                top: `${(1 - yRatio(point.value)) * 100}%`,
              }}
              aria-hidden="true"
            />
          ))}
          {activePoint && (
            <>
              <span
                className={styles.crosshair}
                style={{ left: `${activeLeft}%` }}
                aria-hidden="true"
              />
              <span
                className={styles.marker}
                style={{ left: `${activeLeft}%`, top: `${(1 - yRatio(activePoint.value)) * 100}%` }}
                aria-hidden="true"
              />
              <div
                className={styles.tooltip}
                role="status"
                style={{
                  left: `${activeLeft}%`,
                  transform:
                    activeLeft > 70 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
                }}
              >
                {t('quota_history.tooltip', {
                  time: formatTime(activePoint.t),
                  value: formatValue(activePoint.value),
                  unit,
                })}
              </div>
            </>
          )}
        </div>
      </div>
      <div className={styles.xAxis} aria-hidden="true">
        {xTicks.map((tick, index) => (
          <span
            key={tick}
            className={styles.xTick}
            style={{ left: `${(index / (X_TICKS - 1)) * 100}%` }}
            data-edge={index === 0 ? 'start' : index === X_TICKS - 1 ? 'end' : undefined}
          >
            {formatTick(tick)}
          </span>
        ))}
      </div>
      {footer}
      <Collapsible className={styles.tableToggle} label={t('quota_history.table')}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('quota_history.table_time')}</th>
              <th scope="col">{unit}</th>
            </tr>
          </thead>
          <tbody>
            {tableRows.map((point) => (
              <tr key={point.t}>
                <th scope="row">{formatTime(point.t)}</th>
                <td>{formatValue(point.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Collapsible>
    </figure>
  );
}
