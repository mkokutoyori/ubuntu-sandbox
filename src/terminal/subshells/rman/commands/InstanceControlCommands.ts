import type { IRmanCommand, RmanCommandContext } from './types';
import { ok, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';

function delegate(
  ctx: RmanCommandContext,
  statement: string,
): Result<string[], RmanError> {
  const outcome = ctx.ctx.runSqlStatement?.(statement);
  if (!outcome) {
    return ok([
      'RMAN-00571: ===========================================================',
      'RMAN-00569: =============== ERROR MESSAGE STACK FOLLOWS ===============',
      'RMAN-00571: ===========================================================',
      'RMAN-03002: failure during compilation of command',
      `RMAN-06403: ${statement} is not available against this target`,
    ]);
  }
  if (outcome.ok === false) {
    return ok([
      'RMAN-00571: ===========================================================',
      'RMAN-00569: =============== ERROR MESSAGE STACK FOLLOWS ===============',
      'RMAN-00571: ===========================================================',
      `RMAN-03002: failure during compilation of command`,
      outcome.error,
    ]);
  }
  return ok(outcome.lines.filter(Boolean));
}

function oracleErrors(lines: readonly string[]): string[] {
  return lines.filter(l => /^ORA-\d/.test(l));
}

export class ShutdownCommand implements IRmanCommand<string[]> {
  readonly name = 'SHUTDOWN';
  execute(args: string[], ctx: RmanCommandContext): Result<string[], RmanError> {
    const mode = (args[0] ?? 'NORMAL').toUpperCase();
    const done = delegate(ctx, `SHUTDOWN ${mode}`);
    if (done.ok === false) return done;
    if (done.value.some(l => l.startsWith('RMAN-'))) return done;
    const failures = oracleErrors(done.value);
    if (failures.length > 0) return ok(failures);
    if (ctx.ctx.getInstanceState?.() !== 'SHUTDOWN') return ok(done.value);
    if (mode === 'ABORT') return ok(['Oracle instance shut down']);
    return ok(['database closed', 'database dismounted', 'Oracle instance shut down']);
  }
}

export class StartupCommand implements IRmanCommand<string[]> {
  readonly name = 'STARTUP';
  execute(args: string[], ctx: RmanCommandContext): Result<string[], RmanError> {
    const mode = (args[0] ?? '').toUpperCase();
    const done = delegate(ctx, mode ? `STARTUP ${mode}` : 'STARTUP');
    if (done.ok === false) return done;
    if (done.value.some(l => l.startsWith('RMAN-'))) return done;
    const sga = done.value.filter(l =>
      /Total System Global Area|Fixed Size|Variable Size|Database Buffers|Redo Buffers/i.test(l));
    const reached = ctx.ctx.getInstanceState?.() ?? 'SHUTDOWN';
    const lines = reached === 'SHUTDOWN' ? [] : ['Oracle instance started', ...sga];
    if (reached === 'MOUNT' || reached === 'OPEN') lines.push('database mounted');
    if (reached === 'OPEN') lines.push('database opened');
    return ok([...lines, ...oracleErrors(done.value)]);
  }
}

export class AlterDatabaseOpenCommand implements IRmanCommand<string[]> {
  readonly name = 'ALTER DATABASE OPEN';
  execute(args: string[], ctx: RmanCommandContext): Result<string[], RmanError> {
    const resetlogs = (args[0] ?? '').toUpperCase() === 'RESETLOGS';
    const done = delegate(ctx, resetlogs ? 'ALTER DATABASE OPEN RESETLOGS' : 'ALTER DATABASE OPEN');
    if (done.ok === false) return done;
    if (done.value.some(l => l.startsWith('RMAN-'))) return done;
    const failed = done.value.find(l => /^ORA-/.test(l));
    if (failed) return ok(['Statement processed', failed]);
    const lines = ['Statement processed', 'database opened'];
    if (resetlogs) lines.push('new database incarnation registered');
    return ok(lines);
  }
}
