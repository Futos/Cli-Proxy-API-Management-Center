/**
 * Browser-side quota history, one localStorage entry per connection.
 *
 * Exposed as a tiny external store so components read it through
 * `useSyncExternalStore`; switching connections switches keys, so one
 * backend's history never bleeds into another's.
 */

import {
  appendQuotaObservations,
  emptyQuotaHistory,
  parseQuotaHistory,
  type QuotaHistory,
  type QuotaHistoryObservation,
} from './model';

const STORAGE_PREFIX = 'quotaHistory.v1:';

const cache = new Map<string, QuotaHistory>();
const listeners = new Set<() => void>();
const EMPTY = emptyQuotaHistory();

function read(connectionKey: string): QuotaHistory {
  if (typeof window === 'undefined' || !connectionKey) return EMPTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + connectionKey);
    return (raw && parseQuotaHistory(JSON.parse(raw))) || EMPTY;
  } catch {
    return EMPTY;
  }
}

export function getLocalQuotaHistory(connectionKey: string): QuotaHistory {
  let history = cache.get(connectionKey);
  if (!history) {
    history = read(connectionKey);
    cache.set(connectionKey, history);
  }
  return history;
}

export function subscribeLocalQuotaHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function recordQuotaObservations(
  connectionKey: string,
  observations: QuotaHistoryObservation[],
  now: number
): void {
  if (!connectionKey || observations.length === 0) return;
  const next = appendQuotaObservations(getLocalQuotaHistory(connectionKey), observations, now);
  cache.set(connectionKey, next);
  try {
    window.localStorage.setItem(STORAGE_PREFIX + connectionKey, JSON.stringify(next));
  } catch {
    // Quota exceeded or storage disabled: keep the in-memory copy for this session.
  }
  listeners.forEach((listener) => listener());
}
