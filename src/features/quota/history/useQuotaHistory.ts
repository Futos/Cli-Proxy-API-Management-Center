/**
 * Quota history for the quota page: records every fresh quota read the page
 * performs and merges in the optional server-side recorder file.
 *
 * The recorder file is a deployment add-on served next to the panel, not part
 * of the Management API; it is only read when the panel and the connected
 * backend share an origin, and a missing file simply leaves the browser history.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { normalizeApiBase } from '@/utils/connection';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import {
  mergeQuotaHistories,
  parseQuotaHistory,
  quotaHistoryWindows,
  type QuotaHistory,
  type QuotaHistoryObservation,
} from './model';
import {
  getLocalQuotaHistory,
  recordQuotaObservations,
  subscribeLocalQuotaHistory,
} from './storage';

/** Written by scripts/quota_recorder.py in the proxy deployment. */
export const QUOTA_HISTORY_SERVER_PATH = '/_custom/quota-history.json';
const SERVER_REFRESH_MS = 5 * 60_000;

function sameOriginAsPage(apiBase: string): boolean {
  if (typeof window === 'undefined' || !apiBase) return false;
  try {
    return new URL(normalizeApiBase(apiBase)).origin === window.location.origin;
  } catch {
    return false;
  }
}

export function useQuotaHistory(
  entries: QuotaFileEntry[],
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined,
  apiBase: string
): QuotaHistory {
  const connectionKey = normalizeApiBase(apiBase);
  const local = useSyncExternalStore(
    subscribeLocalQuotaHistory,
    () => getLocalQuotaHistory(connectionKey),
    () => getLocalQuotaHistory('')
  );

  // A state object is recorded once: a new read creates a new object, while a
  // re-render of the same cached read must not look like a fresh observation.
  const recorded = useRef(new WeakSet<object>());
  useEffect(() => {
    const observations: QuotaHistoryObservation[] = [];
    for (const entry of entries) {
      const quota = quotaFor(entry);
      if (!quota || recorded.current.has(quota)) continue;
      if ((quota as { stale?: boolean }).stale) continue;
      const values = quotaHistoryWindows(entry.type, quota);
      const authIndex = normalizeAuthIndex(entry.file['auth_index'] ?? entry.file.authIndex);
      if (!values || !authIndex) continue;
      recorded.current.add(quota);
      observations.push({ authIndex, provider: entry.type, values });
    }
    recordQuotaObservations(connectionKey, observations, Date.now());
  }, [connectionKey, entries, quotaFor]);

  const [server, setServer] = useState<{ key: string; history: QuotaHistory | null }>({
    key: '',
    history: null,
  });
  const useServer = sameOriginAsPage(apiBase);
  useEffect(() => {
    if (!useServer) return undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(QUOTA_HISTORY_SERVER_PATH, { cache: 'no-store' });
        const history = response.ok ? parseQuotaHistory(await response.json()) : null;
        if (!cancelled) setServer({ key: connectionKey, history });
      } catch {
        if (!cancelled) setServer({ key: connectionKey, history: null });
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), SERVER_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [connectionKey, useServer]);

  const serverHistory = useServer && server.key === connectionKey ? server.history : null;
  return useMemo(() => mergeQuotaHistories(local, serverHistory), [local, serverHistory]);
}
