/**
 * Stored-script management — no-ops against the in-memory catalog.
 *
 * In real RMAN these persist scripts in the recovery catalog DB. The
 * simulator just accepts the syntax so DBA scripts can paste-and-run.
 *
 *   CREATE SCRIPT <name> { ... }
 *   REPLACE SCRIPT <name> { ... }
 *   DELETE SCRIPT <name>
 *   PRINT SCRIPT <name>
 *   EXECUTE SCRIPT <name>          (also EXECUTE SCRIPT '<name>')
 *   LIST SCRIPT NAMES
 */

import { ok, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand } from './types';

export class CreateScriptCommand implements IRmanCommand<string[]> {
  readonly name = 'CREATE SCRIPT';
  execute(args: string[]): Result<string[], RmanError> {
    return ok([`created script ${args[0] ?? ''}`]);
  }
}

export class ReplaceScriptCommand implements IRmanCommand<string[]> {
  readonly name = 'REPLACE SCRIPT';
  execute(args: string[]): Result<string[], RmanError> {
    return ok([`replaced script ${args[0] ?? ''}`]);
  }
}

export class DeleteScriptCommand implements IRmanCommand<string[]> {
  readonly name = 'DELETE SCRIPT';
  execute(args: string[]): Result<string[], RmanError> {
    return ok([`deleted script ${args[0] ?? ''}`]);
  }
}

export class PrintScriptCommand implements IRmanCommand<string[]> {
  readonly name = 'PRINT SCRIPT';
  execute(args: string[]): Result<string[], RmanError> {
    const name = args[0] ?? '';
    return ok([
      `printing stored script: ${name}`,
      `{`,
      `  BACKUP DATABASE;`,
      `}`,
    ]);
  }
}

export class ExecuteScriptCommand implements IRmanCommand<string[]> {
  readonly name = 'EXECUTE SCRIPT';
  execute(args: string[]): Result<string[], RmanError> {
    const name = (args[0] ?? '').replace(/^'|'$/g, '');
    return ok([
      `executing script: ${name}`,
      `script ${name} completed`,
    ]);
  }
}

export class ListScriptNamesCommand implements IRmanCommand<string[]> {
  readonly name = 'LIST SCRIPT NAMES';
  execute(): Result<string[], RmanError> {
    return ok([
      '',
      'List of Stored Scripts in Recovery Catalog',
      '',
      'no scripts stored',
      '',
    ]);
  }
}
