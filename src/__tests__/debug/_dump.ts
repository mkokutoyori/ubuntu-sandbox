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
import type { PowerShellExecutor } from '@/network/devices/windows/PowerShellExecutor';

const OUTPUT_DIR = path.resolve(__dirname, '../../../debug-output');

export interface DebugCommand {
  /** Free-form section header inserted into the transcript before this cmd. */
  readonly section?: string;
  readonly cmd: string;
}

export type DebugCommandInput = string | DebugCommand;

export async function runAndDump(
  label: string,
  commands: readonly DebugCommandInput[],
  ps: PowerShellExecutor,
  extraHeader?: string,
): Promise<void> {
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
      out = await ps.execute(norm.cmd);
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
