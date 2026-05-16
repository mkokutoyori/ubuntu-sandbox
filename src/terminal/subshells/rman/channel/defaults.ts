/**
 * Default channel configurations.
 */

import type { ChannelConfig } from './types';

/** RMAN default: 1 DISK channel. */
export const DEFAULT_CHANNEL_CONFIGS: ReadonlyArray<ChannelConfig> = Object.freeze([
  Object.freeze({
    id: 'ORA_DISK',
    deviceType: 'DISK' as const,
    parallelism: 1,
    maxOpenFiles: 64,
    sid: 142,
  }),
]);

/** Parallel-4 configuration for heavy backups. */
export const PARALLEL_4_CONFIGS: ReadonlyArray<ChannelConfig> = Object.freeze([
  Object.freeze({ id: 'ORA_DISK_P', deviceType: 'DISK' as const, parallelism: 4, maxOpenFiles: 64, sid: 142 }),
]);
