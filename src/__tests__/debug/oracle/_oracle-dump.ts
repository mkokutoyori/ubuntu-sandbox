/**
 * Shared Oracle debug harness — drive sqlplus sessions and dump
 * transcripts under debug-output/oracle/.
 *
 * Same shape as _rman-dump.ts : aucune assertion sur la sortie — le
 * fichier de transcript EST le livrable.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Equipment } from '@/network';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import type { ISubShell } from '@/terminal/subshells/ISubShell';

const OUTPUT_DIR = path.resolve(__dirname, '../../../../debug-output/oracle');

export interface DebugLine {
  readonly section?: string;
  readonly cmd: string;
  readonly note?: string;
}
export type OracleDebugLine = string | DebugLine;

export interface SqlPlusRunner {
  readonly device: Equipment;
  execute(line: string): string;
  dispose(): void;
  banner(): readonly string[];
}

export function createSqlPlusRunner(
  device: Equipment,
  args: string[] = ['/', 'as', 'sysdba'],
): SqlPlusRunner {
  const { subShell, banner, loginOutput } = SqlPlusSubShell.create(device, args);
  const sb: ISubShell = subShell;
  const fullBanner = [...banner, ...loginOutput];
  return {
    device,
    banner: () => fullBanner,
    execute(line: string): string {
      try {
        const r = sb.processLine(line);
        return (r.output ?? []).join('\n');
      } catch (e) {
        return `<JS EXCEPTION> ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    dispose() { sb.dispose(); },
  };
}

function header(label: string, topology: string, total: number): string[] {
  return [
    '============================================================',
    `Oracle debug transcript — ${label}`,
    `Generated: ${new Date().toISOString()}`,
    `Topology:  ${topology}`,
    `Total commands: ${total}`,
    '============================================================',
    '',
  ];
}

export function runOracleDump(
  label: string,
  topology: string,
  lines: readonly OracleDebugLine[],
  runner: SqlPlusRunner,
): void {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const out: string[] = [];
  out.push(...header(label, topology, lines.length));
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
    if (norm.note) out.push(`-- ${norm.note}`);
    out.push(`SQL [${i}/${lines.length}]> ${norm.cmd}`);
    const result = runner.execute(norm.cmd);
    if (!result) out.push('<empty>');
    else for (const raw of result.split(/\r?\n/)) out.push('  ' + raw);
    out.push('');
  }

  const outPath = path.join(OUTPUT_DIR, `${label}_results_debug.txt`);
  fs.writeFileSync(outPath, out.join('\n'), 'utf8');
}
