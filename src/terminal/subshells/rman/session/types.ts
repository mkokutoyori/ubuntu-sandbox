/**
 * Session options + state.
 */

import type { IRetentionPolicy } from '../policy/IRetentionPolicy';
import type { ChannelConfig } from '../channel/types';
import type { DbId } from '../values/DbId';

export interface RmanSessionOptions {
  readonly dbId:            DbId;
  readonly channelConfigs:  ReadonlyArray<ChannelConfig>;
  readonly retentionPolicy: IRetentionPolicy;
  readonly autobackupCf:    boolean;
  readonly debugMode:       boolean;
}

export type RmanSessionState = 'IDLE' | 'CONNECTING' | 'CONNECTED' | 'RUNNING_JOB' | 'DISCONNECTED';
