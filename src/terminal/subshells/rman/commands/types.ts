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

export interface RmanCommandContext {
  readonly bus:     RmanEventBus;
  readonly engine:  IRmanJobEngine;
  readonly catalog: IRmanCatalogRepository;
  readonly ctx:     IRmanOracleContext;
  readonly policy:  IRetentionPolicy;
}

export interface IRmanCommand<T = void> {
  readonly name: string;
  execute(args: string[], cmdCtx: RmanCommandContext): Result<T, RmanError>;
}
