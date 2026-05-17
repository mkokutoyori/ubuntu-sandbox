/**
 * Command-pattern types — shared context + interface.
 */

import type { Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { RmanEventBus } from '../reactive/RmanEventBus';
import type { IRmanJobEngine } from '../job/IRmanJobEngine';
import type { IRmanCatalogRepository } from '../catalog/IRmanCatalogRepository';
import type { IRmanOracleContext } from '../integration/IRmanOracleContext';
import type { IRetentionPolicy } from '../policy/IRetentionPolicy';
import type { RmanConfig } from '../session/RmanConfig';
import type { IChannelPool } from '../channel/IChannelPool';
import type { ChannelHandle } from '../channel/types';

export interface RmanCommandContext {
  readonly bus:     RmanEventBus;
  readonly engine:  IRmanJobEngine;
  readonly catalog: IRmanCatalogRepository;
  readonly ctx:     IRmanOracleContext;
  readonly policy:  IRetentionPolicy;
  readonly config?: RmanConfig;
  /** Optional channel pool — for explicit ALLOCATE / RELEASE CHANNEL. */
  readonly pool?:        IChannelPool;
  /** Optional map keeping explicit channel handles, keyed by user alias. */
  readonly userChannels?: Map<string, ChannelHandle>;
}

export interface IRmanCommand<T = void> {
  readonly name: string;
  execute(args: string[], cmdCtx: RmanCommandContext): Result<T, RmanError>;
}
