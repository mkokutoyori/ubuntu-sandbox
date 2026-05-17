/**
 * Shared RMAN debug harness.
 *
 * Each debug suite hands a list of RMAN commands (interleaved with the
 * occasional shell shortcut) to the runner, which replays them through
 * `ReactiveRmanSubShell` and dumps the transcript under
 * `debug-output/rman/<label>_results_debug.txt`.
 *
 * No assumptions are made about which commands are implemented — the
 * transcript captures success, error, or JS-exception output verbatim
 * so a human can diff the file and decide what to fix.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Equipment } from '@/network';
import { ReactiveRmanSubShell } from '@/terminal/subshells/rman';
import type { ISubShell } from '@/terminal/subshells/ISubShell';

const OUTPUT_DIR = path.resolve(__dirname, '../../../../debug-output/rman');

/** A single line of input — either a free string or a tagged section header. */
export interface DebugLine {
  /** Section header inserted into the transcript before this line. */
  readonly section?: string;
  /** The RMAN input (may contain a trailing semicolon). */
  readonly cmd: string;
  /** Optional comment rendered as a `#`-prefixed line above the command. */
  readonly note?: string;
}

export type RmanDebugLine = string | DebugLine;

export interface RmanShellRunner {
  /** The owning device — exposed so suites can mutate state between commands. */
  readonly device: Equipment;
  /** Replays a single RMAN line through the active sub-shell. */
  execute(line: string): string;
  /** Tears the sub-shell down — important for the OracleInstanceWatcherActor. */
  dispose(): void;
  /** The banner produced when the sub-shell was created. */
  banner(): readonly string[];
}

export function createRmanRunner(device: Equipment, args: string[] = ['target', '/']): RmanShellRunner {
  const { subShell, banner } = ReactiveRmanSubShell.create(device, args);
  const sb: ISubShell = subShell;
  return {
    device,
    banner: () => banner,
    execute(line: string): string {
      try {
        const r = sb.processLine(line);
        const out = (r.output ?? []).join('\n');
        return out;
      } catch (e) {
        return `<JS EXCEPTION> ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    dispose() { sb.dispose(); },
  };
}

/** Build the file header. */
function header(label: string, topology: string, total: number): string[] {
  return [
    '============================================================',
    `RMAN debug transcript — ${label}`,
    `Generated: ${new Date().toISOString()}`,
    `Topology:  ${topology}`,
    `Total commands: ${total}`,
    '============================================================',
    '',
  ];
}

/**
 * Replay `lines` against a single runner and write the transcript.
 *
 * The runner is NOT disposed by this helper — callers may want to swap
 * runners mid-scenario (e.g. shut Oracle down, re-open rman) and need
 * full control of the lifecycle.
 */
export function runRmanDump(
  label: string,
  topology: string,
  lines: readonly RmanDebugLine[],
  runner: RmanShellRunner,
): void {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const out: string[] = [];
  out.push(...header(label, topology, lines.length));

  // Stamp the banner once so the transcript starts at a recognisable
  // RMAN prompt without polluting the command index.
  for (const b of runner.banner()) out.push('  ' + b);
  out.push('');

  let i = 0;
  for (const entry of lines) {
    i += 1;
    const norm: DebugLine = typeof entry === 'string' ? { cmd: entry } : entry;
    if (norm.section) {
      out.push('');
      out.push(`--- [${i}] § ${norm.section} ---`);
    }
    if (norm.note) out.push(`# ${norm.note}`);
    out.push(`RMAN [${i}/${lines.length}]> ${norm.cmd}`);
    const result = runner.execute(norm.cmd);
    if (!result) out.push('<empty>');
    else for (const raw of result.split(/\r?\n/)) out.push('  ' + raw);
    out.push('');
  }

  const outPath = path.join(OUTPUT_DIR, `${label}_results_debug.txt`);
  fs.writeFileSync(outPath, out.join('\n'), 'utf8');
}

/**
 * Multi-runner replay — each entry pairs a runner alias with the command,
 * so a scenario can alternate between two or more devices/sessions and
 * still produce one chronological transcript.
 */
export interface MultiLine {
  readonly runner: string;
  readonly cmd:    string;
  readonly section?: string;
  readonly note?:    string;
}

export function runRmanMultiDump(
  label: string,
  topology: string,
  lines: readonly MultiLine[],
  runners: Readonly<Record<string, RmanShellRunner>>,
): void {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const out: string[] = [];
  out.push(...header(label, topology, lines.length));

  for (const [alias, r] of Object.entries(runners)) {
    out.push(`@${alias} banner:`);
    for (const b of r.banner()) out.push('  ' + b);
    out.push('');
  }

  let i = 0;
  for (const entry of lines) {
    i += 1;
    if (entry.section) {
      out.push('');
      out.push(`--- [${i}] § ${entry.section} ---`);
    }
    if (entry.note) out.push(`# ${entry.note}`);
    const r = runners[entry.runner];
    if (!r) {
      out.push(`@${entry.runner} [${i}/${lines.length}]> ${entry.cmd}`);
      out.push('  <unknown runner>');
      out.push('');
      continue;
    }
    out.push(`@${entry.runner} [${i}/${lines.length}]> ${entry.cmd}`);
    const result = r.execute(entry.cmd);
    if (!result) out.push('  <empty>');
    else for (const raw of result.split(/\r?\n/)) out.push('  ' + raw);
    out.push('');
  }

  const outPath = path.join(OUTPUT_DIR, `${label}_results_debug.txt`);
  fs.writeFileSync(outPath, out.join('\n'), 'utf8');
}
