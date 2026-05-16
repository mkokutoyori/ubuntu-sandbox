/**
 * IChannelPool — abstraction over a set of RMAN channels.
 */

import type { Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { ChannelHandle, ChannelStats } from './types';
import type { RmanObservable } from '../reactive/RmanSubject';
import type { RmanEvent } from '../core/types';

export interface IChannelPool {
  allocate(): Result<ChannelHandle, RmanError>;
  release(handle: ChannelHandle): Result<void, RmanError>;
  getStats(): ChannelStats;
  readonly allocations$: RmanObservable<Extract<RmanEvent, { type: 'CHANNEL_ALLOCATED' }>>;
  readonly releases$:    RmanObservable<Extract<RmanEvent, { type: 'CHANNEL_RELEASED' }>>;
  dispose(): void;
}
