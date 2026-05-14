/**
 * Shared dumper for PowerShell debug runs.
 *
 * Each debug suite supplies a label, a list of commands, and an executor —
 * we replay the commands sequentially, capture stdout (or the JS exception
 * if any), and write a human-readable transcript to
 * `<repo>/debug-output/<label>_results_debug.txt` for later analysis.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PowerShellExecutor } from '@/network/devices/windows/PowerShellExecutor';
import { PSInterpreter, PSRuntimeError } from '@/powershell/interpreter/PSInterpreter';
import { PSParserError } from '@/powershell/parser/PSParserError';

const OUTPUT_DIR = path.resolve(__dirname, '../../../debug-output');

export interface DebugCommand {
  /** Free-form section header inserted into the transcript before this cmd. */
  readonly section?: string;
  readonly cmd: string;
}

export type DebugCommandInput = string | DebugCommand;

/**
 * Same dispatch flow as PowerShellSubShell: try PSInterpreter first, and only
 * fall back to the legacy string-based PowerShellExecutor when the interpreter
 * either can't parse the input or signals "not recognized". Keeps debug
 * transcripts representative of what end users actually see in the terminal.
 */
function buildDispatcher(ps: PowerShellExecutor): (cmd: string) => Promise<string | null> {
  const interp = new PSInterpreter();
  interp.envVarHook = (name: string) => ps.resolveEnvVar(name);
  interp.testPathHook = (p: string) => ps.testPathRaw(p);
  const isFallback = (e: unknown): boolean => {
    if (e instanceof PSParserError) return true;
    if (e instanceof PSRuntimeError) return /not recognized/i.test(e.message);
    if (e instanceof Error) return /not recognized/i.test(e.message);
    return false;
  };
  return async (cmd: string) => {
    try {
      return interp.executeInteractive(cmd);
    } catch (e) {
      if (isFallback(e)) return ps.execute(cmd);
      return e instanceof Error ? e.message : String(e);
    }
  };
}

export async function runAndDump(
  label: string,
  commands: readonly DebugCommandInput[],
  ps: PowerShellExecutor,
  extraHeader?: string,
): Promise<void> {
  const dispatch = buildDispatcher(ps);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const lines: string[] = [];
  lines.push('============================================================');
  lines.push(`PowerShell debug transcript — ${label}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  if (extraHeader) lines.push(extraHeader);
  lines.push(`Total commands: ${commands.length}`);
  lines.push('============================================================');
  lines.push('');

  let index = 0;
  for (const entry of commands) {
    index += 1;
    const norm: DebugCommand =
      typeof entry === 'string' ? { cmd: entry } : entry;
    if (norm.section) {
      lines.push('');
      lines.push(`--- [${index}] § ${norm.section} ---`);
    }
    lines.push(`PS [${index}/${commands.length}]> ${norm.cmd}`);
    let out: string | null = null;
    try {
      out = await dispatch(norm.cmd);
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
      // Indent block so it's visually separated from the prompt.
      for (const raw of out.split(/\r?\n/)) {
        lines.push('  ' + raw);
      }
    }
    lines.push('');
  }

  const outPath = path.join(OUTPUT_DIR, `${label}_results_debug.txt`);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
}
