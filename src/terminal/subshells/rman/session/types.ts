/**
 * Session options + state.
 */

import type { IRetentionPolicy } from '../policy/IRetentionPolicy';
import type { ChannelConfig } from '../channel/types';
import type { DbId } from '../values/DbId';
import type { IEventBus } from '@/events/EventBus';

export interface RmanSessionOptions {
  readonly dbId:            DbId;
  readonly channelConfigs:  ReadonlyArray<ChannelConfig>;
  readonly retentionPolicy: IRetentionPolicy;
  readonly autobackupCf:    boolean;
  readonly debugMode:       boolean;
  /** Optional shared IEventBus. When provided, the session forwards every
   *  internal RmanEvent as a `rman.*` topic via RmanBusBridge. */
  readonly sharedBus?:      IEventBus;
  /** Stable session id used by the bridge + signal actors. */
  readonly sessionId?:      string;
}

export type RmanSessionState = 'IDLE' | 'CONNECTING' | 'CONNECTED' | 'RUNNING_JOB' | 'DISCONNECTED';
