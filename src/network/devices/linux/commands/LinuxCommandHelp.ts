/**
 * Help / man-page rendering for `LinuxCommand`.
 *
 * Given a command with a declarative `options` array (plus optional
 * `usage`, `help`, `manSection`), produce:
 *
 *   - `renderHelp(cmd)`   — compact text shown by `--help`
 *   - `renderManPage(cmd)` — full man page shown by `man <cmd>`
 *
 * Keeping the rendering here (rather than in `LinuxMachine`) means every
 * command benefits from the same help format, and tests can exercise
 * the rendering in isolation without spinning up an `EndHost`.
 */

import type { LinuxCommand, LinuxCommandOption } from './LinuxCommand';

/** Format a single option line: `-c count      Stop after ...` */
function formatOptionLine(opt: LinuxCommandOption): string {
  const flagAndArg = opt.takesArg && opt.argName ? `${opt.flag} ${opt.argName}` : opt.flag;
  // Pad to a stable column width so descriptions line up.
  const padded = flagAndArg.padEnd(16, ' ');
  return `  ${padded}${opt.description}`;
}

/** Text shown by `<cmd> --help`. */
export function renderHelp(cmd: LinuxCommand): string {
  const lines: string[] = [];
  const usage = cmd.usage ?? cmd.name;
  lines.push(`Usage: ${usage}`);

  if (cmd.options && cmd.options.length > 0) {
    lines.push('');
    lines.push('Options:');
    for (const opt of cmd.options) {
      lines.push(formatOptionLine(opt));
    }
  }

  return lines.join('\n');
}

/** Full man page for `man <cmd>`. */
export function renderManPage(cmd: LinuxCommand): string {
  const section = cmd.manSection ?? 8;
  const header = `${cmd.name.toUpperCase()}(${section})`;
  const lines: string[] = [header, '', 'NAME', `       ${cmd.name}`, ''];

  lines.push('SYNOPSIS');
  lines.push(`       ${cmd.usage ?? cmd.name}`);
  lines.push('');

  lines.push('DESCRIPTION');
  // Use the first line of `help` as the summary; fall back to the full
  // help text if no options are declared (keeps legacy behavior for
  // commands that haven't migrated yet).
  const helpText = cmd.help ?? '';
  if (cmd.options && cmd.options.length > 0) {
    // With declarative options, keep the DESCRIPTION short — options are
    // rendered separately. Take everything up to the first blank line.
    const summary = helpText.split(/\n\s*\n/)[0] || cmd.name;
    for (const line of summary.split('\n')) lines.push(`       ${line}`);
    lines.push('');
    lines.push('OPTIONS');
    for (const opt of cmd.options) {
      const flagAndArg = opt.takesArg && opt.argName ? `${opt.flag} ${opt.argName}` : opt.flag;
      lines.push(`       ${flagAndArg}`);
      lines.push(`              ${opt.description}`);
    }
  } else {
    // Legacy path: dump the full help text verbatim.
    for (const line of helpText.split('\n')) lines.push(`       ${line}`);
  }

  lines.push('');
  lines.push(header);
  return lines.join('\n');
}
