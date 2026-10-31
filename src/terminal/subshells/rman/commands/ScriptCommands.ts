/**
 * Stored scripts.
 *
 *   CREATE SCRIPT <name> { ... }
 *   REPLACE SCRIPT <name> { ... }
 *   DELETE SCRIPT <name>
 *   PRINT SCRIPT <name>
 *   EXECUTE SCRIPT <name>          (also EXECUTE SCRIPT '<name>')
 *   LIST SCRIPT NAMES
 *
 * The bodies live in the device's catalog (StoredScripts) and EXECUTE runs
 * them through the session's block runner, exactly as a RUN block.
 */

import { err, ok, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';

function unavailable(): Result<string[], RmanError> {
  return err({ code: 'RMAN_03002', message: 'stored scripts are not available in this session' });
}

function statementsOf(body: string): string[] {
  return body.split(';').map(statement => statement.trim()).filter(Boolean);
}

export class CreateScriptCommand implements IRmanCommand<string[]> {
  readonly name = 'CREATE SCRIPT';
  execute(args: string[], cmdCtx: RmanCommandContext): Result<string[], RmanError> {
    if (cmdCtx.scripts === undefined) return unavailable();
    const created = cmdCtx.scripts.create(args[0], statementsOf(args[1] ?? ''));
    if (!created.ok) return created as Result<never, RmanError>;
    return ok([`created script ${args[0]}`]);
  }
}

export class ReplaceScriptCommand implements IRmanCommand<string[]> {
  readonly name = 'REPLACE SCRIPT';
  execute(args: string[], cmdCtx: RmanCommandContext): Result<string[], RmanError> {
    if (cmdCtx.scripts === undefined) return unavailable();
    const outcome = cmdCtx.scripts.replace(args[0], statementsOf(args[1] ?? ''));
    return ok([`${outcome} script ${args[0]}`]);
  }
}

export class DeleteScriptCommand implements IRmanCommand<string[]> {
  readonly name = 'DELETE SCRIPT';
  execute(args: string[], cmdCtx: RmanCommandContext): Result<string[], RmanError> {
    if (cmdCtx.scripts === undefined) return unavailable();
    const removed = cmdCtx.scripts.remove(args[0]);
    if (!removed.ok) return removed as Result<never, RmanError>;
    return ok([`deleted script ${args[0]}`]);
  }
}

export class PrintScriptCommand implements IRmanCommand<string[]> {
  readonly name = 'PRINT SCRIPT';
  execute(args: string[], cmdCtx: RmanCommandContext): Result<string[], RmanError> {
    if (cmdCtx.scripts === undefined) return unavailable();
    const body = cmdCtx.scripts.read(args[0]);
    if (!body.ok) return body as Result<never, RmanError>;
    return ok([
      `printing stored script: ${args[0]}`,
      '{',
      ...body.value.map(statement => `  ${statement};`),
      '}',
    ]);
  }
}

export class ExecuteScriptCommand implements IRmanCommand<string[]> {
  readonly name = 'EXECUTE SCRIPT';
  execute(args: string[], cmdCtx: RmanCommandContext): Result<string[], RmanError> {
    if (cmdCtx.scripts === undefined || cmdCtx.runBlock === undefined) return unavailable();
    const name = args[0].replace(/^'|'$/g, '');
    const body = cmdCtx.scripts.read(name);
    if (!body.ok) return body as Result<never, RmanError>;
    const ran = cmdCtx.runBlock([...body.value]);
    if (!ran.ok) return ran;
    return ok([`executing script: ${name}`, '', ...ran.value]);
  }
}

export class ListScriptNamesCommand implements IRmanCommand<string[]> {
  readonly name = 'LIST SCRIPT NAMES';
  execute(_args: string[], cmdCtx: RmanCommandContext): Result<string[], RmanError> {
    if (cmdCtx.scripts === undefined) return unavailable();
    const names = cmdCtx.scripts.names();
    return ok([
      '',
      'List of Stored Scripts in Recovery Catalog',
      '',
      ...(names.length === 0 ? ['no scripts stored'] : names.map(name => `   ${name}`)),
      '',
    ]);
  }
}
