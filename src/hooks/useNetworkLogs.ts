/**
 * useNetworkLogs — React subscription to the network Logger singleton.
 *
 * The Logger pub/sub layer is fully wired (every frame, ARP exchange,
 * SSH event, etc. flows through it) but had no UI surface — this hook
 * exposes a bounded ring of recent logs that the NetworkLogsPanel
 * renders. Updates are batched via a `useSyncExternalStore`-style
 * version counter so the panel re-renders only when new logs arrive,
 * not on every parent render.
 */
import { useEffect, useState } from 'react';
import { Logger, type NetworkLog } from '@/network/core/Logger';

export interface UseNetworkLogsOptions {
  /** Cap the returned slice (most recent N). Default 500 — same as the panel default. */
  readonly limit?: number;
}

export function useNetworkLogs(opts: UseNetworkLogsOptions = {}): NetworkLog[] {
  const limit = opts.limit ?? 500;
  const [snapshot, setSnapshot] = useState<NetworkLog[]>(() => Logger.getLogs().slice(-limit));

  useEffect(() => {
    // Seed with the current backlog so the panel opens populated even
    // when the user toggles it after the simulation has been running.
    setSnapshot(Logger.getLogs().slice(-limit));
    const id = Logger.subscribe(() => {
      setSnapshot(Logger.getLogs().slice(-limit));
    });
    return () => Logger.unsubscribe(id);
  }, [limit]);

  return snapshot;
}
