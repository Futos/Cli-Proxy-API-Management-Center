/**
 * Ledger group header: one per provider, summing each window's remaining
 * percent across the group's loaded credentials, with a show/hide toggle for
 * the rows beneath it.
 */

import { useTranslation } from 'react-i18next';
import type { ResolvedTheme } from '@/types';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { formatQuotaPercent } from '../history/format';
import type { QuotaWindowTotal } from '../logic';
import type { QuotaProviderType } from '../providers/types';
import styles from './QuotaGroupCard.module.scss';

export interface QuotaGroupCardProps {
  type: QuotaProviderType;
  count: number;
  totals: QuotaWindowTotal[];
  resolvedTheme: ResolvedTheme;
  collapsed: boolean;
  rowsId: string;
  onToggle: () => void;
}

export function QuotaGroupCard(props: QuotaGroupCardProps) {
  const { type, count, totals, resolvedTheme, collapsed, rowsId, onToggle } = props;
  const { t } = useTranslation();
  const label = getTypeLabel(t, type);
  const icon = getAuthFileIcon(type, resolvedTheme);

  return (
    <div className={styles.group}>
      <div className={styles.head}>
        <span
          className={styles.iconWrap}
          style={
            isThemeSurfaceIconProvider(type)
              ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
              : undefined
          }
          aria-hidden="true"
        >
          {icon ? (
            <img src={icon} alt="" className={styles.icon} />
          ) : (
            <span className={styles.iconFallback}>{label.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        <h3 className={styles.name}>{label}</h3>
        <span className={styles.count}>{t('quota_management.meta_credentials', { count })}</span>
      </div>
      <div className={styles.foot}>
        {totals.length > 0 ? (
          <ul className={styles.totals}>
            {totals.map((total) => (
              <li key={total.id} className={styles.total}>
                {total.labelKey ? t(total.labelKey, total.labelParams) : total.label}
                <b>{formatQuotaPercent(total.remaining)}%</b>
              </li>
            ))}
          </ul>
        ) : (
          <span className={styles.hint}>{t('quota_management.group_no_totals')}</span>
        )}
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={!collapsed}
          aria-controls={rowsId}
          aria-label={t('quota_management.group_toggle_label', { provider: label })}
          onClick={onToggle}
        >
          {collapsed ? t('quota_management.group_show') : t('quota_management.group_hide')}
        </button>
      </div>
    </div>
  );
}
