/**
 * Shared dumper for PowerShell / cmd debug runs.
 *
 * The debug suites build a list of commands, hand it to one of the
 * shell runners produced below, and let `runAndDump` replay them
 * sequentially while capturing stdout (or the JS exception if any).
 * The result is written to `<repo>/debug-output/<label>_results_debug.txt`
 * for later analysis.
 *
 * Shell runners are thin wrappers around the production sub-shells
 * (`PowerShellSubShell`, `CmdSubShell`) so the debug transcripts
 * reflect exactly what an end-user types into a terminal session.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Equipment } from '@/network';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { CmdSubShell } from '@/terminal/subshells/CmdSubShell';

const OUTPUT_DIR = path.resolve(__dirname, '../../../debug-output');

export interface DebugCommand {
  /** Free-form section header inserted into the transcript before this cmd. */
  readonly section?: string;
  readonly cmd: string;
}

export type DebugCommandInput = string | DebugCommand;

/**
 * Minimal contract every debug runner must satisfy.  Driven by the new
 * PowerShell sub-shell built on top of `PSInterpreter`, but compatible
 * with any executor that can run a single line and return its stdout.
 */
export interface ShellRunner {
  readonly kind: 'powershell' | 'cmd' | 'linux';
  execute(line: string): Promise<string | null>;
}

/** Wrap a PowerShellSubShell as a {@link ShellRunner}. */
export function createPSRunner(device: Equipment): ShellRunner {
  const { subShell } = PowerShellSubShell.create(device);
  return {
    kind: 'powershell',
    async execute(line: string): Promise<string | null> {
      const r = await subShell.processLine(line);
      if (!r.output || r.output.length === 0) return '';
      return r.output.join('\n');
    },
  };
}

/** Wrap a CmdSubShell as a {@link ShellRunner}. */
export function createCmdRunner(device: Equipment): ShellRunner {
  const { subShell } = CmdSubShell.create(device);
  return {
    kind: 'cmd',
    async execute(line: string): Promise<string | null> {
      const r = await subShell.processLine(line);
      if (!r.output || r.output.length === 0) return '';
      return r.output.join('\n');
    },
  };
}

/**
 * Wrap a Linux device's bash terminal as a {@link ShellRunner}.
 *
 * Drives `LinuxMachine.executeCommand` directly — exactly what an
 * end-user types into the in-browser bash session on a `LinuxPC` /
 * `LinuxServer` device.
 */
export function createLinuxRunner(device: Equipment): ShellRunner {
  return {
    kind: 'linux',
    async execute(line: string): Promise<string | null> {
      const out = await device.executeCommand(line);
      return out ?? '';
    },
  };
}

/**
 * Replay `commands` on the given shell runner and write the transcript.
 *
 * `subdir` writes under `debug-output/<subdir>/` instead of the flat
 * `debug-output/` root — used to keep the per-cmdlet attribute suites
 * in their own dedicated folder.
 */
export async function runAndDump(
  label: string,
  commands: readonly DebugCommandInput[],
  shell: ShellRunner,
  extraHeader?: string,
  subdir?: string,
): Promise<void> {
  const outDir = subdir ? path.join(OUTPUT_DIR, subdir) : OUTPUT_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  const lines: string[] = [];
  lines.push('============================================================');
  lines.push(`Shell debug transcript — ${label}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Engine: ${shell.kind}`);
  if (extraHeader) lines.push(extraHeader);
  lines.push(`Total commands: ${commands.length}`);
  lines.push('============================================================');
  lines.push('');

  const promptPrefix =
    shell.kind === 'powershell' ? 'PS' : shell.kind === 'linux' ? '$' : 'CMD';
  let index = 0;
  for (const entry of commands) {
    index += 1;
    const norm: DebugCommand =
      typeof entry === 'string' ? { cmd: entry } : entry;
    if (norm.section) {
      lines.push('');
      lines.push(`--- [${index}] § ${norm.section} ---`);
    }
    lines.push(`${promptPrefix} [${index}/${commands.length}]> ${norm.cmd}`);
    let out: string | null = null;
    try {
      out = await shell.execute(norm.cmd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lines.push(`<JS EXCEPTION> ${msg}`);
      lines.push('');
      continue;
    }
    if (out === null || out === undefined) {
      lines.push('<null>');
    } else if (out === '') {
      lines.push('<empty>');
    } else {
      for (const raw of out.split(/\r?\n/)) {
        lines.push('  ' + raw);
      }
    }
    lines.push('');
  }

  const outPath = path.join(outDir, `${label}_results_debug.txt`);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
}

/**
 * A command tagged with the shell it must run on — used by coherence
 * suites that interleave cmd.exe and PowerShell operations against
 * the same device to verify that state mutations are visible from
 * both engines.
 */
export interface CoherenceCommand {
  readonly shell: 'ps' | 'cmd';
  readonly cmd: string;
  readonly section?: string;
}

/**
 * Replay an interleaved cmd/PowerShell command list against ONE
 * device and dump the transcript.  `psShell` and `cmdShell` MUST
 * both be created from the same `Equipment` so they share state.
 */
export async function runCoherenceDump(
  label: string,
  commands: readonly CoherenceCommand[],
  psShell: ShellRunner,
  cmdShell: ShellRunner,
  extraHeader?: string,
): Promise<void> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const lines: string[] = [];
  lines.push('============================================================');
  lines.push(`Coherence debug transcript — ${label}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  if (extraHeader) lines.push(extraHeader);
  lines.push(`Total commands: ${commands.length}`);
  lines.push('============================================================');
  lines.push('');

  let index = 0;
  for (const entry of commands) {
    index += 1;
    if (entry.section) {
      lines.push('');
      lines.push(`--- [${index}] § ${entry.section} ---`);
    }
    const prefix = entry.shell === 'ps' ? 'PS ' : 'CMD';
    lines.push(`${prefix} [${index}/${commands.length}]> ${entry.cmd}`);
    let out: string | null = null;
    try {
      out = await (entry.shell === 'ps' ? psShell : cmdShell).execute(entry.cmd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lines.push(`<JS EXCEPTION> ${msg}`);
      lines.push('');
      continue;
    }
    if (out === null || out === undefined) {
      lines.push('<null>');
    } else if (out === '') {
      lines.push('<empty>');
    } else {
      for (const raw of out.split(/\r?\n/)) {
        lines.push('  ' + raw);
      }
    }
    lines.push('');
  }

  const outPath = path.join(OUTPUT_DIR, `${label}_results_debug.txt`);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
}
