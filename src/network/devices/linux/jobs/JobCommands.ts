/**
 * JobCommands — jobs / bg / fg / wait / disown / nohup / pstree builtins.
 *
 * All commands operate against a {@link LinuxJobTable} and the owning
 * {@link LinuxProcessManager}. Output formatting matches GNU bash /
 * util-linux closely enough for the dump-driven tests to parse it.
 */

import type { LinuxProcessManager, ProcessInfo } from '../LinuxProcessManager';
import type { LinuxJobTable, JobEntry } from './LinuxJobTable';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';

export interface JobCmdContext {
  pm: LinuxProcessManager;
  jobs: LinuxJobTable;
}

export interface JobResult { output: string; exitCode: number; }

const NO_SUCH_JOB = (cmd: string, spec: string): JobResult => ({
  output: `bash: ${cmd}: ${spec}: no such job`,
  exitCode: 1,
});

/** Format the current/previous marker for a job. */
function marker(table: LinuxJobTable, j: JobEntry): string {
  if (table.isCurrent(j.id)) return '+';
  if (table.isPrevious(j.id)) return '-';
  return ' ';
}

function formatJob(table: LinuxJobTable, j: JobEntry, long: boolean): string {
  const state = padToWidth(j.state, 24);
  const head = long ? `${marker(table, j)} ${padToWidth(String(j.pid), 5, 'right')} ` : `${marker(table, j)}  `;
  return `[${j.id}]${head}${state}${j.command}`;
}

// ─── jobs ─────────────────────────────────────────────────────────────

export function cmdJobs(args: string[], ctx: JobCmdContext): JobResult {
  let long = false;
  let pidsOnly = false;
  const specs: string[] = [];
  for (const a of args) {
    if (a === '-l') long = true;
    else if (a === '-p') pidsOnly = true;
    else if (a === '-r' || a === '-s' || a === '-n') { /* filters: no-op in sim */ }
    else if (a.startsWith('%')) specs.push(a);
    else if (a.startsWith('-')) return { output: `bash: jobs: ${a}: invalid option`, exitCode: 2 };
    else specs.push(a);
  }

  let entries: JobEntry[];
  if (specs.length > 0) {
    entries = [];
    for (const s of specs) {
      const j = ctx.jobs.resolve(s);
      if (!j) return NO_SUCH_JOB('jobs', s);
      entries.push(j);
    }
  } else {
    entries = ctx.jobs.list();
  }

  if (entries.length === 0) return { output: '', exitCode: 0 };
  if (pidsOnly) return { output: entries.map(j => String(j.pid)).join('\n'), exitCode: 0 };
  return { output: entries.map(j => formatJob(ctx.jobs, j, long)).join('\n'), exitCode: 0 };
}

// ─── fg ───────────────────────────────────────────────────────────────

/**
 * `fg` brings a job to the foreground. In this synchronous simulator we
 * don't actually block on the process; instead we print the command (as
 * bash does) and remove the job from the table.
 */
export function cmdFg(args: string[], ctx: JobCmdContext): JobResult {
  const spec = args[0] ?? '%+';
  const j = ctx.jobs.resolve(spec);
  if (!j) {
    if (args.length === 0) return { output: 'bash: fg: current: no such job', exitCode: 1 };
    return NO_SUCH_JOB('fg', spec);
  }
  const lines: string[] = [];
  // bash echoes the command line being resumed.
  lines.push(j.command.replace(/\s*&\s*$/, ''));
  // The simulator runs background jobs eagerly during `cmd &`, so by the
  // time fg picks them up the captured stdout is already buffered on the
  // job. Re-emit it so the user sees what the resumed command produced
  // (matches the bytes that would have hit the terminal had the command
  // been started in the foreground).
  if (j.capturedOutput) lines.push(j.capturedOutput.replace(/\n$/, ''));
  const exit = j.exitCode ?? 0;
  ctx.jobs.remove(j.id);
  return { output: lines.join('\n'), exitCode: exit };
}

// ─── bg ───────────────────────────────────────────────────────────────

export function cmdBg(args: string[], ctx: JobCmdContext): JobResult {
  const spec = args[0] ?? '%+';
  const j = ctx.jobs.resolve(spec);
  if (!j) {
    if (args.length === 0) return { output: 'bash: bg: current: no such job', exitCode: 1 };
    return NO_SUCH_JOB('bg', spec);
  }
  j.state = 'Running';
  ctx.jobs.promote(j.id);
  const cmd = j.command.endsWith('&') ? j.command : `${j.command} &`;
  return { output: `[${j.id}]${marker(ctx.jobs, j)} ${cmd}`, exitCode: 0 };
}

// ─── disown ───────────────────────────────────────────────────────────

export function cmdDisown(args: string[], ctx: JobCmdContext): JobResult {
  if (args.length === 0) {
    for (const j of ctx.jobs.list()) ctx.jobs.remove(j.id);
    return { output: '', exitCode: 0 };
  }
  // -a → all jobs; -r → running only (sim: all)
  for (const a of args) {
    if (a === '-a' || a === '-r' || a === '-h') {
      for (const j of ctx.jobs.list()) ctx.jobs.remove(j.id);
      continue;
    }
    const j = ctx.jobs.resolve(a);
    if (!j) return NO_SUCH_JOB('disown', a);
    ctx.jobs.remove(j.id);
  }
  return { output: '', exitCode: 0 };
}

// ─── wait ─────────────────────────────────────────────────────────────
