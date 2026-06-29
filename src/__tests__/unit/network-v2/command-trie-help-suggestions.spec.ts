/**
 * CommandTrie ? help & hint-suggestion contract.
 *
 * Locks in the IOS-style `?` semantics:
 *   - prefix listing      ("sh?"   → keywords starting with "sh")
 *   - subcommand listing  ("show ?" → children of show + <cr> + hints)
 *   - silent no-match     ("z?"    → empty)
 *   - merged hints        children take precedence; manual hints fill the
 *                          gap when the trie doesn't have every IOS keyword
 *                          registered (e.g. `copy startup-config`).
 */
import { describe, it, expect } from 'vitest';
import { CommandTrie } from '@/network/devices/shells/CommandTrie';

function trieWithSuggestions(): CommandTrie {
  const t = new CommandTrie();
  t.register('show clock', 'Display the system clock', () => '');
  t.register('show version', 'Display version information', () => '');
  t.register('copy running-config startup-config', 'Save configuration', () => '');
  t.registerGreedy('copy', 'Copy a file', () => '');
  t.registerGreedy('interface', 'Select an interface to configure', () => '');
  t.registerSuggestions('copy', [
    { keyword: 'running-config', description: 'Running configuration' },
    { keyword: 'startup-config', description: 'Startup configuration' },
    { keyword: 'tftp:',          description: 'TFTP server' },
  ]);
  t.registerSuggestions('interface', [
    { keyword: 'GigabitEthernet', description: 'Gigabit' },
    { keyword: 'Loopback',        description: 'Loopback' },
  ]);
  t.registerSuggestions('write', [
    { keyword: 'memory',   description: 'Write to NVRAM' },
    { keyword: 'terminal', description: 'Display running-config' },
  ]);
  return t;
}

describe('CommandTrie ? completion semantics', () => {
  it('lists keyword prefixes for "<prefix>?" without trailing space', () => {
    const t = trieWithSuggestions();
    const matches = t.getCompletions('sh');
    expect(matches.map(m => m.keyword)).toContain('show');
  });

  it('lists subcommands for "<keyword> ?" with trailing space', () => {
    const t = trieWithSuggestions();
    const matches = t.getCompletions('show ');
    const keywords = matches.map(m => m.keyword);
    expect(keywords).toContain('clock');
    expect(keywords).toContain('version');
  });

  it('returns no completions for a prefix that matches nothing', () => {
    const t = trieWithSuggestions();
    expect(t.getCompletions('zzz')).toEqual([]);
  });

  it('merges manual hint suggestions with registered children (deduped)', () => {
    const t = trieWithSuggestions();
    const matches = t.getCompletions('copy ');
    const keywords = matches.map(m => m.keyword);
    expect(keywords).toContain('running-config');
    expect(keywords).toContain('startup-config'); // hint-only
    expect(keywords).toContain('tftp:');          // hint-only
    expect(keywords.filter(k => k === 'running-config').length).toBe(1);
  });

  it('uses hints to replace the generic <WORD> placeholder for greedy commands with no children', () => {
    const t = trieWithSuggestions();
    const matches = t.getCompletions('interface ');
    const keywords = matches.map(m => m.keyword);
    expect(keywords).toContain('GigabitEthernet');
    expect(keywords).toContain('Loopback');
    expect(keywords).not.toContain('WORD');
  });

  it('falls back to <WORD> only when no children and no hints are registered for a greedy node', () => {
    const t = new CommandTrie();
    t.registerGreedy('hostname', 'Set hostname', () => '');
    const matches = t.getCompletions('hostname ');
    expect(matches.map(m => m.keyword)).toContain('WORD');
  });

  it('emits <cr> when the matched node is itself executable', () => {
    const t = trieWithSuggestions();
    const matches = t.getCompletions('show clock ');
    expect(matches.map(m => m.keyword)).toContain('<cr>');
  });

  it('registerSuggestions creates path nodes if the registered command does not exist yet (order-independent)', () => {
    const t = new CommandTrie();
    t.registerSuggestions('write', [
      { keyword: 'memory',   description: 'Write to NVRAM' },
      { keyword: 'terminal', description: 'Display running-config' },
    ]);
    const matches = t.getCompletions('write ');
    expect(matches.map(m => m.keyword)).toContain('memory');
    expect(matches.map(m => m.keyword)).toContain('terminal');
  });
});
