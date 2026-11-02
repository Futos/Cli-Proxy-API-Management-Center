import {
  QUOTA_SORT_MODES,
  QUOTA_TAB_ORDER,
  QUOTA_VIEW_MODES,
  type QuotaSortMode,
  type QuotaTabId,
  type QuotaViewMode,
} from './constants';
import {
  POOL_BURN_WINDOWS,
  POOL_FUTURE_USAGE,
  type PoolBurnWindow,
  type PoolFutureUsage,
  type PoolMode,
} from './history/pool';

/** 额度页 UI 偏好：会话级持久化（sessionStorage），跨会话不携带。 */
export type QuotaUiState = {
  tab?: QuotaTabId;
  sortMode?: QuotaSortMode;
  viewMode?: QuotaViewMode;
  poolMode?: PoolMode;
  poolBurnWindow?: PoolBurnWindow;
  poolFutureUsage?: PoolFutureUsage;
  poolShowAccounts?: boolean;
  showEmails?: boolean;
};

const QUOTA_UI_STATE_KEY = 'quotaPage.uiState';

const QUOTA_TAB_ID_SET = new Set<string>(['all', ...QUOTA_TAB_ORDER]);
const QUOTA_SORT_MODE_SET = new Set<string>(QUOTA_SORT_MODES);
const QUOTA_VIEW_MODE_SET = new Set<string>(QUOTA_VIEW_MODES);
const POOL_FUTURE_USAGE_SET = new Set<string>(POOL_FUTURE_USAGE.map((option) => option.id));

export const isQuotaTabId = (value: unknown): value is QuotaTabId =>
  typeof value === 'string' && QUOTA_TAB_ID_SET.has(value);

export const isQuotaSortMode = (value: unknown): value is QuotaSortMode =>
  typeof value === 'string' && QUOTA_SORT_MODE_SET.has(value);

export const isQuotaViewMode = (value: unknown): value is QuotaViewMode =>
  typeof value === 'string' && QUOTA_VIEW_MODE_SET.has(value);

const isPoolMode = (value: unknown): value is PoolMode =>
  value === 'remaining' || value === 'drain';

const isPoolBurnWindow = (value: unknown): value is PoolBurnWindow =>
  (POOL_BURN_WINDOWS as readonly unknown[]).includes(value);

const isPoolFutureUsage = (value: unknown): value is PoolFutureUsage =>
  typeof value === 'string' && POOL_FUTURE_USAGE_SET.has(value);

const optionalBoolean = (value: unknown) => (typeof value === 'boolean' ? value : undefined);

export const readQuotaUiState = (): QuotaUiState | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(QUOTA_UI_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as QuotaUiState;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      tab: isQuotaTabId(parsed.tab) ? parsed.tab : undefined,
      sortMode: isQuotaSortMode(parsed.sortMode) ? parsed.sortMode : undefined,
      viewMode: isQuotaViewMode(parsed.viewMode) ? parsed.viewMode : undefined,
      poolMode: isPoolMode(parsed.poolMode) ? parsed.poolMode : undefined,
      poolBurnWindow: isPoolBurnWindow(parsed.poolBurnWindow) ? parsed.poolBurnWindow : undefined,
      poolFutureUsage: isPoolFutureUsage(parsed.poolFutureUsage)
        ? parsed.poolFutureUsage
        : undefined,
      poolShowAccounts: optionalBoolean(parsed.poolShowAccounts),
      showEmails: optionalBoolean(parsed.showEmails),
    };
  } catch {
    return null;
  }
};

/**
 * Merge into whatever is already stored.
 *
 * Callers write one preference at a time — the tab strip knows nothing about
 * the sort control — so a whole-object write would silently drop the other
 * field every time either one changed.
 */
export const writeQuotaUiState = (state: QuotaUiState) => {
  if (typeof window === 'undefined') return;
  try {
    const next = { ...readQuotaUiState(), ...state };
    window.sessionStorage.setItem(QUOTA_UI_STATE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
};
