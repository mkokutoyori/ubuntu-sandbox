/**
 * `:set` transcripts recorded from a real vim 9.1 (scripts/oracle/record_vim_options.py): 912
 * command sequences replayed in a fresh headless session, once as `vim -u DEFAULTS` and once as
 * the same binary invoked as `vi` (compatible).  Each sequence carries the output or the error of
 * every command and the options that differ from the startup values at the end.  Covered: the
 * boolean forms (`opt` `noopt` `invopt` `opt!` `opt&` `opt?`), the numeric forms (`=` `:` `+=` `-=`
 * `^=`, hexadecimal/binary/octal, the E487/E474/E521/E488 refusals and the clamping vim applies
 * to 'numberwidth'), the comma-list string options, `setlocal`/`setglobal`, and several options
 * per command with the abort at the first bad one.
 *
 * Measured with `git stash push -- src/network`: the module does not exist on the previous tree,
 * so the whole file cannot import (every replay case fails before, 0 after).  The corpus-size
 * case would pass on any tree that could load the fixture (witness that it loads).
 * The bare `:set` listing, the sequences that use 'textwidth' (not modelled) and the ones that set 'filetype=python' are not replayed: vim's ftplugin also changes
 * tabstop/shiftwidth/softtabstop/expandtab/autoindent, which is a separate step.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { VimOptions, type OptionName, type SetScope } from '@/network/devices/linux/editors/vim/VimOptions';

interface RecordedCase { commands: string[]; messages: string[]; changed: Record<string, string | number> }
interface Recorded {
  vim: string;
  options: { name: string; short: string; kind: string }[];
  variants: Record<'vim' | 'vi', { defaults: Record<string, string | number>; cases: RecordedCase[] }>;
}

const recorded: Recorded = JSON.parse(readFileSync('src/__tests__/support/oracle/vim-options/vim-9.1-set.json', 'utf8'));

function startup(profile: 'vim' | 'vi'): VimOptions {
  const options = new VimOptions(profile);
  options.assign('filetype', recorded.variants[profile].defaults.filetype as string);
  options.assign('fileencoding', 'utf-8');
  return options;
}

function runCommand(options: VimOptions, command: string): string {
  let output = '';
  for (const part of command.split('|')) {
    const match = /^(setlocal|setglobal|set)\s*(.*)$/.exec(part);
    const outcome = options.apply(match![2], match![1] as SetScope);
    if (outcome.error) return `ERR:${outcome.message}`;
    if (outcome.message !== '') output += `\n${outcome.message}\n`;
  }
  return output;
}

function sorted(values: Record<string, string | number>): string {
  return JSON.stringify(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
}

function currentValue(options: VimOptions, kind: string, name: string): string | number {
  if (kind === 'bool') return options.bool(name as OptionName) ? 1 : 0;
  if (kind === 'number') return options.number(name as OptionName);
  return options.string(name as OptionName);
}

function replay(profile: 'vim' | 'vi', recordedCase: RecordedCase): string | null {
  if (recordedCase.commands.some((c) => /\bft=python\b/.test(c) || /^set\s*$/.test(c) || /\btw=/.test(c))) return null;
  const options = startup(profile);
  const messages = recordedCase.commands.map((command) => runCommand(options, command));
  if (JSON.stringify(messages) !== JSON.stringify(recordedCase.messages)) {
    return `${JSON.stringify(recordedCase.commands)}: want ${JSON.stringify(recordedCase.messages)}, got ${JSON.stringify(messages)}`;
  }
  const defaults = recorded.variants[profile].defaults;
  const changed: Record<string, string | number> = {};
  for (const option of recorded.options) {
    const now = currentValue(options, option.kind, option.name);
    if (now !== defaults[option.name]) changed[option.name] = now;
  }
  if (sorted(changed) !== sorted(recordedCase.changed)) {
    return `${JSON.stringify(recordedCase.commands)}: want state ${sorted(recordedCase.changed)}, got ${sorted(changed)}`;
  }
  return null;
}

describe('`:set` transcripts recorded from a real vim', () => {
  it('the recorded corpus is not empty', () => {
    expect(recorded.vim).toMatch(/^VIM - Vi IMproved 9\.1/);
    expect(recorded.variants.vim.cases.length).toBeGreaterThan(900);
    expect(recorded.variants.vi.cases.length).toBe(recorded.variants.vim.cases.length);
  });

  it.each(['vim', 'vi'] as const)('replays every sequence with the same output and the same options (%s)', (profile) => {
    const failures = recorded.variants[profile].cases
      .map((c) => replay(profile, c))
      .filter((f): f is string => f !== null);
    expect(failures.slice(0, 8)).toEqual([]);
  });
});
