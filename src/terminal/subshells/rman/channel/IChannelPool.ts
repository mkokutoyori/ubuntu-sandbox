/**
 * IChannelPool — abstraction over a set of RMAN channels.
 */

import type { Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { ChannelHandle, ChannelStats } from './types';
import type { RmanObservable } from '../reactive/RmanSubject';
import type { RmanEvent } from '../core/types';

export interface IChannelPool {
  /**
   * Allocate a channel. If `alias` is provided, it is used as the
   * channel id in the emitted CHANNEL_ALLOCATED event (instead of the
   * auto-generated `${cfg.id}_${n}` name).
   */
  allocate(alias?: string): Result<ChannelHandle, RmanError>;
  release(handle: ChannelHandle): Result<void, RmanError>;
  getStats(): ChannelStats;
  /** Read-only view of the persistent channel configuration. */
  getConfigs(): ReadonlyArray<import('./types').ChannelConfig>;
  readonly allocations$: RmanObservable<Extract<RmanEvent, { type: 'CHANNEL_ALLOCATED' }>>;
  readonly releases$:    RmanObservable<Extract<RmanEvent, { type: 'CHANNEL_RELEASED' }>>;
  dispose(): void;
}
