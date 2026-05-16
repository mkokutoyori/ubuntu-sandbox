/**
 * IRmanSession — public façade contract.
 */

import type { Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { RmanObservable } from '../reactive/RmanSubject';
import type { RmanEvent } from '../core/types';
import type { RmanSessionState } from './types';

export interface IRmanSession {
  readonly events$: RmanObservable<RmanEvent>;
  readonly state:   RmanSessionState;
  connect(target?: string): Result<void, RmanError>;
  processLine(line: string): Result<string[], RmanError>;
  getBanner(): string[];
  dispose(): void;
}
