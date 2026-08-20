import { describe, it, expect } from 'vitest';
import {
  CompletionController,
  ReadlinePolicy,
  CyclingPolicy,
  SilentUniquePolicy,
  LastWordSource,
  FullLineSource,
  splitLastWord,
} from '@/terminal/completion';
import type { ICompletionSource } from '@/terminal/completion';

function staticSource(candidates: string[], base = ''): ICompletionSource {
  return { query: () => (candidates.length ? { base, candidates, appendSpaceOnUnique: false } : null) };
}

describe('splitLastWord', () => {
  it('splits the trailing token and preserves everything before it', () => {
    expect(splitLastWord('ls /ho')).toEqual({ base: 'ls ', word: '/ho' });
    expect(splitLastWord('cat')).toEqual({ base: '', word: 'cat' });
    expect(splitLastWord('echo a  b')).toEqual({ base: 'echo a  ', word: 'b' });
    expect(splitLastWord('ls ')).toEqual({ base: 'ls ', word: '' });
    expect(splitLastWord('')).toEqual({ base: '', word: '' });
  });
});

describe('ReadlinePolicy via CompletionController', () => {
  it('unique candidate completes the last word', () => {
    const c = new CompletionController(new ReadlinePolicy({ caseInsensitive: false }));
    const src = new LastWordSource(() => ['home/'], { uniqueSpace: 'first-word' });
    const out = c.handleTab('ls /ho', src, false);
    expect(out.input).toBe('ls home/');
    expect(out.suggestions).toBeNull();
  });

  it('unique first word gets a trailing space in first-word mode', () => {
    const c = new CompletionController(new ReadlinePolicy({ caseInsensitive: false }));
    const src = new LastWordSource(() => ['ifconfig'], { uniqueSpace: 'first-word' });
    const out = c.handleTab('ifco', src, false);
    expect(out.input).toBe('ifconfig ');
  });

  it('extends to the longest common prefix when several candidates share one', () => {
    const c = new CompletionController(new ReadlinePolicy({ caseInsensitive: false }));
    const src = new LastWordSource(() => ['interface-up', 'interface-down']);
    const out = c.handleTab('show inter', src, false);
    expect(out.input).toBe('show interface-');
    expect(out.suggestions).toBeNull();
  });

  it('lists suggestions when the prefix cannot be extended', () => {
    const c = new CompletionController(new ReadlinePolicy({ caseInsensitive: false }));
    const src = new LastWordSource(() => ['abc', 'abd']);
    const out = c.handleTab('x ab', src, false);
    expect(out.input).toBe('x ab');
    expect(out.suggestions).toEqual(['abc', 'abd']);
  });

  it('caps suggestions at 30', () => {
    const many = Array.from({ length: 50 }, (_, i) => `f${String(i).padStart(2, '0')}`);
    const c = new CompletionController(new ReadlinePolicy({ caseInsensitive: false }));
    const out = c.handleTab('cat f', new LastWordSource(() => many), false);
    expect(out.suggestions).toHaveLength(30);
  });

  it('case-insensitive variant extends using CI prefix', () => {
    const c = new CompletionController(new ReadlinePolicy({ caseInsensitive: true }));
    const src = new LastWordSource(() => ['Program Files', 'ProgramData']);
    const out = c.handleTab('cd Pro', src, false);
    expect(out.input).toBe('cd Program');
  });

  it('no candidates → input unchanged, nothing to show', () => {
    const c = new CompletionController(new ReadlinePolicy({ caseInsensitive: false }));
    const out = c.handleTab('zzz', new LastWordSource(() => []), false);
    expect(out).toEqual({ input: 'zzz', suggestions: null, changed: false });
  });
});

describe('CyclingPolicy via CompletionController (PowerShell/Huawei semantics)', () => {
  const candidates = ['Get-LocalGroup', 'Get-LocalGroupMember', 'Get-LocalUser'];

  it('unique candidate completes with NO trailing space when source says so', () => {
    const c = new CompletionController(new CyclingPolicy());
    const src = new LastWordSource(() => ['Get-ChildItem'], { uniqueSpace: 'never' });
    const out = c.handleTab('Get-Childi', src, false);
    expect(out.input).toBe('Get-ChildItem');
  });

  it('first Tab inserts candidate[0], repeated Tab cycles forward and wraps', () => {
    const c = new CompletionController(new CyclingPolicy());
    const src = new LastWordSource(() => candidates);
    let out = c.handleTab('Get-Local', src, false);
    expect(out.input).toBe('Get-LocalGroup');
    out = c.handleTab(out.input, src, false);
    expect(out.input).toBe('Get-LocalGroupMember');
    out = c.handleTab(out.input, src, false);
    expect(out.input).toBe('Get-LocalUser');
    out = c.handleTab(out.input, src, false);
    expect(out.input).toBe('Get-LocalGroup');
  });

  it('Shift+Tab cycles backward', () => {
    const c = new CompletionController(new CyclingPolicy());
    const src = new LastWordSource(() => candidates);
    let out = c.handleTab('Get-Local', src, false);
    out = c.handleTab(out.input, src, false);
    out = c.handleTab(out.input, src, true);
    expect(out.input).toBe('Get-LocalGroup');
  });

  it('reverse first Tab starts from the last candidate', () => {
    const c = new CompletionController(new CyclingPolicy());
    const src = new LastWordSource(() => candidates);
    const out = c.handleTab('Get-Local', src, true);
    expect(out.input).toBe('Get-LocalUser');
  });

  it('editing the buffer between Tabs breaks the cycle', () => {
    const c = new CompletionController(new CyclingPolicy());
    const src = new LastWordSource(() => candidates);
    const out = c.handleTab('Get-Local', src, false);
    c.notifyInputChanged(out.input + 'X');
    const fresh = c.handleTab('Get-Local', src, false);
    expect(fresh.input).toBe('Get-LocalGroup');
  });

  it('keeps the untouched left part of the line intact while cycling', () => {
    const c = new CompletionController(new CyclingPolicy());
    const src = new LastWordSource(() => ['Name', 'NameLike']);
    let out = c.handleTab('Get-Process | Where-Object Na', src, false);
    expect(out.input).toBe('Get-Process | Where-Object Name');
    out = c.handleTab(out.input, src, false);
    expect(out.input).toBe('Get-Process | Where-Object NameLike');
  });

  it('cycling survives a stale source (cycle state does not re-query)', () => {
    const c = new CompletionController(new CyclingPolicy());
    let calls = 0;
    const src: ICompletionSource = {
      query: () => { calls++; return { base: '', candidates: ['aa', 'ab'], appendSpaceOnUnique: false }; },
    };
    let out = c.handleTab('a', src, false);
    out = c.handleTab(out.input, src, false);
    expect(calls).toBe(1);
    expect(out.input).toBe('ab');
  });
});

describe('SilentUniquePolicy via CompletionController (Cisco semantics)', () => {
  it('unique candidate completes with trailing space via FullLineSource', () => {
    const c = new CompletionController(new SilentUniquePolicy());
    const src = new FullLineSource(() => ['show']);
    const out = c.handleTab('sh', src, false);
    expect(out.input).toBe('show ');
    expect(out.changed).toBe(true);
  });

  it('ambiguous input is a silent no-op', () => {
    const c = new CompletionController(new SilentUniquePolicy());
    const src = new FullLineSource(() => ['show', 'shutdown']);
    const out = c.handleTab('s', src, false);
    expect(out.input).toBe('s');
    expect(out.suggestions).toBeNull();
    expect(out.changed).toBe(false);
  });
});

describe('parity corpus — ReadlinePolicy matches the retired TabCompletionHelper (pinned values)', () => {
  const corpus: Array<{ input: string; candidates: string[]; expected: string; suggestions: string[] | null }> = [
    { input: 'ls /ho', candidates: ['home/'], expected: 'ls home/', suggestions: null },
    { input: 'ifco', candidates: ['ifconfig'], expected: 'ifconfig ', suggestions: null },
    { input: 'cat /etc/pas', candidates: ['passwd', 'passwd-'], expected: 'cat /etc/pas', suggestions: ['passwd', 'passwd-'] },
    { input: 'x ab', candidates: ['abc', 'abd'], expected: 'x ab', suggestions: ['abc', 'abd'] },
    { input: 'ping -', candidates: ['-c', '-i', '-t'], expected: 'ping -', suggestions: ['-c', '-i', '-t'] },
    { input: 'foo', candidates: [], expected: 'foo', suggestions: null },
    { input: 'cd D', candidates: ['Documents/', 'Downloads/'], expected: 'cd Do', suggestions: null },
  ];

  it.each(corpus)('case-sensitive: "$input" → "$expected"', ({ input, candidates, expected, suggestions }) => {
    const c = new CompletionController(new ReadlinePolicy({ caseInsensitive: false }));
    const out = c.handleTab(input, new LastWordSource(() => candidates, { uniqueSpace: 'first-word' }), false);
    expect(out.input).toBe(expected);
    expect(out.suggestions).toEqual(suggestions);
  });

  it.each(corpus)('case-insensitive: "$input" → "$expected"', ({ input, candidates, expected, suggestions }) => {
    const c = new CompletionController(new ReadlinePolicy({ caseInsensitive: true }));
    const out = c.handleTab(input, new LastWordSource(() => candidates, { uniqueSpace: 'first-word' }), false);
    expect(out.input).toBe(expected);
    expect(out.suggestions).toEqual(suggestions);
  });

  it('intentional divergence from the retired helper: internal whitespace is preserved, not collapsed', () => {
    const c = new CompletionController(new ReadlinePolicy({ caseInsensitive: false }));
    const out = c.handleTab('echo a  /ho', new LastWordSource(() => ['home/'], { uniqueSpace: 'first-word' }), false);
    expect(out.input).toBe('echo a  home/');
  });
});
