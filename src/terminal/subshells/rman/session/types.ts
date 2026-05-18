/**
 * Session options + state.
 */

import type { IRetentionPolicy } from '../policy/IRetentionPolicy';
import type { ChannelConfig } from '../channel/types';
import type { DbId } from '../values/DbId';
import type { IEventBus } from '@/events/EventBus';
import type { InMemoryRmanCatalog } from '../catalog/InMemoryRmanCatalog';
import type { RmanConfig } from './RmanConfig';

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
  /** Optional device-scoped catalog. When provided, the session shares it
   *  across multiple `RmanSession` lifetimes for the same device, so
   *  backups taken in one session survive a `dispose()` + new session. */
  readonly catalog?:        InMemoryRmanCatalog;
  /** Optional device-scoped config. Same persistence pattern as `catalog`. */
  readonly config?:         RmanConfig;
}

export type RmanSessionState = 'IDLE' | 'CONNECTING' | 'CONNECTED' | 'RUNNING_JOB' | 'DISCONNECTED';
