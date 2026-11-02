import { useEffect } from 'react';
import type { DeviceType } from '@/network/core/types';
import { loadDevicePlatform } from '@/network/devices/platformLoaders';
import { idlePreloadEnabled } from '@/lazyPlatforms';

const PRELOADED_WHEN_IDLE: readonly DeviceType[] = ['linux-pc'];
const IDLE_DEADLINE_MS = 3_000;
const FALLBACK_DELAY_MS = 1_500;

export function useIdlePlatformPreload(types: readonly DeviceType[] = PRELOADED_WHEN_IDLE): void {
  useEffect(() => {
    if (!idlePreloadEnabled()) return undefined;
    const start = () => {
      for (const type of types) loadDevicePlatform(type).catch(() => undefined);
    };
    if (typeof globalThis.requestIdleCallback === 'function') {
      const handle = globalThis.requestIdleCallback(start, { timeout: IDLE_DEADLINE_MS });
      return () => globalThis.cancelIdleCallback(handle);
    }
    const handle = setTimeout(start, FALLBACK_DELAY_MS);
    return () => clearTimeout(handle);
  }, [types]);
}
