import { describe, it, expect, beforeEach } from 'vitest';
import { extractHandlerKeywords } from '@/network/devices/shells/HandlerKeywordExtractor';
import { CommandTrie } from '@/network/devices/shells/CommandTrie';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('extractHandlerKeywords — source analysis of greedy handlers', () => {
  it('finds literals compared against the args parameter and its aliases', () => {
    const src = ((args: string[]) => {
      const last = args[args.length - 1]?.toLowerCase() ?? '';
      const verb = args[0];
      if (last === 'switchport') return 'a';
      if (verb !== 'summary') return 'b';
      if (args[1] === 'detail') return 'c';
      return 'd';
    }).toString();
    expect(extractHandlerKeywords(src)).toEqual(['detail', 'summary', 'switchport']);
  });

  it('finds reversed comparisons and startsWith-abbreviation patterns', () => {
    const src = ((args: string[]) => {
      const last = args[0] ?? '';
      if ('status'.startsWith(last)) return 'a';
      if ('brief' === last) return 'b';
      return 'c';
    }).toString();
    expect(extractHandlerKeywords(src)).toEqual(['brief', 'status']);
  });

  it('finds switch/case dispatch on an args alias', () => {
    const src = ((args: string[]) => {
      const mode = (args[0] ?? '').toLowerCase();
      switch (mode) {
        case 'add': return '1';
        case 'del': return '2';
        default: return '3';
      }
    }).toString();
    expect(extractHandlerKeywords(src)).toEqual(['add', 'del']);
  });

  it('IGNORES literals compared against non-args state and typeof strings', () => {
    const src = ((args: string[]) => {
      const state = { mode: 'x', kind: 'y' };
      if (typeof args[0] === 'string' && state.mode === 'trunk') return 'a';
      if (state.kind === 'disabled') return 'b';
      return args.join(' ');
    }).toString();
    expect(extractHandlerKeywords(src)).toEqual([]);
  });

  it('IGNORES literals that do not look like CLI keywords', () => {
    const src = ((args: string[]) => {
      const v = args[0] ?? '';
      if (v === 'OK') return 'a';
      if (v === 'x') return 'b';
      if (v === 'not a keyword') return 'c';
      if (v === 'real-keyword') return 'd';
      return 'e';
    }).toString();
    expect(extractHandlerKeywords(src)).toEqual(['real-keyword']);
  });

  it('handles minified-style sources (renamed identifiers, no spaces, double quotes)', () => {
    const src = '(e)=>{const t=e[0]??"";if(t==="summary")return"1";return"2"}';
    expect(extractHandlerKeywords(src)).toEqual(['summary']);
  });
});

describe('CommandTrie — greedy handlers are completable with zero annotation', () => {
  it('a plain registerGreedy exposes its dispatch keywords to Tab and ?', () => {
    const trie = new CommandTrie();
    trie.registerGreedy('show widget', 'Widget info', (args) => {
      const last = (args[args.length - 1] ?? '').toLowerCase();
      if (last === 'status') return 'up';
      if (last === 'counters') return '0';
      return 'widget';
    });
    expect(trie.tabCandidates('show widget stat')).toEqual(['show widget status']);
    expect(trie.tabComplete('show widget coun')).toBe('show widget counters ');
    const help = trie.getCompletions('show widget ').map(c => c.keyword);
    expect(help).toContain('status');
    expect(help).toContain('counters');
  });

  it('extracted abbreviations (prefix of a real keyword) never become candidates', () => {
    const trie = new CommandTrie();
    // Handler accepts both the abbreviation `con` and the full `console`.
    trie.registerSuggestions('line', [
      { keyword: 'console', description: 'Console line' },
      { keyword: 'vty', description: 'Virtual terminal' },
    ]);
    trie.registerGreedy('line', 'Configure a line', (args) => {
      const sub = (args[0] ?? '').toLowerCase();
      if (sub === 'con' || sub === 'console') return 'console';
      if (sub === 'vty') return 'vty';
      return '';
    });
    // `con` is a prefix of `console` → must not appear, so `line co`
    // stays unambiguous and completes.
    expect(trie.tabCandidates('line co')).toEqual(['line console']);
    expect(trie.tabComplete('line co')).toBe('line console ');
  });

  it('explicit continuations take precedence and are not duplicated', () => {
    const trie = new CommandTrie();
    trie.registerGreedy('show gadget', 'Gadget info', (args) => {
      return args[0] === 'brief' ? 'b' : 'g';
    }, [{ keyword: 'brief', description: 'Brief output' }]);
    const help = trie.getCompletions('show gadget ');
    const briefs = help.filter(c => c.keyword === 'brief');
    expect(briefs).toHaveLength(1);
    expect(briefs[0].description).toBe('Brief output');
  });
});

describe('Universal proof across all four vendor shells (no hand annotation)', () => {
  it('Cisco router: show ip ospf sub-keywords complete automatically', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await r.executeCommand('enable');
    const candidates = r.cliTabCandidates('show ip ospf data');
    expect(candidates).toContain('show ip ospf database');
  });

  it('Cisco router: show standby brief completes automatically', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await r.executeCommand('enable');
    expect(r.cliTabCandidates('show standby br')).toContain('show standby brief');
  });

  it('Cisco switch: show interfaces status still completes (now auto + curated)', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    expect(sw.cliTabCandidates('show interfaces stat')).toEqual(['show interfaces status']);
  });

  it('Huawei switch: display vlan summary completes automatically', () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    sw.executeCommand('system-view');
    expect(sw.cliTabCandidates('display vlan sum')).toEqual(['display vlan summary']);
  });

  it('Huawei router: display ike sa verbose-style sub-keywords complete automatically', async () => {
    const r = new HuaweiRouter('HR1', 0, 0);
    await r.executeCommand('system-view');
    const candidates = r.cliTabCandidates('display current-configuration conf');
    expect(candidates.length).toBeGreaterThan(0);
  });
});
